'use strict';
const express = require('express');
const db = require('../db/connection');
const { requireAuth, requirePerm, visibleChannels } = require('../middleware/auth');
const { comp, readOrders, readReviews, readInventory, CHANNELS } = require('../adapters');

const router = express.Router();
router.use(requireAuth);

function maskName(name) {
  const value = String(name || '');
  if (!value) return '';
  if (value.includes('*')) return value;
  return value.length === 1 ? '*' : `${value[0]}*${value.length > 2 ? value.at(-1) : ''}`;
}

function maskPhone(phone) {
  const value = String(phone || '');
  return value ? value.replace(/^(\d{3})\d+(\d{4})$/, '$1****$2') : value;
}

function allowedChannels(user) {
  return visibleChannels(user) || CHANNELS;
}

function filterChannels(rows, user) {
  const allowed = allowedChannels(user);
  return rows.filter(row => !row.channel || allowed.includes(row.channel));
}

router.get('/inventory', requirePerm('monitor:view', 'monitor:room'), (req, res) => {
  const allowed = allowedChannels(req.user);
  const rows = readInventory(1000).map(row => ({
    ...row,
    channels: Object.fromEntries(Object.entries(row.channels).filter(([channel]) => allowed.includes(channel))),
  }));
  res.json(rows);
});

router.get('/orders', requirePerm('monitor:view', 'monitor:room'), (req, res) => {
  const rows = filterChannels(readOrders(), req.user).map(order => ({
    ...order, guest: maskName(order.guest), phone: maskPhone(order.phone),
  }));
  res.json(rows);
});

router.get('/reviews', requirePerm('monitor:view', 'monitor:review'), (req, res) => {
  const rows = filterChannels(readReviews(), req.user).map(review => ({
    ...review, guest: maskName(review.guest),
  }));
  res.json(rows);
});

router.get('/competitors', requirePerm('monitor:view'), async (req, res, next) => {
  try { res.json(await comp.getRates()); } catch (error) { next(error); }
});

router.get('/dashboard', requirePerm('dashboard:view'), (req, res) => {
  const allowed = allowedChannels(req.user);
  const today = new Date().toISOString().slice(0, 10);
  const inventory = readInventory(1000).filter(row => row.biz_date === today);
  const pendingSuggestions = db.prepare(`SELECT * FROM suggestions WHERE status = 'pending'`).all()
    .filter(row => !row.channel || allowed.includes(row.channel)).length;
  const openAlerts = db.prepare(`SELECT level, COUNT(*) AS count FROM alerts WHERE status = 'open' GROUP BY level`).all();
  const orders = filterChannels(readOrders(), req.user);
  const reviews = filterChannels(readReviews(), req.user);
  const prices = inventory.flatMap(row => Object.entries(row.channels)
    .filter(([channel]) => allowed.includes(channel)).map(([, state]) => state.price));
  const alertCounts = { critical: 0, major: 0, minor: 0 };
  for (const row of openAlerts) alertCounts[row.level] = row.count;
  res.json({
    pendingSuggestions,
    openAlerts: alertCounts,
    channels: allowed.map(channel => ({ channel, connected: true, mode: '模拟数据' })),
    today: {
      date: today,
      totalRooms: inventory.reduce((sum, row) => sum + row.total_rooms, 0),
      availableRooms: inventory.reduce((sum, row) => sum + row.total_rooms - row.ooo_rooms, 0),
      orders: orders.length,
      averagePrice: prices.length ? Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length) : null,
      averageRating: reviews.length ? Number((reviews.reduce((sum, row) => sum + row.rating, 0) / reviews.length).toFixed(1)) : null,
    },
  });
});

module.exports = router;
