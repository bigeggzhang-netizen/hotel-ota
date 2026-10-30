'use strict';
// 数据适配器层（需求文档第 2、3 节）
// 当前全部为模拟实现；接入真实数据时只需用真实接口替换本目录下对应模块，
// 保持导出函数签名不变，上层监控规则、告警与确认流程无需改动。
//
// | 适配器 | 数据源 | 接口 |
// | pms    | 选住云管家 | getAvailability(房型, 日期) |
// | ota    | 携程/美团/飞猪 | read(渠道, 房型, 日期) · push(渠道, 房型, 日期, 变更) |
// | comp   | 竞对价格服务 | getRates(竞对列表) |
// | notify | 电话/企业微信/短信 | send(级别, 内容, 接收人) |

const db = require('../db/connection');

const ROOM_TYPES = ['大床房', '双床房', '家庭房'];
const CHANNELS = ['携程', '美团', '飞猪'];
const COMPETITORS = ['如家商旅酒店', '汉庭优佳酒店', '亚朵轻居酒店'];

// ---------- 模拟行情生成（确定性伪随机，重启后稳定） ----------
function seedMockData() {
  const n = db.prepare('SELECT COUNT(*) AS c FROM mock_inventory').get().c;
  if (n > 0) return;
  const insInv = db.prepare(`INSERT INTO mock_inventory (room_type, biz_date, total_rooms, ooo_rooms) VALUES (?,?,?,?)`);
  const insOta = db.prepare(`INSERT INTO mock_ota_state (channel, room_type, biz_date, on_sale, price, stock) VALUES (?,?,?,?,?,?)`);
  const insComp = db.prepare(`INSERT INTO mock_comp_rates (competitor, biz_date, price, sold_out) VALUES (?,?,?,?)`);
  const insOrder = db.prepare(`INSERT INTO mock_orders (channel, room_type, guest, status, created_at, confirmed_at) VALUES (?,?,?,?,?,?)`);
  const insReview = db.prepare(`INSERT INTO mock_reviews (channel, guest, rating, content, replied, created_at) VALUES (?,?,?,?,?,?)`);

  const today = new Date();
  const basePrices = { '大床房': 399, '双床房': 429, '家庭房': 529 };
  const compBase = { '如家商旅酒店': 389, '汉庭优佳酒店': 359, '亚朵轻居酒店': 469 };

  for (let d = 0; d < 14; d++) {
    const date = new Date(today.getTime() + d * 86400000).toISOString().slice(0, 10);
    for (const rt of ROOM_TYPES) {
      const total = 8 + ((d * 7 + rt.length) % 6);        // 8-13 间
      const ooo = (d + rt.length) % 7 === 0 ? 1 : 0;      // 偶尔有维修房
      insInv.run(rt, date, total, ooo);
      for (const ch of CHANNELS) {
        const wave = ((d * 13 + ch.charCodeAt(0)) % 5) - 2;  // -2..+2 波动
        insOta.run(ch, rt, date, 1, basePrices[rt] + wave * 10 + (ch === '携程' ? 8 : 0), total - ooo);
      }
    }
    for (const cp of COMPETITORS) {
      insComp.run(cp, date, compBase[cp] + ((d * 11) % 5) * 5, d % 9 === 8 ? 1 : 0);
    }
  }
  // 种子订单与点评
  const guests = ['张*明', '李*华', '王*芳', '刘*强', '陈*静', '周*杰'];
  for (let i = 0; i < 6; i++) {
    const ch = CHANNELS[i % 3];
    const created = new Date(Date.now() - (i * 17 + 5) * 60000);
    insOrder.run(ch, ROOM_TYPES[i % 3], guests[i], i === 2 ? 'unconfirmed' : 'confirmed',
      created.toISOString(), i === 2 ? null : created.toISOString());
  }
  const reviews = [
    ['携程', '赵*', 2, '房间有异味，隔音很差，半夜隔壁吵架都听得见', 0],
    ['美团', '钱*', 5, '位置方便，前台服务态度好', 1],
    ['飞猪', '孙*', 3, '卫生一般，浴室有头发，希望改进', 0],
    ['携程', '周*', 5, '早餐丰富，床垫舒服', 1],
  ];
  for (const [ch, g, r, c, rep] of reviews) {
    insReview.run(ch, g, r, c, rep, new Date(Date.now() - (r * 53 + 11) * 60000).toISOString());
  }
}

