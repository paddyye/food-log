// cloud.js — Supabase 数据层：匿名登录（带昵称）/ 读写记录与自建食物 / 实时订阅。
//
// 同步策略（实测：墙内浏览器能走 QUIC 直连 HTTPS，但 WebSocket 走 TCP 常被 SNI 阻断）：
//   轮询**始终在跑**（只拉 id 列表做对比，变了才整体重拉，代价极小）；
//   Realtime 订阅成功只是额外加速到秒级——绝不停掉轮询。
//   原因：实测出现过「订阅回调报 SUBSCRIBED、事件却永远不到」的假成功
//   （WebSocket 握手通过、连接随即被静默掐断），只信轮询才可靠。
//
// 依赖：shared.js（FoodLog 工具）、config.js（FOODLOG_CONFIG）、页面里的 supabase-js。
(function () {
  'use strict';

  var FoodLog = window.FoodLog;
  var cfg = window.FOODLOG_CONFIG || {};

  var NICK_KEY = 'foodLog.nickname';
  var RT_RETRY_MS = 60000;      // 实时订阅失败后多久重试一次
  var RT_MAX_ATTEMPTS = 2;      // 一个页面会话最多尝试几次，别无限重连
  var REALTIME_DEBOUNCE_MS = 200;

  var supa = null;
  var me = { id: '', nickname: '' };
  var hooks = {};
  var mode = 'connecting';      // connecting | realtime | polling

  var channel = null;
  var rtAttempts = 0;
  var rtTimer = null;

  var pollTimer = null;
  var pollSig = null;           // 上一次对账时的 id 签名；null = 未知，下次必拉

  var refreshing = false;
  var refreshAgain = false;

  var retryTimer = null;        // 首次连接失败后的退避重试
  var retryCount = 0;
  var watching = false;         // 轮询/订阅只启动一次

  var modalEl = null;
  var nickResolver = null;

  var Cloud = {};

  /* ================= 小工具 ================= */
  function errText(e) {
    if (!e) return '未知错误';
    if (typeof e === 'string') return e;
    return e.message || e.error_description || e.details || '未知错误';
  }

  function cutoffDate() { return FoodLog.shiftLocalISO(-(FoodLog.RETENTION_DAYS - 1)); }

  function readNick() { try { return localStorage.getItem(NICK_KEY) || ''; } catch (e) { return ''; } }
  function saveNick(n) { try { localStorage.setItem(NICK_KEY, n); } catch (e) { /* 忽略 */ } }

  function setMode(m) {
    if (mode === m) return;
    mode = m;
    if (hooks.onStatus) hooks.onStatus(m);
  }

  /* ================= 服务器行 → 客户端对象 ================= */
  function mapEntry(r) {
    var e = {
      id: r.id,
      date: r.entry_date,
      meal: r.meal,
      name: r.name,
      calories: r.calories,
      authorId: r.author_id || '',
      authorName: r.author_name || '',
      createdAt: r.created_at || '',
      updatedAt: r.created_at || ''
    };
    if (r.amount !== null && r.amount !== undefined) {
      e.amount = r.amount;
      e.unit = r.unit;
      e.kcal100 = r.kcal100;
    }
    return e;
  }

  function mapFood(r) {
    return {
      id: r.id,
      name: r.name,
      nameKey: r.name_key || '',
      kcal100: r.kcal100,
      unit: r.unit,
      authorId: r.author_id || '',
      authorName: r.author_name || '',
      createdAt: r.created_at || ''
    };
  }

  function sigOf(entryRows, foodRows) {
    return entryRows.map(function (r) { return r.id; }).join(',') + '|' +
           foodRows.map(function (r) { return r.id; }).join(',');
  }

  /* ================= 拉取 ================= */
  function fetchAll() {
    return Promise.all([
      supa.from('entries').select('*').gte('entry_date', cutoffDate()).order('id', { ascending: true }),
      supa.from('custom_foods').select('*').order('id', { ascending: true })
    ]).then(function (res) {
      if (res[0].error) throw res[0].error;
      if (res[1].error) throw res[1].error;
      FoodLog.applyServerData(res[0].data.map(mapEntry), res[1].data.map(mapFood));
      pollSig = sigOf(res[0].data, res[1].data);
    });
  }

  // 重拉并通知页面重渲染；并发调用会合并成一次（最多再补一次）
  function refresh() {
    if (refreshing) { refreshAgain = true; return Promise.resolve(); }
    refreshing = true;
    return fetchAll().then(function () {
      refreshing = false;
      if (hooks.onUpdate) hooks.onUpdate();
      if (refreshAgain) { refreshAgain = false; return refresh(); }
    }, function () {
      refreshing = false;      // 失败：保持现状，下一次轮询/事件会再试
    });
  }

  /* ================= 轮询兜底 ================= */
  // 轮询是唯一的可靠通道：实时订阅只是加速器，任何时候都不停轮询
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollTick, cfg.pollIntervalMs || 15000);
  }

  // 只拉 id 列表（几百字节）做对账：变了才整体重拉
  function pollTick() {
    if (document.hidden) return;
    Promise.all([
      supa.from('entries').select('id').gte('entry_date', cutoffDate()).order('id', { ascending: true }),
      supa.from('custom_foods').select('id').order('id', { ascending: true })
    ]).then(function (res) {
      if (res[0].error || res[1].error) return;
      if (pollSig === null || sigOf(res[0].data, res[1].data) !== pollSig) return refresh();
    }, function () { /* 网络抖动：下个周期再试 */ });
  }

  /* ================= 实时订阅 ================= */
  function onRealtime() {
    clearTimeout(rtTimer);
    rtTimer = setTimeout(function () { refresh(); }, REALTIME_DEBOUNCE_MS);
  }

  function startRealtime() {
    if (rtAttempts >= RT_MAX_ATTEMPTS) return;
    rtAttempts++;
    channel = supa.channel('foodlog')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'entries' }, onRealtime)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'custom_foods' }, onRealtime)
      .subscribe(function (st) {
        if (st === 'SUBSCRIBED') {
          rtAttempts = 0;
          setMode('realtime');     // 只是标记「有加速通道」；轮询继续兜底，防止假成功
          return;
        }
        if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') {
          setMode('polling');
          if (rtAttempts < RT_MAX_ATTEMPTS) {
            setTimeout(function () { if (mode !== 'realtime') startRealtime(); }, RT_RETRY_MS);
          }
        }
      });
  }

  function startWatching() {
    if (watching) return;      // 连接重试成功时不要重复挂监听
    watching = true;
    startPolling();        // 先兜底；订阅成功会把它停掉
    startRealtime();
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refresh();     // 回到前台立刻补一次（手机锁屏期间轮询是暂停的）
    });
  }

  /* ================= 昵称弹窗 ================= */
  function ensureModal() {
    if (modalEl) return modalEl;

    modalEl = document.createElement('div');
    modalEl.className = 'nick-mask';
    modalEl.hidden = true;

    var card = document.createElement('div');
    card.className = 'nick-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    var title = document.createElement('h2');
    title.className = 'nick-title';
    title.id = 'nickTitle';

    var hint = document.createElement('p');
    hint.className = 'nick-hint';
    hint.textContent = '记录会显示是谁添加的，家人一眼认出你。以后随时能改。';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'nick-input';
    input.id = 'nickInput';
    input.autocomplete = 'nickname';
    input.maxLength = cfg.nicknameMax || 20;
    input.placeholder = '比如：小明';
    input.setAttribute('aria-labelledby', 'nickTitle');

    var err = document.createElement('p');
    err.className = 'nick-error';
    err.id = 'nickError';
    err.setAttribute('role', 'alert');
    err.hidden = true;

    var actions = document.createElement('div');
    actions.className = 'nick-actions';

    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'nick-btn';
    cancel.id = 'nickCancel';
    cancel.textContent = '取消';

    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'nick-btn nick-btn-primary';
    save.id = 'nickSave';

    actions.appendChild(cancel);
    actions.appendChild(save);
    card.appendChild(title);
    card.appendChild(hint);
    card.appendChild(input);
    card.appendChild(err);
    card.appendChild(actions);
    modalEl.appendChild(card);
    document.body.appendChild(modalEl);

    function finish(name) {
      modalEl.hidden = true;
      var r = nickResolver;
      nickResolver = null;
      if (r) r(name);
    }

    function trySave() {
      var n = input.value.trim().slice(0, cfg.nicknameMax || 20);
      if (!n) {
        err.textContent = '请填个昵称';
        err.hidden = false;
        input.focus();
        return;
      }
      finish(n);
    }

    save.addEventListener('click', trySave);
    cancel.addEventListener('click', function () { finish(null); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); trySave(); }
      else if (ev.key === 'Escape' && !cancel.hidden) { ev.preventDefault(); finish(null); }
    });
    input.addEventListener('input', function () { err.hidden = true; });

    return modalEl;
  }

  // required=true 时不给取消（首次进站必须起名）；返回 Promise<名字 或 null>
  function promptNickname(initial, required) {
    var el = ensureModal();
    el.querySelector('.nick-title').textContent = required ? '起个昵称' : '改个昵称';
    el.querySelector('#nickSave').textContent = required ? '开始记录' : '保存';
    var cancelBtn = el.querySelector('#nickCancel');
    cancelBtn.hidden = !!required;
    var input = el.querySelector('#nickInput');
    input.value = initial || '';
    el.querySelector('#nickError').hidden = true;
    el.hidden = false;
    setTimeout(function () { input.focus(); input.select(); }, 30);
    return new Promise(function (resolve) { nickResolver = resolve; });
  }

  /* ================= 登录 ================= */
  function signInAnonymously(nickname) {
    return supa.auth.signInAnonymously({ options: { data: { nickname: nickname } } })
      .then(function (res) {
        if (res.error) throw res.error;
        return res.data.user;
      });
  }

  // 头像按钮：显示「✎ 昵称」，点击可改名
  function wireWhoami() {
    var btn = document.getElementById('whoami');
    if (!btn) return;
    btn.hidden = false;
    btn.textContent = '✎ ' + me.nickname;
    btn.title = '点击修改昵称';
    btn.setAttribute('aria-label', '当前昵称 ' + me.nickname + '，点击修改');
    btn.addEventListener('click', function () {
      promptNickname(me.nickname, false).then(function (name) {
        if (!name || name === me.nickname) return;
        Cloud.changeNickname(name);
      });
    });
  }

  Cloud.changeNickname = function (name) {
    return supa.auth.updateUser({ data: { nickname: name } }).then(function (res) {
      if (res.error) {
        FoodLog.showToast('改名失败：' + errText(res.error), true);
        return { ok: false, error: errText(res.error) };
      }
      me.nickname = name;
      saveNick(name);
      var btn = document.getElementById('whoami');
      if (btn) {
        btn.textContent = '✎ ' + name;
        btn.setAttribute('aria-label', '当前昵称 ' + name + '，点击修改');
      }
      FoodLog.showToast('昵称已改为「' + name + '」（已记的记录保留添加时的名字）');
      return { ok: true };
    });
  };

  /* ================= 启动 ================= */
  // 登录 + 首屏拉取（可重复调用；失败由 scheduleRetry 兜底）
  function connectOnce() {
    return supa.auth.getSession().then(function (res) {
      var session = res.data && res.data.session;
      if (session && session.user) return session.user;
      var saved = readNick();
      if (saved) return signInAnonymously(saved);
      return promptNickname('', true).then(function (n) {
        saveNick(n);
        return signInAnonymously(n);
      });
    }).then(function (user) {
      me.id = user.id;
      me.nickname = (user.user_metadata && user.user_metadata.nickname) || readNick() || '匿名';
      return fetchAll();
    });
  }

  // 首次连接失败会自动重试：进站那一刻网络抖动很常见，
  // 不重试的话页面会停在「没身份」的状态，写记录只会报数据库权限错误。
  function scheduleRetry() {
    if (retryTimer || retryCount >= 5) return;
    retryCount++;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      connectOnce().then(function () {
        retryCount = 0;
        wireWhoami();
        startWatching();
        if (hooks.onReady) hooks.onReady();
        FoodLog.showToast('已连上服务器');
      }, function () {
        scheduleRetry();       // 退避再试
      });
    }, 4000 * retryCount);
  }

  Cloud.connect = function (options) {
    hooks = options || {};

    if (!cfg.url || !cfg.key) {
      FoodLog.showToast('缺少 config.js 配置', true);
      if (hooks.onReady) hooks.onReady();
      return Promise.resolve(false);
    }
    if (!window.supabase || !window.supabase.createClient) {
      FoodLog.showToast('数据组件没加载出来（检查网络后刷新页面）', true);
      if (hooks.onReady) hooks.onReady();
      return Promise.resolve(false);
    }

    if (!supa) supa = window.supabase.createClient(cfg.url, cfg.key);

    return connectOnce().then(function () {
      retryCount = 0;
      wireWhoami();
      startWatching();
      if (hooks.onReady) hooks.onReady();
      return true;
    }, function (e) {
      // 失败也先把界面放出来（数据侧靠轮询在恢复后自动补），并安排自动重试
      setMode('polling');
      FoodLog.showToast('连不上服务器：' + errText(e), true);
      wireWhoami();
      startWatching();
      if (hooks.onReady) hooks.onReady();
      scheduleRetry();
      return false;
    });
  };

  /* ================= 记录：增 / 删 ================= */
  // 还没登录成功时给一句人话，而不是让数据库丢回 RLS 错误
  function notConnected() { return { ok: false, error: '还没连上服务器，请稍等几秒再试' }; }

  Cloud.addEntry = function (entry) {
    if (!me.id) return Promise.resolve(notConnected());
    var row = {
      entry_date: entry.date,
      meal: entry.meal,
      name: entry.name,
      calories: entry.calories,
      amount: typeof entry.amount === 'number' ? entry.amount : null,
      unit: entry.unit || null,
      kcal100: typeof entry.kcal100 === 'number' ? entry.kcal100 : null,
      author_name: me.nickname
    };
    return supa.from('entries').insert(row).select().single().then(function (res) {
      if (res.error) return { ok: false, error: errText(res.error) };
      var mapped = mapEntry(res.data);
      FoodLog.upsertRecord(mapped);
      pollSig = null;                      // 让下一轮对账重新拉一次
      return { ok: true, row: mapped };
    }, function (e) { return { ok: false, error: errText(e) }; });
  };

  Cloud.deleteEntry = function (id) {
    if (!me.id) return Promise.resolve(notConnected());
    return supa.from('entries').delete().eq('id', id).select().then(function (res) {
      if (res.error) return { ok: false, error: errText(res.error) };
      if (!res.data.length) return { ok: false, error: '记录不存在或不是自己添加的' };
      FoodLog.removeRecord(id);
      pollSig = null;
      return { ok: true, row: mapEntry(res.data[0]) };
    }, function (e) { return { ok: false, error: errText(e) }; });
  };

  /* ================= 自建食物：增 / 改 / 删 ================= */
  Cloud.saveCustomFood = function (food) {
    if (!me.id) return Promise.resolve(notConnected());
    if (food.id) {
      return supa.from('custom_foods')
        .update({ name: food.name, kcal100: food.kcal100, unit: food.unit })
        .eq('id', food.id).select().single().then(function (res) {
          if (res.error) return { ok: false, error: errText(res.error), code: res.error.code };
          var mapped = mapFood(res.data);
          FoodLog.upsertFood(mapped);
          pollSig = null;
          return { ok: true, food: mapped, updated: true };
        }, function (e) { return { ok: false, error: errText(e) }; });
    }
    return supa.from('custom_foods')
      .insert({ name: food.name, kcal100: food.kcal100, unit: food.unit, author_name: me.nickname })
      .select().single().then(function (res) {
        if (res.error) return { ok: false, error: errText(res.error), code: res.error.code };
        var mapped = mapFood(res.data);
        FoodLog.upsertFood(mapped);
        pollSig = null;
        return { ok: true, food: mapped };
      }, function (e) { return { ok: false, error: errText(e) }; });
  };

  Cloud.deleteCustomFood = function (id) {
    if (!me.id) return Promise.resolve(notConnected());
    return supa.from('custom_foods').delete().eq('id', id).select().then(function (res) {
      if (res.error) return { ok: false, error: errText(res.error) };
      if (!res.data.length) return { ok: false, error: '食物不存在或不是自己添加的' };
      FoodLog.removeFood(id);
      pollSig = null;
      return { ok: true, food: mapFood(res.data[0]) };
    }, function (e) { return { ok: false, error: errText(e) }; });
  };

  /* ================= 对外只读信息 ================= */
  Cloud.userId = function () { return me.id; };
  Cloud.nickname = function () { return me.nickname; };
  Cloud.mode = function () { return mode; };
  Cloud.refresh = refresh;

  window.Cloud = Cloud;
})();
