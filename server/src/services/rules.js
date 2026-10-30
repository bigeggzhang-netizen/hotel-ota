'use strict';
const db = require('../db/connection');

const DEFAULT_RULES = {
  price_diff_pct: '3',        // 渠道间价差阈值（%），需求 F-202
  price_diff_abs: '10',       // 渠道间价差阈值（¥）
  comp_change_pct: '10',      // 竞对调价阈值（%），需求 F-302
  occupancy_high: '90',       // 入住率提醒阈值（%），需求 F-104
  order_timeout_min: '10',    // 订单未确认升级（分钟），需求 F-401
  urgent_wait_min: '10',      // 紧急建议等待管理者（分钟），需求第5节
  important_wait_min: '60',   // 重要建议等待（分钟）
  emergency_close_enabled: '1', // 超售风险自动关房（默认开启，可关闭）
};

const GUARDRAIL_PREFIXES = ['floor_price_', 'ceiling_price_'];  // 底价/封顶价：仅管理者可改

function getAll() {
  const rows = db.prepare('SELECT * FROM rules ORDER BY key').all();
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  for (const [k, v] of Object.entries(DEFAULT_RULES)) if (!(k in map)) map[k] = v;
  return map;
}

function get(key, fallback = null) {
  const row = db.prepare('SELECT value FROM rules WHERE key = ?').get(key);
  return row ? row.value : (DEFAULT_RULES[key] ?? fallback);
}

function getNum(key, fallback = 0) {
  const raw = get(key, fallback);
  if (raw == null || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/** 价格护栏：返回 { floor, ceiling }；未配置则 null */
function guardrails(roomType) {
  return {
    floor: getNum(`floor_price_${roomType}`, null),
    ceiling: getNum(`ceiling_price_${roomType}`, null),
  };
}

/** 检查价格是否在护栏内（F-703） */
function withinGuardrails(roomType, price) {
  const { floor, ceiling } = guardrails(roomType);
  if (floor != null && price < floor) return { ok: false, reason: `低于底价 ¥${floor}` };
  if (ceiling != null && price > ceiling) return { ok: false, reason: `高于封顶价 ¥${ceiling}` };
  return { ok: true };
}

function set(key, value, updatedBy) {
  db.prepare(`INSERT INTO rules (key, value, updated_by, updated_at) VALUES (?,?,?,datetime('now','localtime'))
              ON CONFLICT(key) DO UPDATE SET value = ?, updated_by = ?, updated_at = datetime('now','localtime')`)
    .run(key, String(value), updatedBy, String(value), updatedBy);
}

function isGuardrailKey(key) {
  return GUARDRAIL_PREFIXES.some(p => key.startsWith(p));
}

module.exports = { getAll, get, getNum, set, guardrails, withinGuardrails, isGuardrailKey, DEFAULT_RULES };
