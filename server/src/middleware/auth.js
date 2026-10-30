'use strict';
const db = require('../db/connection');
const config = require('../config');
const { newToken, hashPassword, verifyPassword } = require('../utils/crypto');
const { ROLE_MATRIX } = require('./permissions');
const audit = require('../services/audit');

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function nowPlus(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}

/** 创建会话，写 httpOnly Cookie */
function createSession(res, userId, req) {
  const token = newToken();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, ip) VALUES (?,?,?,?)')
    .run(token, userId, nowPlus(config.sessionTtlMs), clientIp(req));
  res.setHeader('Set-Cookie',
    `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`);
  return token;
}

function destroySession(req, res) {
  const token = parseCookies(req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

/** 登录：含失败锁定。返回 { ok, user?, error? } */
function login(req, res, username, password) {
  const failRow = db.prepare('SELECT * FROM login_fails WHERE username = ?').get(username);
  if (failRow && failRow.locked_until && new Date(failRow.locked_until) > new Date()) {
    return { ok: false, error: `失败次数过多，账户已锁定至 ${failRow.locked_until}` };
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  // 即使用户不存在也做一次校验，避免时间侧信道泄露用户名
  const hash = user ? user.password_hash : hashPassword('dummy-password-for-timing');
  const passOk = verifyPassword(password, user ? user.password_hash : hash);

  if (!user || !passOk) {
    const fails = (failRow?.fails || 0) + 1;
    const lockedUntil = fails >= config.loginMaxFails ? nowPlus(config.loginLockMs) : null;
    db.prepare(`INSERT INTO login_fails (username, fails, locked_until) VALUES (?,?,?)
                ON CONFLICT(username) DO UPDATE SET fails = ?, locked_until = ?`)
      .run(username, fails, lockedUntil, fails, lockedUntil);
    audit.audit({ actorName: username, action: 'login_failed', detail: `第 ${fails} 次失败` });
    return { ok: false, error: lockedUntil ? `失败次数过多，账户已锁定 10 分钟` : '用户名或密码错误' };
  }

  db.prepare('DELETE FROM login_fails WHERE username = ?').run(username);
  createSession(res, user.id, req);
  audit.audit({ actorId: user.id, actorName: user.display_name, action: 'login', objectType: 'session', detail: `IP ${clientIp(req)}` });
  return { ok: true, user };
}

/** 认证中间件：解析会话 → req.user，附带权限列表 */
function requireAuth(req, res, next) {
  const token = parseCookies(req).sid;
  if (!token) return res.status(401).json({ error: '未登录' });

  const sess = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!sess || new Date(sess.expires_at) < new Date()) {
    if (sess) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return res.status(401).json({ error: '会话已过期，请重新登录' });
  }

  const user = db.prepare('SELECT id, username, display_name, role, phone, active FROM users WHERE id = ? AND active = 1').get(sess.user_id);
  if (!user) return res.status(401).json({ error: '账户不存在或已停用' });

  req.user = user;
  req.perms = new Set(ROLE_MATRIX[user.role] || []);
  // 代理审批人：在授权时间段内获得确认权限
  if (!req.perms.has('suggest:confirm') && !req.perms.has('suggest:confirm:limited')) {
    const dlg = db.prepare(
      `SELECT d.* FROM delegates d WHERE d.delegate_id = ? AND d.start_at <= datetime('now','localtime') AND d.end_at >= datetime('now','localtime')`
    ).get(user.id);
    if (dlg) {
      req.perms.add('suggest:confirm');
      req.delegateFor = dlg.manager_id;
    }
  }
  next();
}

/** 授权中间件工厂：要求任一权限 */
function requirePerm(...perms) {
  return (req, res, next) => {
    if (!req.perms) return res.status(401).json({ error: '未登录' });
    if (perms.some(p => req.perms.has(p))) return next();
    return res.status(403).json({ error: `无权限（需要：${perms.join(' 或 ')}）` });
  };
}

/** 数据范围过滤：返回该用户可见的门店 id 列表（null = 全部） */
function visibleStoreIds(user) {
  const { scopeOf } = require('./permissions');
  if (scopeOf(user.role) === 'all') return null;
  const rows = db.prepare('SELECT store_id FROM user_stores WHERE user_id = ?').all(user.id);
  return rows.map(r => r.store_id);
}

function visibleChannels(user) {
  const { scopeOf } = require('./permissions');
  if (scopeOf(user.role) === 'all') return null;
  const rows = db.prepare('SELECT channel FROM user_channels WHERE user_id = ?').all(user.id);
  return rows.map(r => r.channel);
}

module.exports = { login, logout: destroySession, requireAuth, requirePerm, visibleStoreIds, visibleChannels, parseCookies };
