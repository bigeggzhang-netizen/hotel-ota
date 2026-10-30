'use strict';
const express = require('express');
const { requireAuth, requirePerm, visibleChannels } = require('../middleware/auth');
const suggestions = require('../services/suggestions');
const db = require('../db/connection');
const config = require('../config');
const { ota, CHANNELS, ROOM_TYPES } = require('../adapters');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireAuth);

router.get('/', requirePerm('dashboard:view'), (req, res) => {
  const channels = visibleChannels(req.user);
  const rows = suggestions.list({ status: req.query.status || null })
    .filter(row => !channels || (channels.length > 0 && (!row.channel || channels.includes(row.channel))));
  res.json(rows);
});

// 直接发起也只生成待确认建议，不会在此接口写入 OTA
router.post('/', requirePerm('suggest:create'), wrap(async (req, res) => {
  const { action, channel, roomType, bizDate, afterValue, reason } = req.body || {};
  const validActions = ['open_room', 'close_room', 'adjust_inventory', 'adjust_price', 'online', 'offline'];
  if (!validActions.includes(action) || !ROOM_TYPES.includes(roomType) || !/^\d{4}-\d{2}-\d{2}$/.test(bizDate || '') || afterValue == null || !String(reason || '').trim()) {
    return res.status(400).json({ error: '参数不完整或无效' });
  }
  if (channel && !CHANNELS.includes(channel)) return res.status(400).json({ error: '无效渠道' });
  const allowed = visibleChannels(req.user);
  if (allowed && (!allowed.length || (channel ? !allowed.includes(channel) : !allowed.length))) {
    return res.status(403).json({ error: '无权操作该渠道' });
  }
  if (['adjust_price', 'adjust_inventory'].includes(action) && (!Number.isFinite(Number(afterValue)) || Number(afterValue) < 0)) {
    return res.status(400).json({ error: '调整值必须是非负数字' });
  }
  const targets = channel ? [channel] : ota.channels;
  const current = await ota.read(targets[0], roomType, bizDate);
  if (!current) return res.status(404).json({ error: '渠道无此房型或日期记录' });
  let beforeValue = current.on_sale ? '在售' : '关房';
  if (action === 'adjust_price') beforeValue = current.price;
  if (action === 'adjust_inventory') beforeValue = current.stock;
  const r = suggestions.create({
    action, channel: channel || null, roomType, bizDate,
    beforeValue, afterValue, reason: String(reason).trim(), urgency: 'normal', createdBy: `manual:${req.user.username}`,
  });
  if (!r.created) return res.status(409).json({ error: r.reason, existing: r.existing || undefined });
  res.status(201).json({ id: r.id });
}));

function checkOtp(req, res) {
  const { otp } = req.body || {};
  if (String(otp || '') !== config.confirmOtp) {
    res.status(403).json({ error: '二次验证口令错误' });
    return false;
  }
  return true;
}

router.post('/:id/confirm', requirePerm('suggest:confirm', 'suggest:confirm:limited'), wrap(async (req, res) => {
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
}));

router.post('/:id/reject', requirePerm('suggest:confirm', 'suggest:confirm:limited'), (req, res) => {
  const { reason } = req.body || {};
  if (!String(reason || '').trim()) return res.status(400).json({ error: '驳回必须填写原因' });
  const r = suggestions.reject(req.user, Number(req.params.id), String(reason).trim());
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

router.post('/:id/rollback', requirePerm('suggest:confirm'), wrap(async (req, res) => {
  if (!checkOtp(req, res)) return;
  const r = await suggestions.rollback(req.user, Number(req.params.id));
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
}));

module.exports = router;
