'use strict';
// 监控调度器：定期检查房态、价格、订单、点评（需求第 4 节）
// 演示环境用秒级间隔；生产环境应为 5/15/30 分钟级，由独立常驻服务承担。
const db = require('../db/connection');
const rules = require('./rules');
const suggestions = require('./suggestions');
const audit = require('./audit');
const { pms, ota, comp, notify, ROOM_TYPES, CHANNELS, COMPETITORS, readOrders, readReviews } = require('../adapters');

/** 告警去重：同一问题 30 分钟内只通知一次（需求第 6 节） */
function alertDedupe(level, type, dedupeKey) {
  const row = db.prepare(
    `SELECT id FROM alerts WHERE type = ? AND IFNULL(dedupe_key,'') = IFNULL(?, '')
       AND created_at >= datetime('now','localtime', '-30 minutes') LIMIT 1`
  ).get(type, dedupeKey ?? null);
  return !!row;
}

function raiseAlert({ level, type, title, detail, dedupeKey = null, channel = null }) {
  if (alertDedupe(level, type, dedupeKey)) return { created: false };
  const info = db.prepare(
    `INSERT INTO alerts (level, type, title, detail, dedupe_key, channel) VALUES (?,?,?,?,?,?)`
  ).run(level, type, title, detail, dedupeKey, channel);
  if (level === 'critical') notify.send(level, title, []);
  return { created: true, id: Number(info.lastInsertRowid) };
}

const todayStr = () => new Date().toISOString().slice(0, 10);

// F-102 超售风险：渠道在售房量 > PMS 可售房
async function checkOversell() {
  const date = todayStr();
  for (const rt of ROOM_TYPES) {
    const avail = await pms.getAvailability(rt, date);
    if (!avail) continue;
    for (const ch of ota.channels) {
      const st = await ota.read(ch, rt, date);
      if (!st || !st.on_sale) continue;
      if (st.stock > avail.available) {
        raiseAlert({
          level: 'critical', type: 'oversell',
          title: `超售风险：${ch} ${rt} 在售 ${st.stock} 间 > PMS 可售 ${avail.available} 间`,
          detail: `日期 ${date}，请立即关房或减房量`,
          dedupeKey: `oversell:${ch}:${rt}:${date}`, channel: ch,
        });
        suggestions.create({
          action: 'close_room', channel: ch, roomType: rt, bizDate: date,
          beforeValue: '在售', afterValue: '关房',
          reason: `超售风险：渠道在售 ${st.stock} 间超过 PMS 可售 ${avail.available} 间`,
          urgency: 'urgent',
        });
      }
    }
  }
}

// F-103 漏开房：PMS 有空房但渠道关房
async function checkClosedWithAvailability() {
  const date = todayStr();
  for (const rt of ROOM_TYPES) {
    const avail = await pms.getAvailability(rt, date);
    if (!avail || avail.available <= 0) continue;
    for (const ch of ota.channels) {
      const st = await ota.read(ch, rt, date);
      if (st && !st.on_sale) {
        raiseAlert({
          level: 'major', type: 'room',
          title: `漏开房：${ch} ${rt} 已关房但 PMS 仍有 ${avail.available} 间可售`,
          dedupeKey: `closed:${ch}:${rt}:${date}`, channel: ch,
        });
        suggestions.create({
          action: 'open_room', channel: ch, roomType: rt, bizDate: date,
          beforeValue: '关房', afterValue: '开房',
          reason: `PMS 可售 ${avail.available} 间，渠道未开房，存在空置损失`,
          urgency: 'important',
        });
      }
    }
  }
}

