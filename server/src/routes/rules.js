'use strict';
const express = require('express');
const { requireAuth, requirePerm } = require('../middleware/auth');
const rules = require('../services/rules');
const audit = require('../services/audit');
const { ROOM_TYPES } = require('../adapters');

const router = express.Router();
router.use(requireAuth);

router.get('/', requirePerm('dashboard:view'), (req, res) => {
  res.json(rules.getAll());
});

router.put('/', requirePerm('rule:edit'), (req, res) => {
  const { key, value } = req.body || {};
  if (!key || value == null) return res.status(400).json({ error: '规则键和值不能为空' });
  const isDefault = Object.hasOwn(rules.DEFAULT_RULES, key);
  const isGuardrail = rules.isGuardrailKey(key) && ROOM_TYPES.some(rt => key.endsWith(rt));
  if (!isDefault && !isGuardrail) return res.status(400).json({ error: '未知规则' });
  if (isGuardrail && !req.perms.has('rule:edit:guardrail')) {
    return res.status(403).json({ error: '仅管理者可以修改底价和封顶价' });
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return res.status(400).json({ error: '规则值必须是非负数字' });
  if (key === 'emergency_close_enabled' && ![0, 1].includes(number)) {
    return res.status(400).json({ error: '紧急关房开关只能为 0 或 1' });
  }
  const before = rules.get(key);
  rules.set(key, number, req.user.display_name);
  audit.audit({
    actorId: req.user.id, actorName: req.user.display_name, action: 'rule_update',
    objectType: 'rule', objectId: key, before: { value: before }, after: { value: String(number) },
    detail: `修改规则 ${key}：${before ?? '未设置'} → ${number}`,
  });
  res.json({ ok: true, key, value: String(number) });
});

module.exports = router;
