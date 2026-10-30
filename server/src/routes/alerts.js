'use strict';
const express = require('express');
const db = require('../db/connection');
const { requireAuth, requirePerm, visibleChannels, visibleStoreIds } = require('../middleware/auth');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth, requirePerm('alert:handle', 'alert:handle:order', 'alert:handle:review'));

function allowedTypes(req) {
  if (req.perms.has('alert:handle')) return null;
  if (req.perms.has('alert:handle:order')) return ['order', 'room', 'oversell'];
  if (req.perms.has('alert:handle:review')) return ['review'];
  return [];
}

function visibility(req) {
  const where = [];
  const args = [];
  const types = allowedTypes(req);
  if (types) {
    if (!types.length) return { where: ['1 = 0'], args };
    where.push(`type IN (${types.map(() => '?').join(',')})`);
    args.push(...types);
  }
  const channels = visibleChannels(req.user);
  if (channels) {
    if (!channels.length) where.push('1 = 0');
    else {
      where.push(`(channel IS NULL OR channel IN (${channels.map(() => '?').join(',')}))`);
      args.push(...channels);
    }
  }
  const stores = visibleStoreIds(req.user);
  if (stores) {
    if (!stores.length) where.push('1 = 0');
    else {
      where.push(`(store_id IS NULL OR store_id IN (${stores.map(() => '?').join(',')}))`);
      args.push(...stores);
    }
  }
  return { where, args };
}

function canSee(req, alert) {
  const types = allowedTypes(req);
  if (types && !types.includes(alert.type)) return false;
  const channels = visibleChannels(req.user);
  if (channels && (!channels.length || (alert.channel && !channels.includes(alert.channel)))) return false;
  const stores = visibleStoreIds(req.user);
  if (stores && (!stores.length || (alert.store_id && !stores.includes(alert.store_id)))) return false;
  return true;
}

router.get('/', (req, res) => {
  const { where, args } = visibility(req);
  if (req.query.status) { where.push('status = ?'); args.push(req.query.status); }
  if (req.query.level) { where.push('level = ?'); args.push(req.query.level); }
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
  const rows = db.prepare(`SELECT * FROM alerts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE level WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END, id DESC LIMIT ?`)
    .all(...args, limit);
  res.json(rows);
});

function resolveAlert(req, res, status) {
  const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(req.params.id);
  if (!alert) return res.status(404).json({ error: '告警不存在' });
  if (!canSee(req, alert)) return res.status(403).json({ error: '无权处理此类告警' });
  if (alert.status !== 'open') return res.status(409).json({ error: '该告警已处理' });
  const note = String(req.body?.note || req.body?.reason || '').trim();
  if (status === 'ignored' && !note) return res.status(400).json({ error: '忽略告警必须填写原因' });
  db.prepare(`UPDATE alerts SET status = ?, handled_by = ?, handled_at = datetime('now','localtime'), handle_note = ? WHERE id = ?`)
    .run(status, req.user.id, note || null, alert.id);
  audit.audit({
    actorId: req.user.id, actorName: req.user.display_name,
    action: status === 'handled' ? 'alert_handle' : 'alert_ignore',
    objectType: 'alert', objectId: alert.id,
    before: { status: alert.status }, after: { status, note },
    detail: `${status === 'handled' ? '处理' : '忽略'}告警 #${alert.id}：${alert.title}`,
  });
  return res.json({ ok: true });
}

router.post('/:id/handle', (req, res) => resolveAlert(req, res, 'handled'));
router.post('/:id/ignore', (req, res) => resolveAlert(req, res, 'ignored'));

module.exports = router;