// F-202/F-203 价格监控：渠道间价差、低于底价/高于封顶
async function checkPrices() {
  const date = todayStr();
  const pct = rules.getNum('price_diff_pct', 3);
  const abs = rules.getNum('price_diff_abs', 10);
  for (const rt of ROOM_TYPES) {
    const prices = {};
    for (const ch of ota.channels) {
      const st = await ota.read(ch, rt, date);
      if (st && st.on_sale) prices[ch] = st.price;
    }
    const vals = Object.values(prices);
    if (vals.length >= 2) {
      const [min, max] = [Math.min(...vals), Math.max(...vals)];
      const diffPct = ((max - min) / min) * 100;
      if (diffPct > pct && (max - min) > abs) {
        raiseAlert({
          level: 'major', type: 'price',
          title: `价格不一致：${rt} 渠道间价差 ¥${max - min}（${diffPct.toFixed(1)}%）`,
          detail: Object.entries(prices).map(([c, p]) => `${c} ¥${p}`).join('，'),
          dedupeKey: `pricediff:${rt}:${date}`,
        });
      }
    }
    // 价格护栏
    for (const [ch, price] of Object.entries(prices)) {
      const g = rules.guardrails(rt);
      if (g.floor != null && price < g.floor) {
        raiseAlert({
          level: 'critical', type: 'price',
          title: `异常低价：${ch} ${rt} ¥${price} 低于底价 ¥${g.floor}`,
          dedupeKey: `lowprice:${ch}:${rt}:${date}`, channel: ch,
        });
        suggestions.create({
          action: 'adjust_price', channel: ch, roomType: rt, bizDate: date,
          beforeValue: price, afterValue: Math.round((g.floor + (g.ceiling ?? g.floor * 1.5)) / 2),
          reason: `当前价 ¥${price} 低于底价 ¥${g.floor}，建议恢复至合理区间`,
          urgency: 'urgent',
        });
      } else if (g.ceiling != null && price > g.ceiling) {
        raiseAlert({
          level: 'critical', type: 'price',
          title: `异常高价：${ch} ${rt} ¥${price} 高于封顶价 ¥${g.ceiling}`,
          dedupeKey: `highprice:${ch}:${rt}:${date}`, channel: ch,
        });
        suggestions.create({
          action: 'adjust_price', channel: ch, roomType: rt, bizDate: date,
          beforeValue: price, afterValue: g.ceiling,
          reason: `当前价 ¥${price} 高于封顶价 ¥${g.ceiling}（可能为误操作），建议下调`,
          urgency: 'urgent',
        });
      }
    }
  }
}

// F-401 订单超时未确认
async function checkOrders() {
  const timeoutMin = rules.getNum('order_timeout_min', 10);
  const rows = readOrders().filter(o => o.status === 'unconfirmed');
  for (const o of rows) {
    const mins = (Date.now() - new Date(o.created_at).getTime()) / 60000;
    if (mins > timeoutMin) {
      raiseAlert({
        level: 'critical', type: 'order',
        title: `订单超时未确认：${o.channel} ${o.room_type} 已等待 ${Math.floor(mins)} 分钟`,
        detail: `客人 ${o.guest}，超过 ${timeoutMin} 分钟未确认将被 OTA 处罚`,
        dedupeKey: `order:${o.id}`,
      });
    }
  }
}

// F-501 差评监控
async function checkReviews() {
  const sensitive = ['蟑螂', '不干净', '起争执', '异味', '头发'];
  for (const r of readReviews()) {
    const mins = (Date.now() - new Date(r.created_at).getTime()) / 60000;
    if (mins > 24 * 60) continue; // 只盯新点评
    const hit = r.rating <= 3 || sensitive.some(w => r.content.includes(w));
    if (hit) {
      raiseAlert({
        level: r.rating <= 3 ? 'major' : 'minor', type: 'review',
        title: `新差评（${r.rating} 分）：${r.channel} 客人评价"${r.content.slice(0, 30)}"`,
        detail: '请客服在 2 小时内首次响应',
        dedupeKey: `review:${r.id}`, channel: r.channel,
      });
    }
  }
}

// F-301/F-302 竞对监控
async function checkCompetitors() {
  const pct = rules.getNum('comp_change_pct', 10);
  const today = todayStr();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const db2 = require('../db/connection');
  for (const cp of COMPETITORS) {
    const cur = db2.prepare('SELECT * FROM mock_comp_rates WHERE competitor = ? AND biz_date = ?').get(cp, today);
    const prev = db2.prepare('SELECT * FROM mock_comp_rates WHERE competitor = ? AND biz_date = ?').get(cp, yesterday);
    if (!cur || !prev || !prev.price) continue;
    const chg = ((cur.price - prev.price) / prev.price) * 100;
    if (Math.abs(chg) >= pct) {
      raiseAlert({
        level: 'major', type: 'comp',
        title: `竞对调价：${cp} ${chg > 0 ? '上调' : '下调'} ${Math.abs(chg).toFixed(0)}% 至 ¥${cur.price}`,
        dedupeKey: `comp:${cp}:${today}`,
      });
    }
    if (cur.sold_out) {
      raiseAlert({
        level: 'major', type: 'comp',
        title: `竞对满房：${cp} 今日已满房，可考虑小幅上调价格`,
        dedupeKey: `compsoldout:${cp}:${today}`,
      });
    }
  }
}

