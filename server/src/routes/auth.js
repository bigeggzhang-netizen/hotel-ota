'use strict';
const express = require('express');
const auth = require('../middleware/auth');
const { ROLE_NAMES, ROLE_MATRIX } = require('../middleware/permissions');
const db = require('../db/connection');

const router = express.Router();

router.post('/login', express.json(), (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  const result = auth.login(req, res, String(username).trim(), String(password));
  if (!result.ok) return res.status(401).json({ error: result.error });
  res.json({ ok: true, user: publicUser(result.user) });
});

router.post('/logout', (req, res) => {
  auth.logout(req, res);
  res.json({ ok: true });
});

router.get('/me', auth.requireAuth, (req, res) => {
  const stores = auth.visibleStoreIds(req.user);
  const channels = auth.visibleChannels(req.user);
  res.json({
    user: publicUser(req.user),
    perms: [...req.perms],
    roleName: ROLE_NAMES[req.user.role],
    stores, channels,
    delegateFor: req.delegateFor || null,
  });
});

function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.display_name, role: u.role, phone: u.phone };
}

module.exports = router;
