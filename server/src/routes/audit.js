'use strict';
const express = require('express');
const { requireAuth, requirePerm } = require('../middleware/auth');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth, requirePerm('audit:view'));

router.get('/', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json(audit.list({
    action: req.query.action || null,
    actor: req.query.actor || null,
    from: req.query.from || null,
    to: req.query.to || null,
    limit, offset,
  }));
});

module.exports = router;