// 超时处理：紧急建议超时无人确认 → 超售风险自动关房（唯一自动写入，可在设置关闭）
async function sweepTimeouts() {
  const urgentWait = rules.getNum('urgent_wait_min', 10);
  const pending = db.prepare(`SELECT * FROM suggestions WHERE status = 'pending' AND urgency = 'urgent'`).all();
  for (const s of pending) {
    const waitedMin = (Date.now() - new Date(s.created_at).getTime()) / 60000;
    if (waitedMin < urgentWait * 2) continue; // 给满两轮等待时间
    const isOversellClose = s.action === 'close_room' && /超售/.test(s.reason);
    if (isOversellClose && rules.get('emergency_close_enabled', '1') === '1') {
      // 自动关房：只关不开、不改价
      const targets = s.channel ? [s.channel] : ota.channels;
      let ok = true;
      for (const ch of targets) {
        const r = await ota.push(ch, s.room_type, s.biz_date, { action: 'close_room' });
        if (!r.ok) ok = false;
      }
      db.prepare(`UPDATE suggestions SET status = 'confirmed', execute_ok = ?, execute_detail = '超售风险超时未确认，系统自动关房（只关不开、不改价）', confirmed_at = datetime('now','localtime'), executed_at = datetime('now','localtime') WHERE id = ?`)
        .run(ok ? 1 : 0, s.id);
      audit.audit({
        actorName: 'system', action: 'emergency_close',
        objectType: 'suggestion', objectId: s.id,
        after: { executed: ok }, detail: `建议 #${s.id} 超时未确认，触发自动紧急关房`,
      });
      notify.send('critical', `超售风险：${s.channel || '全部渠道'} ${s.room_type} 已自动关房，请管理者知悉`, []);
    } else if (waitedMin > 4 * 60) {
      // 其他紧急建议（异常价格）：不自动执行，作废
      db.prepare(`UPDATE suggestions SET status = 'expired' WHERE id = ?`).run(s.id);
      audit.audit({ actorName: 'system', action: 'expire', objectType: 'suggestion', objectId: s.id, detail: '紧急建议超时作废（异常价格不自动执行）' });
    }
  }
  // 重要建议 4 小时、普通建议 48 小时作废
  db.prepare(`UPDATE suggestions SET status = 'expired' WHERE status = 'pending' AND urgency = 'important' AND created_at < datetime('now','localtime','-4 hours')`).run();
  db.prepare(`UPDATE suggestions SET status = 'expired' WHERE status = 'pending' AND urgency = 'normal' AND created_at < datetime('now','localtime','-48 hours')`).run();
}

const CHECKS = [
  { name: 'oversell', fn: checkOversell, intervalMs: 60 * 1000 },
  { name: 'closed_room', fn: checkClosedWithAvailability, intervalMs: 60 * 1000 },
  { name: 'price', fn: checkPrices, intervalMs: 60 * 1000 },
  { name: 'orders', fn: checkOrders, intervalMs: 60 * 1000 },
  { name: 'reviews', fn: checkReviews, intervalMs: 5 * 60 * 1000 },
  { name: 'competitors', fn: checkCompetitors, intervalMs: 5 * 60 * 1000 },
  { name: 'timeouts', fn: sweepTimeouts, intervalMs: 60 * 1000 },
];

function start() {
  for (const c of CHECKS) {
    c.fn().catch(e => console.error(`[monitor:${c.name}]`, e));
    setInterval(() => c.fn().catch(e => console.error(`[monitor:${c.name}]`, e)), c.intervalMs);
  }
  console.log(`[monitor] 已启动 ${CHECKS.length} 项检查`);
}

/** 手动触发一次全部检查（演示/测试用） */
async function runOnce() {
  for (const c of CHECKS) await c.fn();
}

module.exports = { start, runOnce };
