// config.js — Supabase 连接配置。
// ⚠️ 这两个值会随网页公开（设计如此，浏览器必须知道它们）。安全性由数据库的
//    RLS 行级安全策略保证：读全员可见、增删只限本人，密钥泄露也无法越权。
//    绝不要把 Supabase 的 Secret key / service_role key 放进这里。
window.FOODLOG_CONFIG = {
  url: 'https://sdiozaasoynjfypphmgq.supabase.co',
  key: 'sb_publishable_B1IMfWK3rvjH7-IuuaHpfQ_WT9VXVqP',

  // 实时通道（WebSocket）不可用时，改为每隔多久轮询一次（毫秒）
  pollIntervalMs: 15000,

  // 昵称最大长度（数据库侧限制 40，这里取更严的 20，界面更整齐）
  nicknameMax: 20
};
