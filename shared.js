// shared.js — 主页与往日页共用的逻辑（数据缓存/时间/单位/校验/列表渲染）。
// 经典 script（非 ES 模块）：file:// 下 ES 模块会因 CORS 直接失败。
// 对外只暴露一个命名空间 window.FoodLog。
//
// 数据来源已从 localStorage 换成 Supabase（读写都在 cloud.js）：
//   - FoodLog.store 只是**内存缓存**，由 applyServerData / upsertRecord 等维护；
//   - 页面渲染一律写 FoodLog.store.…，不要缓存成页面局部变量（数组会被整体替换）；
//   - 7 天过期清理已改由服务器定时任务执行（见 supabase/schema.sql），前端不再删数据。
(function () {
  'use strict';

  var FoodLog = {};
  window.FoodLog = FoodLog;

  /* ================= 常量 ================= */
  var NAME_MAX = 100;
  var AMOUNT_MIN = 1;            // 重量（克）/ 容量（毫升）范围
  var AMOUNT_MAX = 5000;
  var DEFAULT_AMOUNT = 100;
  var KCAL100_MAX = 2000;        // 每 100 克/毫升热量的合理上限（内置库最大 900）
  var RETENTION_DAYS = 7;        // 含今天共保留的天数；更早的记录在加载时清理
  var UNIT_SUFFIX = { g: '克', ml: '毫升' };
  var UNIT_NOUN = { g: '重量', ml: '容量' };
  var MEALS = [
    { value: 'breakfast', label: '早餐' },
    { value: 'lunch',     label: '午餐' },
    { value: 'dinner',    label: '晚餐' },
    { value: 'snack',     label: '加餐' }
  ];
  var MEAL_LABELS = {};
  var MEAL_INDEX = {};
  MEALS.forEach(function (m, i) { MEAL_LABELS[m.value] = m.label; MEAL_INDEX[m.value] = i; });
  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function unitOf(u) { return u === 'ml' ? 'ml' : 'g'; }
  function unitText(u) { return UNIT_SUFFIX[unitOf(u)]; }
  function unitNoun(u) { return UNIT_NOUN[unitOf(u)]; }

  /* ================= 时间（本地时区；绝不使用 toISOString） ================= */
  function pad2(n) { return String(n).padStart(2, '0'); }

  function todayLocalISO(d) {                    // → "2026-10-09"
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function nowLocalISO(d) {                      // → "2026-10-09T14:23:11.482+08:00"
    d = d || new Date();
    var off = -d.getTimezoneOffset();            // 东八区 getTimezoneOffset() 返回 -480，故取负
    var sign = off >= 0 ? '+' : '-';
    var abs = Math.abs(off);
    return todayLocalISO(d) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
      '.' + String(d.getMilliseconds()).padStart(3, '0') +
      sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
  }

  // 今天往前/后平移 n 天（Date 运算，不用毫秒算术——夏令时会让边界差一天）
  function shiftLocalISO(n) {
    var d = new Date();
    d.setDate(d.getDate() + n);
    return todayLocalISO(d);
  }

  function shortDate(dateStr) {                  // "2026-10-07" → "10-07"
    return dateStr.slice(5);
  }

  function isDateStr(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var p = s.split('-').map(Number);
    var dt = new Date(p[0], p[1] - 1, p[2]);     // 多参数构造 = 本地时间
    return dt.getFullYear() === p[0] && dt.getMonth() === p[1] - 1 && dt.getDate() === p[2];
  }

  function dateLabel(dateStr) {                  // "2026-10-09 周五"
    var p = dateStr.split('-').map(Number);
    var dt = new Date(p[0], p[1] - 1, p[2]);
    return dateStr + ' ' + WEEKDAYS[dt.getDay()];
  }

  function relativeLabel(dateStr) {              // "今天" / "昨天" / ""
    if (dateStr === todayLocalISO()) return '今天';
    var y = new Date();
    y.setDate(y.getDate() - 1);
    return dateStr === todayLocalISO(y) ? '昨天' : '';
  }

  /* ================= 内存缓存（真数据在 Supabase，全部由 cloud.js 写入） ================= */
  function emptyStore() { return { records: [], customFoods: [] }; }

  var store = emptyStore();
  Object.defineProperty(FoodLog, 'store', {
    get: function () { return store; },
    set: function (s) { store = s; }
  });

  // 整批替换：cloud.js 每次拉取成功后调用
  function applyServerData(entries, foods) {
    store.records = entries;
    store.customFoods = foods;
  }

  // 单条插入/替换（自己写完不用整拉一遍）
  function upsertRecord(rec) {
    for (var i = 0; i < store.records.length; i++) {
      if (store.records[i].id === rec.id) { store.records[i] = rec; return; }
    }
    store.records.push(rec);
  }

  function removeRecord(id) {
    store.records = store.records.filter(function (r) { return r.id !== id; });
  }

  function upsertFood(food) {
    for (var i = 0; i < store.customFoods.length; i++) {
      if (store.customFoods[i].id === food.id) { store.customFoods[i] = food; return; }
    }
    store.customFoods.push(food);
  }

  function removeFood(id) {
    store.customFoods = store.customFoods.filter(function (f) { return f.id !== id; });
  }

  // 是不是自己添加的——决定删除按钮是否出现（数据库侧同样有 RLS 把关）
  function isMine(x) {
    var C = window.Cloud;
    return !!(C && C.userId() && x && x.authorId === C.userId());
  }

  // 记录里「数量/单位/每100热量」三件套：旧记录没有这三个字段（合法），
  // 有就必须三件齐全且合法，避免出现算不出热量的半截记录。
  function hasAmountTriple(e) {
    return e.amount !== undefined || e.unit !== undefined || e.kcal100 !== undefined;
  }
  function isValidTriple(e) {
    return typeof e.amount === 'number' && Number.isFinite(e.amount) && e.amount > 0 &&
      (e.unit === 'g' || e.unit === 'ml') &&
      typeof e.kcal100 === 'number' && Number.isFinite(e.kcal100) && e.kcal100 > 0;
  }

  function isValidEntry(e) {
    return !!e && typeof e === 'object' &&
      Number.isInteger(e.id) && e.id > 0 &&
      isDateStr(e.date) &&
      typeof e.meal === 'string' && e.meal !== '' &&
      typeof e.name === 'string' && e.name.trim() !== '' &&
      typeof e.calories === 'number' && Number.isFinite(e.calories) && e.calories > 0 &&
      (!hasAmountTriple(e) || isValidTriple(e));
  }

  function normalizeEntry(e) {
    var out = {
      id: e.id,
      date: e.date,
      meal: e.meal,
      name: e.name.trim().slice(0, NAME_MAX),
      calories: Math.round(e.calories),
      authorId: typeof e.authorId === 'string' ? e.authorId : '',
      authorName: typeof e.authorName === 'string' ? e.authorName : '',
      createdAt: typeof e.createdAt === 'string' ? e.createdAt : '',
      updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : ''
    };
    if (isValidTriple(e)) {                    // 条件附着：不写出 undefined 字段，保持 JSON 诚实
      out.amount = Math.round(e.amount);
      out.unit = unitOf(e.unit);
      out.kcal100 = Math.round(e.kcal100);
    }
    return out;
  }

  // 自建食物：unit 不参与合法性判定（非法/缺失一律归为 'g'，不整条丢弃）
  function isValidCustomFood(c) {
    return !!c && typeof c === 'object' &&
      Number.isInteger(c.id) && c.id > 0 &&
      typeof c.name === 'string' && c.name.trim() !== '' &&
      typeof c.kcal100 === 'number' && Number.isFinite(c.kcal100) && c.kcal100 > 0;
  }

  function normalizeCustomFood(c) {
    return {
      id: c.id,
      name: c.name.trim().slice(0, NAME_MAX),
      // 服务器生成的同名键（去空白+小写），「同名即同一条」的判断以它为准
      nameKey: typeof c.nameKey === 'string' ? c.nameKey : c.name.trim().toLowerCase(),
      kcal100: Math.max(1, Math.round(c.kcal100)),
      unit: unitOf(c.unit),
      authorId: typeof c.authorId === 'string' ? c.authorId : '',
      authorName: typeof c.authorName === 'string' ? c.authorName : '',
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : ''
    };
  }

  // 旧版本这里还有 loadStore / saveStore / persist / purgeOldRecords（localStorage 时代）——
  // 读写已全部搬到 cloud.js，7 天清理改由服务器 pg_cron 任务做，前端不再有落盘与回滚逻辑。

  /* ================= 展示 ================= */
  function fmtKcal(n) { return n.toLocaleString('zh-CN'); }

  var toastEl = null;
  var toastTimer = null;
  function showToast(text, isError) {
    if (!toastEl) toastEl = document.getElementById('toast');   // 惰性查找：页面上没有 toast 时静默降级
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.toggle('toast-error', !!isError);
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
    }, 2400);
  }

  function createEntryRow(entry, opts) {
    opts = opts || {};
    var row = document.createElement('div');
    row.className = 'entry-row' + (opts.flash ? ' flash' : '');
    row.dataset.id = String(entry.id);

    var tag = document.createElement('span');
    tag.className = 'meal-tag';
    tag.textContent = MEAL_LABELS.hasOwnProperty(entry.meal) ? MEAL_LABELS[entry.meal] : entry.meal;

    var name = document.createElement('span');
    name.className = 'entry-name';
    name.textContent = entry.name;
    name.title = entry.name;

    // 作者昵称：谁添加的一眼可见
    var author = null;
    if (entry.authorName) {
      author = document.createElement('span');
      author.className = 'entry-author';
      author.textContent = entry.authorName;
      author.title = '由 ' + entry.authorName + ' 添加';
    }

    var amountSpan = null;
    if (entry.amount) {                              // 旧记录没有量/单位，不显示这一段
      amountSpan = document.createElement('span');
      amountSpan.className = 'entry-amount';
      amountSpan.textContent = fmtKcal(entry.amount) + unitText(entry.unit);
    }

    var cal = document.createElement('span');
    cal.className = 'entry-cal';
    cal.append(fmtKcal(entry.calories) + ' ');
    var unit = document.createElement('span');
    unit.className = 'cal-unit';
    unit.textContent = '千卡';
    cal.appendChild(unit);

    // 只有自己添加的记录才给删除按钮（数据库侧 RLS 另有强制约束）
    var del = null;
    if (isMine(entry)) {
      del = document.createElement('button');
      del.type = 'button';
      del.className = 'delete-btn';
      del.setAttribute('aria-label', '删除 ' + entry.name);
      del.textContent = '✕';
      del.addEventListener('click', function () {
        if (opts.onDelete) opts.onDelete(entry.id);
      });
    }

    row.appendChild(tag);
    row.appendChild(name);
    if (author) row.appendChild(author);
    if (amountSpan) row.appendChild(amountSpan);
    row.appendChild(cal);
    if (del) row.appendChild(del);
    return row;
  }

  // 删除自己添加的记录：本地先校验身份（按钮本来也不显示），服务器侧 RLS 会再验一次
  function deleteRecord(id, rerender) {
    var removed = null;
    for (var i = 0; i < store.records.length; i++) {
      if (store.records[i].id === id) { removed = store.records[i]; break; }
    }
    if (!removed) return;
    if (!isMine(removed)) { showToast('只能删除自己添加的记录', true); return; }

    window.Cloud.deleteEntry(id).then(function (res) {
      if (!res.ok) {
        showToast('删除失败：' + res.error, true);
        if (rerender) rerender(false);
        return;
      }
      if (rerender) rerender(true);              // 本地缓存已移除，重渲染即可
      showToast('已删除：' + removed.name + ' ' + fmtKcal(removed.calories) + ' 千卡');
    });
  }

  // 纯分组：日期倒序 → 餐次顺序 → 录入顺序
  function groupByDateDesc(records) {
    var groups = {};
    records.forEach(function (r) {
      (groups[r.date] = groups[r.date] || []).push(r);
    });
    return Object.keys(groups)
      .sort(function (a, b) { return b.localeCompare(a); })
      .map(function (date) {
        var items = groups[date].slice().sort(function (a, b) {
          var ma = MEAL_INDEX.hasOwnProperty(a.meal) ? MEAL_INDEX[a.meal] : 99;
          var mb = MEAL_INDEX.hasOwnProperty(b.meal) ? MEAL_INDEX[b.meal] : 99;
          return ma - mb || a.id - b.id;
        });
        return { date: date, items: items };
      });
  }

  // 渲染分组列表。records 必须是**已过滤**的数组——空态判断基于它，
  // 传过滤回调会让「空是因为筛掉了还是本来就没有」含混不清。
  function renderDayGroups(container, records, opts) {
    opts = opts || {};
    container.textContent = '';

    if (!records.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = opts.emptyText || '还没有记录';
      container.appendChild(empty);
      return;
    }

    groupByDateDesc(records).forEach(function (group) {
      var g = document.createElement('section');
      g.className = 'day-group';

      var header = document.createElement('div');
      header.className = 'day-header';
      var label = document.createElement('span');
      label.className = 'day-label';
      var rel = relativeLabel(group.date);
      label.textContent = dateLabel(group.date) + (rel ? ' · ' + rel : '');
      if (opts.markFuture && group.date > todayLocalISO()) {
        var futureTag = document.createElement('span');
        futureTag.className = 'day-future';
        futureTag.textContent = '未到日期';
        label.appendChild(futureTag);
      }
      var total = group.items.reduce(function (s, r) { return s + r.calories; }, 0);
      var totalEl = document.createElement('span');
      totalEl.className = 'day-total';
      totalEl.textContent = '共 ' + fmtKcal(total) + ' 千卡 · ' + group.items.length + ' 条';
      header.appendChild(label);
      header.appendChild(totalEl);
      g.appendChild(header);

      group.items.forEach(function (entry) {
        g.appendChild(createEntryRow(entry, {
          flash: entry.id === opts.highlightId,
          onDelete: opts.onDelete
        }));
      });
      container.appendChild(g);
    });
  }

  /* ================= 导出 ================= */
  // store 已通过访问器属性挂上（见上），其余为不可变的函数/常量，页面可以安全取别名。
  Object.assign(FoodLog, {
    NAME_MAX: NAME_MAX,
    AMOUNT_MIN: AMOUNT_MIN,
    AMOUNT_MAX: AMOUNT_MAX,
    DEFAULT_AMOUNT: DEFAULT_AMOUNT,
    KCAL100_MAX: KCAL100_MAX,
    RETENTION_DAYS: RETENTION_DAYS,
    UNIT_SUFFIX: UNIT_SUFFIX,
    UNIT_NOUN: UNIT_NOUN,
    MEALS: MEALS,
    MEAL_LABELS: MEAL_LABELS,
    MEAL_INDEX: MEAL_INDEX,
    unitOf: unitOf,
    unitText: unitText,
    unitNoun: unitNoun,
    pad2: pad2,
    todayLocalISO: todayLocalISO,
    nowLocalISO: nowLocalISO,
    shiftLocalISO: shiftLocalISO,
    shortDate: shortDate,
    isDateStr: isDateStr,
    dateLabel: dateLabel,
    relativeLabel: relativeLabel,
    emptyStore: emptyStore,
    isValidEntry: isValidEntry,
    normalizeEntry: normalizeEntry,
    isValidCustomFood: isValidCustomFood,
    normalizeCustomFood: normalizeCustomFood,
    applyServerData: applyServerData,
    upsertRecord: upsertRecord,
    removeRecord: removeRecord,
    upsertFood: upsertFood,
    removeFood: removeFood,
    isMine: isMine,
    fmtKcal: fmtKcal,
    showToast: showToast,
    createEntryRow: createEntryRow,
    deleteRecord: deleteRecord,
    groupByDateDesc: groupByDateDesc,
    renderDayGroups: renderDayGroups
  });
})();
