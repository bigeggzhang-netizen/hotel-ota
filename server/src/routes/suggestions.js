'use strict';
const express = require('express');
const { requireAuth, requirePerm } = require('../middleware/auth');
const suggestions = require('../services/suggestions');
const db = require('../db/connection');

const router = express.Router();
router.use(requireAuth);

router.get('/', requirePerm('dashboard:view'), (req, res) => {
  const { status } = req.query;
  res.json(suggestions.list({ status: status || null }));
});

// 管理者/收益经理直接发起调价/上下架（需求第 5 节），同样走确认与留痕
router.post('/', requirePerm('suggest:create'), (req, res) => {
  const { action, channel, roomType, bizDate, afterValue, reason } = req.body || {};
  const validActions = ['open_room', 'close_room', 'adjust_inventory', 'adjust_price', 'online', 'offline'];
  if (!validActions.includes(action) || !roomType || !bizDate || afterValue == null || !reason) {
    return res.status(400).json({ error: '参数不完整' });
  }
  const r = suggestions.create({
    action, channel: channel || null, roomType, bizDate,
    beforeValue: null, afterValue, reason, urgency: 'normal', createdBy: `manual:${req.user.username}`,
  });
  if (!r.created) return res.status(409).json({ error: r.reason, existing: r.existing || undefined });
  res.status(201).json({ id: r.id });
});

// 二次验证口令（演示口令 1234，对应原型；生产应换密码/指纹）
const DEMO_OTP = '1234';
function checkOtp(req, res) {
  const { otp } = req.body || {};
  if (String(otp || '') !== DEMO_OTP) {
    res.status(403).json({ error: '二次验证口令错误' });
    return false;
  }
  return true;
}

router.post('/:id/confirm', requirePerm('suggest:confirm', 'suggest:confirm:limited'), async (req, res) => {
  if (!checkOtp(req, res)) return;
  const s = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '建议不存在' });
  const permCheck = suggestions.checkPermission(req.user, req.perms, s, req.body?.finalValue ?? s.after_value);
  if (permCheck.error) return res.status(403).json({ error: permCheck.error });

  const r = await suggestions.confirm(req.user, Number(req.params.id), {
    finalValue: req.body?.finalValue ?? null, note: req.body?.note ?? null,
  });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

router.post('/:id/reject', requirePerm('suggest:confirm', 'suggest:confirm:limited'), (req, res) => {
  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: '驳回必须填写原因' });
  const r = suggestions.reject(req.user, Number(req.params.id), reason);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

router.post('/:id/rollback', requirePerm('suggest:confirm'), async (req, res) => {
  if (!checkOtp(req, res)) return;
  const r = await suggestions.rollback(req.user, Number(req.params.id));
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

module.exports = router;
