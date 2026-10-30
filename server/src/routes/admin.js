'use strict';
// 账户与权限管理（仅 manager），含代理审批人设置
const express = require('express');
const db = require('../db/connection');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { ROLE_MATRIX, ROLE_NAMES } = require('../middleware/permissions');
const { hashPassword } = require('../utils/crypto');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth, requirePerm('user:manage'));

const VALID_ROLES = Object.keys(ROLE_MATRIX);

router.get('/users', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role, u.phone, u.active, u.created_at,
      (SELECT GROUP_CONCAT(store_id) FROM user_stores WHERE user_id = u.id) AS store_ids,
      (SELECT GROUP_CONCAT(channel) FROM user_channels WHERE user_id = u.id) AS channels
    FROM users u ORDER BY u.id`).all();
  res.json(users.map(u => ({ ...u, roleName: ROLE_NAMES[u.role] || u.role })));
});

router.post('/users', (req, res) => {
  const { username, password, displayName, role, phone, storeIds = [], channels = [] } = req.body || {};
  if (!username || !password || !displayName) return res.status(400).json({ error: '用户名、密码、姓名为必填' });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: '无效角色' });
  if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });

  try {
    const info = db.prepare('INSERT INTO users (username, password_hash, display_name, role, phone) VALUES (?,?,?,?,?)')
      .run(String(username).trim(), hashPassword(password), displayName, role, phone || null);
    const uid = Number(info.lastInsertRowid);
    const insStore = db.prepare('INSERT OR IGNORE INTO user_stores (user_id, store_id) VALUES (?,?)');
    for (const s of storeIds) insStore.run(uid, s);
    const insCh = db.prepare('INSERT OR IGNORE INTO user_channels (user_id, channel) VALUES (?,?)');
    for (const c of channels) insCh.run(uid, c);

    audit.audit({ actorId: req.user.id, actorName: req.user.display_name, action: 'user_create', objectType: 'user', objectId: uid, after: { username, role }, detail: `创建账户 ${username}（${ROLE_NAMES[role]}）` });
    res.status(201).json({ id: uid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: '用户名已存在' });
    throw e;
  }
});

router.put('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const { displayName, role, phone, active, storeIds, channels, password } = req.body || {};

  if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: '无效角色' });
  if (password && String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (u.id === req.user.id && active === 0) return res.status(400).json({ error: '不能停用自己的账户' });
  if (u.id === req.user.id && role && role !== 'manager') return res.status(400).json({ error: '不能降低自己的角色' });
  const removesManager = u.role === 'manager' && u.active === 1 && ((role && role !== 'manager') || active === 0);
  if (removesManager) {
    const activeManagers = db.prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'manager' AND active = 1`).get().count;
    if (activeManagers <= 1) return res.status(400).json({ error: '系统至少需要保留一名启用中的管理者' });
  }

  db.prepare(`UPDATE users SET display_name = ?, role = ?, phone = ?, active = ?, updated_at = datetime('now','localtime')
              WHERE id = ?`)
    .run(displayName ?? u.display_name, role ?? u.role, phone !== undefined ? phone : u.phone,
      active !== undefined ? (active ? 1 : 0) : u.active, u.id);

  if (Array.isArray(storeIds)) {
    db.prepare('DELETE FROM user_stores WHERE user_id = ?').run(u.id);
    const ins = db.prepare('INSERT OR IGNORE INTO user_stores (user_id, store_id) VALUES (?,?)');
    for (const s of storeIds) ins.run(u.id, s);
  }
  if (Array.isArray(channels)) {
    db.prepare('DELETE FROM user_channels WHERE user_id = ?').run(u.id);
    const ins = db.prepare('INSERT OR IGNORE INTO user_channels (user_id, channel) VALUES (?,?)');
    for (const c of channels) ins.run(u.id, c);
  }
  if (password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); // 重置密码后强制下线
  }

  audit.audit({
    actorId: req.user.id, actorName: req.user.display_name, action: 'user_update', objectType: 'user', objectId: u.id,
    before: { role: u.role, active: u.active }, after: { role: role ?? u.role, active: active ?? u.active },
    detail: `更新账户 ${u.username}${password ? '（含重置密码）' : ''}`,
  });
  res.json({ ok: true });
});

// ---------- 代理审批人 ----------
router.get('/delegates', (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, m.display_name AS manager_name, g.display_name AS delegate_name, g.role AS delegate_role
    FROM delegates d
    JOIN users m ON m.id = d.manager_id
    JOIN users g ON g.id = d.delegate_id
    ORDER BY d.id DESC`).all();
  res.json(rows);
});

router.post('/delegates', (req, res) => {
  const { delegateId, startAt, endAt } = req.body || {};
  const g = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(delegateId);
  if (!g) return res.status(404).json({ error: '被授权人不存在' });
  if (g.id === req.user.id) return res.status(400).json({ error: '不能授权给自己' });
  if (!startAt || !endAt || new Date(endAt) <= new Date(startAt)) {
    return res.status(400).json({ error: '授权时间段无效' });
  }
  const info = db.prepare('INSERT INTO delegates (manager_id, delegate_id, start_at, end_at) VALUES (?,?,?,?)')
    .run(req.user.id, g.id, new Date(startAt).toISOString(), new Date(endAt).toISOString());
  audit.audit({
    actorId: req.user.id, actorName: req.user.display_name, action: 'delegate_grant', objectType: 'delegate', objectId: info.lastInsertRowid,
    after: { delegate: g.username, startAt, endAt }, detail: `授权 ${g.display_name} 为代理审批人（${startAt} 至 ${endAt}）`,
  });
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

router.delete('/delegates/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM delegates WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: '授权不存在' });
  if (d.manager_id !== req.user.id) return res.status(403).json({ error: '只能撤销自己的授权' });
  db.prepare('DELETE FROM delegates WHERE id = ?').run(d.id);
  audit.audit({ actorId: req.user.id, actorName: req.user.display_name, action: 'delegate_revoke', objectType: 'delegate', objectId: d.id, detail: `撤销代理审批人授权 #${d.id}` });
  res.json({ ok: true });
});

module.exports = router;