// 模拟数据表（不存在则建，属于适配器内部实现细节）
db.exec(`
CREATE TABLE IF NOT EXISTS mock_inventory (
  room_type TEXT NOT NULL, biz_date TEXT NOT NULL, total_rooms INTEGER, ooo_rooms INTEGER,
  PRIMARY KEY (room_type, biz_date));
CREATE TABLE IF NOT EXISTS mock_ota_state (
  channel TEXT NOT NULL, room_type TEXT NOT NULL, biz_date TEXT NOT NULL,
  on_sale INTEGER, price INTEGER, stock INTEGER,
  PRIMARY KEY (channel, room_type, biz_date));
CREATE TABLE IF NOT EXISTS mock_comp_rates (
  competitor TEXT NOT NULL, biz_date TEXT NOT NULL, price INTEGER, sold_out INTEGER,
  PRIMARY KEY (competitor, biz_date));
CREATE TABLE IF NOT EXISTS mock_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, room_type TEXT, guest TEXT,
  status TEXT, created_at TEXT, confirmed_at TEXT);
CREATE TABLE IF NOT EXISTS mock_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, guest TEXT, rating INTEGER,
  content TEXT, replied INTEGER, created_at TEXT);
`);

seedMockData();

// ---------- PMS 适配器（选住云管家，现阶段模拟） ----------
const pms = {
  name: '选住云管家(模拟)',
  async getAvailability(roomType, date) {
    const row = db.prepare('SELECT * FROM mock_inventory WHERE room_type = ? AND biz_date = ?').get(roomType, date);
    if (!row) return null;
    return { roomType, date, total: row.total_rooms, ooo: row.ooo_rooms, available: row.total_rooms - row.ooo_rooms };
  },
};

// ---------- OTA 适配器 ----------
const ota = {
  channels: CHANNELS,
  async read(channel, roomType, date) {
    return db.prepare('SELECT * FROM mock_ota_state WHERE channel = ? AND room_type = ? AND biz_date = ?')
      .get(channel, roomType, date) || null;
  },
  /** 写入渠道（须人工确认后调用）。返回 { ok, after } */
  async push(channel, roomType, date, change) {
    const cur = await this.read(channel, roomType, date);
    if (!cur) return { ok: false, error: '渠道无此房型/日期记录' };
    const next = { ...cur };
    if (change.action === 'open_room') next.on_sale = 1;
    if (change.action === 'close_room') next.on_sale = 0;
    if (change.action === 'adjust_price') next.price = Math.round(change.price);
    if (change.action === 'adjust_inventory') next.stock = Math.max(0, Math.round(change.stock));
    if (change.action === 'online') next.on_sale = 1;
    if (change.action === 'offline') next.on_sale = 0;
    db.prepare('UPDATE mock_ota_state SET on_sale = ?, price = ?, stock = ? WHERE channel = ? AND room_type = ? AND biz_date = ?')
      .run(next.on_sale, next.price, next.stock, channel, roomType, date);
    return { ok: true, after: next };
  },
};

// ---------- 竞对适配器 ----------
const comp = {
  async getRates(list) {
    const names = list && list.length ? list : COMPETITORS;
    const today = new Date().toISOString().slice(0, 10);
    return names.map(name => {
      const row = db.prepare('SELECT * FROM mock_comp_rates WHERE competitor = ? AND biz_date = ?').get(name, today);
      return row ? { competitor: name, price: row.price, soldOut: !!row.sold_out } : { competitor: name, price: null, soldOut: false };
    });
  },
};

// ---------- 通知适配器（只记录，不真实发送） ----------
const notify = {
  async send(level, content, recipients) {
    console.log(`[notify:${level}] ${content} → ${(recipients || []).join(', ') || '管理者'}`);
    return { ok: true };
  },
};

// ---------- 读取模拟业务数据（订单/点评，供监控与页面展示） ----------
function readOrders() {
  return db.prepare('SELECT * FROM mock_orders ORDER BY id DESC LIMIT 50').all();
}
function readReviews() {
  return db.prepare('SELECT * FROM mock_reviews ORDER BY id DESC LIMIT 50').all();
}
function readInventory(days = 14) {
  const rows = db.prepare('SELECT * FROM mock_inventory ORDER BY biz_date LIMIT ?').all(days);
  const otaRows = db.prepare('SELECT * FROM mock_ota_state ORDER BY biz_date').all();
  const byDate = {};
  for (const r of otaRows) {
    (byDate[r.biz_date] ||= {})[r.room_type] ||= {};
    byDate[r.biz_date][r.room_type][r.channel] = { onSale: !!r.on_sale, price: r.price, stock: r.stock };
  }
  return rows.map(r => ({ ...r, channels: byDate[r.biz_date]?.[r.room_type] || {} }));
}

module.exports = { pms, ota, comp, notify, ROOM_TYPES, CHANNELS, COMPETITORS, readOrders, readReviews, readInventory };
