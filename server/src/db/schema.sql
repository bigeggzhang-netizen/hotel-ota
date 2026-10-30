-- 酒店 OTA 盯盘系统数据库 Schema
-- 对应需求文档：第2节（角色权限）、第5节（确认流程）、第6节（告警）、第8节（审计）

-- ========== 账户与权限 ==========

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,             -- 登录名
  password_hash TEXT NOT NULL,                   -- scrypt 散列（含盐）
  display_name  TEXT NOT NULL,                   -- 姓名
  role          TEXT NOT NULL CHECK (role IN ('manager','revenue','frontdesk','service','viewer')),
  phone         TEXT,                            -- 手机号（通知用）
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT
);

-- 登录会话（服务端可吊销）
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 登录失败锁定
CREATE TABLE IF NOT EXISTS login_fails (
  username     TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

-- 门店（多门店扩展预留）
CREATE TABLE IF NOT EXISTS stores (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

-- 按门店授权（空 = 该角色默认范围，见 permissions.js）
CREATE TABLE IF NOT EXISTS user_stores (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, store_id)
);

-- 按渠道授权
CREATE TABLE IF NOT EXISTS user_channels (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  PRIMARY KEY (user_id, channel)
);

-- 代理审批人：管理者在休假/夜间把确认权临时交给指定人员
CREATE TABLE IF NOT EXISTS delegates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  manager_id  INTEGER NOT NULL REFERENCES users(id),
  delegate_id INTEGER NOT NULL REFERENCES users(id),
  start_at    TEXT NOT NULL,
  end_at      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ========== 业务数据 ==========

CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  level       TEXT NOT NULL CHECK (level IN ('critical','major','minor')),  -- 紧急/重要/提示
  type        TEXT NOT NULL,                  -- oversell/price/order/review/channel/room
  title       TEXT NOT NULL,
  detail      TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','handled','ignored')),
  dedupe_key  TEXT,                           -- 30分钟内同问题只通知一次
  store_id    INTEGER,
  channel     TEXT,
  handled_by  INTEGER REFERENCES users(id),
  handled_at  TEXT,
  handle_note TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status, level);
CREATE INDEX IF NOT EXISTS idx_alerts_dedupe ON alerts(dedupe_key, created_at);

-- 待确认建议（唯一允许触发写入的入口）
CREATE TABLE IF NOT EXISTS suggestions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  action        TEXT NOT NULL CHECK (action IN ('open_room','close_room','adjust_inventory','adjust_price','online','offline')),
  channel       TEXT,
  room_type     TEXT NOT NULL,
  biz_date      TEXT NOT NULL,                -- 业务日期
  before_value  TEXT,                         -- 调整前
  after_value   TEXT NOT NULL,                -- 调整后
  reason        TEXT NOT NULL,                -- 触发原因
  impact        TEXT,                         -- 预估影响
  urgency       TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('urgent','important','normal')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected','expired','rolled_back')),
  dedupe_key    TEXT,
  deadline      TEXT,                         -- 超时时间（按紧急程度）
  created_by    TEXT NOT NULL DEFAULT 'system',
  confirmed_by  INTEGER REFERENCES users(id),
  confirmed_at  TEXT,
  confirm_note  TEXT,
  executed_at   TEXT,
  execute_ok    INTEGER,
  execute_detail TEXT,
  snapshot      TEXT,                         -- JSON：执行前值快照，回滚用
  rolled_back_at TEXT,
  rolled_back_by INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status, urgency);
CREATE INDEX IF NOT EXISTS idx_suggestions_dedupe ON suggestions(dedupe_key);

-- 规则与阈值（修改留痕）
CREATE TABLE IF NOT EXISTS rules (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 审计日志：只增不改不删，保存≥1年（见需求文档第8节）
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER,
  actor_name  TEXT,
  action      TEXT NOT NULL,        -- login/confirm/reject/rollback/rule_update/user_change...
  object_type TEXT,
  object_id   TEXT,
  before_json TEXT,
  after_json  TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);
