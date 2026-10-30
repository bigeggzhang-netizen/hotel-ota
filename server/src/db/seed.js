'use strict';
const db = require('./connection');
const { hashPassword } = require('../utils/crypto');
const { DEFAULT_RULES } = require('../services/rules');
const { CHANNELS, ROOM_TYPES } = require('../adapters');

const DEMO_USERS = [
  ['admin', 'Admin@123', '店长', 'manager'],
  ['revenue', 'Revenue@123', '收益经理', 'revenue'],
  ['frontdesk', 'Frontdesk@123', '前台值班', 'frontdesk'],
  ['service', 'Service@123', '客服专员', 'service'],
  ['viewer', 'Viewer@123', '老板', 'viewer'],
];

function seed() {
  db.prepare('INSERT OR IGNORE INTO stores (name) VALUES (?)').run('总店');
  const store = db.prepare('SELECT id FROM stores WHERE name = ?').get('总店');
  const insertRule = db.prepare('INSERT OR IGNORE INTO rules (key, value, updated_by) VALUES (?,?,?)');
  for (const [key, value] of Object.entries(DEFAULT_RULES)) insertRule.run(key, value, 'system');
  const guardrails = {
    大床房: [300, 800],
    双床房: [330, 850],
    家庭房: [400, 1000],
  };
  for (const roomType of ROOM_TYPES) {
    const [floor, ceiling] = guardrails[roomType];
    insertRule.run(`floor_price_${roomType}`, String(floor), 'system');
    insertRule.run(`ceiling_price_${roomType}`, String(ceiling), 'system');
  }

  const findUser = db.prepare('SELECT id FROM users WHERE username = ?');
  const insertUser = db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?,?,?,?)');
  const grantStore = db.prepare('INSERT OR IGNORE INTO user_stores (user_id, store_id) VALUES (?,?)');
  const grantChannel = db.prepare('INSERT OR IGNORE INTO user_channels (user_id, channel) VALUES (?,?)');
  for (const [username, password, displayName, role] of DEMO_USERS) {
    let user = findUser.get(username);
    if (!user) {
      const initialPassword = process.env[`${username.toUpperCase()}_PASSWORD`] || password;
      const info = insertUser.run(username, hashPassword(initialPassword), displayName, role);
      user = { id: Number(info.lastInsertRowid) };
    }
    if (role === 'frontdesk' || role === 'service') {
      grantStore.run(user.id, store.id);
      for (const channel of CHANNELS) grantChannel.run(user.id, channel);
    }
  }
}

if (require.main === module) {
  seed();
  console.log('种子数据已初始化：admin / revenue / frontdesk / service / viewer');
}

module.exports = seed;
