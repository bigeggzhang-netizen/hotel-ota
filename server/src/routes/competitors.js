'use strict';
const express = require('express');
const { requireAuth, requirePerm } = require('../middleware/auth');
const competitors = require('../services/competitors');

const router = express.Router();
router.use(requireAuth);

router.get('/analysis', requirePerm('monitor:view'), (req, res) => {
  const stayDate = req.query.stayDate || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stayDate)) return res.status(400).json({ error: '日期无效' });
  res.json(competitors.getAnalysis(stayDate));
});

router.post('/research', requirePerm('competitor:research'), (req, res) => {
  const result = competitors.addResearch(req.user, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result);
});

module.exports = router;
