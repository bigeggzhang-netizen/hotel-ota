'use strict';
// 建议引擎服务：生成、确认、驳回、回滚（需求文档第 4.7、5 节）
const db = require('../db/connection');
const rules = require('./rules');
const audit = require('./audit');
const { ota, pms } = require('../adapters');
const { priceChangeLimit } = require('../middleware/permissions');
const config = require('../config');

/** 建议去重：同房型同日期同动作，已存在未完成建议则跳过（F-704） */
function findOpen(action, channel, roomType, date) {
  return db.prepare(
    `SELECT * FROM suggestions WHERE action = ? AND IFNULL(channel,'') = IFNULL(?, '')
       AND room_type = ? AND biz_date = ? AND status = 'pending'`
  ).get(action, channel ?? null, roomType, date);
}

function deadlineOf(urgency) {
  const mins = urgency === 'urgent' ? rules.getNum('urgent_wait_min', 10)
    : urgency === 'important' ? rules.getNum('important_wait_min', 60)
    : 24 * 60; // 普通：当日
  return new Date(Date.now() + mins * 60000).toISOString();
}

/** 价格护栏：超出底价/封顶价则不生成建议（F-703） */
function create({ action, channel, roomType, bizDate, beforeValue, afterValue, reason, impact = null, urgency = 'normal', createdBy = 'system' }) {
  if (action === 'adjust_price') {
    const chk = rules.withinGuardrails(roomType, Number(afterValue));
    if (!chk.ok) {
      return { created: false, reason: `价格护栏拦截：${chk.reason}，未生成建议` };
    }
  }
  const dup = findOpen(action, channel, roomType, bizDate);
  if (dup) return { created: false, existing: dup, reason: '已有相同待确认建议，已合并' };

  const info = db.prepare(
    `INSERT INTO suggestions (action, channel, room_type, biz_date, before_value, after_value, reason, impact, urgency, deadline, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(action, channel ?? null, roomType, bizDate,
    beforeValue == null ? null : String(beforeValue),
    String(afterValue), reason, impact, urgency, deadlineOf(urgency), createdBy);
  return { created: true, id: Number(info.lastInsertRowid) };
}

function list({ status = null, limit = 100 }) {
  const sql = status
    ? `SELECT * FROM suggestions WHERE status = ? ORDER BY CASE urgency WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, id DESC LIMIT ?`
    : `SELECT * FROM suggestions ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...(status ? [status, limit] : [limit]));
}

/** 权限 + 限额校验（确认前）。返回 { ok } 或 { error } */
function checkPermission(user, perms, s, finalValue) {
  const unlimited = perms.has('suggest:confirm');
  const limited = perms.has('suggest:confirm:limited');
  if (!unlimited && !limited) return { error: '当前角色无确认权限' };
  if (!unlimited && limited && s.action === 'adjust_price') {
    const before = Number(s.before_value);
    const after = Number(finalValue);
    if (!Number.isFinite(before) || before <= 0 || !Number.isFinite(after) || after <= 0) {
      return { error: '缺少有效的调整前后价格，无法校验调价限额' };
    }
    if (Math.abs(after - before) / before > priceChangeLimit()) {
      return { error: `超出收益经理单次调价限额 ±${Math.round(priceChangeLimit() * 100)}%（${before} → ${after}），请由管理者确认` };
    }
  }
  return { ok: true };
}

/** 确认并执行：写入渠道 → 回读核对 → 不一致重试一次（需求第 5 节） */
async function confirm(user, id, { finalValue = null, note = null } = {}) {
  const s = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
  if (!s) return { error: '建议不存在' };
  if (s.status !== 'pending') return { error: `建议状态为 ${s.status}，不能确认` };

  const execValue = finalValue ?? s.after_value;
  if (s.action === 'adjust_price') {
    const chk = rules.withinGuardrails(s.room_type, Number(execValue));
    if (!chk.ok) return { error: `价格护栏拦截：${chk.reason}` };
  }

  // 执行前快照（回滚用）
  const snapshot = {};
  const targets = s.channel
    ? [s.channel]
    : ota.channels;
  for (const ch of targets) {
    const cur = await ota.read(ch, s.room_type, s.biz_date);
    snapshot[ch] = cur ? { on_sale: cur.on_sale, price: cur.price, stock: cur.stock } : null;
  }

  const change = { action: s.action };
  if (s.action === 'adjust_price') change.price = Number(execValue);
  if (s.action === 'adjust_inventory') change.stock = Number(execValue);

  // 写入 + 回读核对，不一致自动重试 1 次
  let result = null, ok = false, detail = '';
  for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
    const writes = [];
    for (const ch of targets) {
      const r = await ota.push(ch, s.room_type, s.biz_date, change);
      writes.push({ channel: ch, ...r });
      if (!r.ok) break;
    }
    ok = writes.every(w => w.ok);
    result = writes;
    if (ok) {
      // 回读核对
      for (const ch of targets) {
        const back = await ota.read(ch, s.room_type, s.biz_date);
        const w = writes.find(x => x.channel === ch);
        const after = w.after;
        const match = after && back && back.on_sale === after.on_sale && back.price === after.price && back.stock === after.stock;
        if (!match) { ok = false; detail = `回读不一致（渠道 ${ch}），已自动重试 ${attempt} 次`; break; }
      }
      if (ok) detail = '写入并回读一致';
    } else if (attempt === 2) {
      detail = `写入失败：${writes.find(w => !w.ok)?.error || '未知错误'}`;
    }
  }

  db.prepare(`UPDATE suggestions SET status = 'confirmed', confirmed_by = ?, confirmed_at = datetime('now','localtime'),
              confirm_note = ?, after_value = ?, executed_at = datetime('now','localtime'),
              execute_ok = ?, execute_detail = ?, snapshot = ?
              WHERE id = ? AND status = 'pending'`)
    .run(user.id, note, String(execValue), ok ? 1 : 0, detail, JSON.stringify(snapshot), id);

  audit.audit({
    actorId: user.id, actorName: user.display_name, action: 'confirm',
    objectType: 'suggestion', objectId: id,
    before: { before_value: s.before_value, status: s.status },
    after: { after_value: String(execValue), executed: ok, detail },
    detail: `确认建议 #${id}：${s.action} ${s.channel || '全部渠道'} ${s.room_type} ${s.biz_date}${note ? '，备注：' + note : ''}`,
  });
  return { ok, detail, execute_ok: ok };
}

function reject(user, id, reason) {
  const s = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
  if (!s) return { error: '建议不存在' };
  if (s.status !== 'pending') return { error: '该建议已处理' };
  db.prepare(`UPDATE suggestions SET status = 'rejected', confirm_note = ?, confirmed_by = ?, confirmed_at = datetime('now','localtime') WHERE id = ?`)
    .run(reason, user.id, id);
  audit.audit({
    actorId: user.id, actorName: user.display_name, action: 'reject',
    objectType: 'suggestion', objectId: id, after: { reason },
    detail: `驳回建议 #${id}：${reason}`,
  });
  return { ok: true };
}

/** 一键回滚：72 小时内可恢复到调整前（需求第 5 节），回滚本身也留痕 */
async function rollback(user, id) {
  const s = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
  if (!s) return { error: '建议不存在' };
  if (s.status !== 'confirmed') return { error: '只有已执行的建议可以回滚' };
  if (!s.execute_ok) return { error: '该建议执行未成功，无回滚必要' };
  if (!s.snapshot) return { error: '缺少执行前快照，无法回滚' };
  if (new Date(s.confirmed_at).getTime() < Date.now() - config.rollbackWindowMs) {
    return { error: '已超过 72 小时回滚窗口' };
  }

  const snapshot = JSON.parse(s.snapshot);
  let ok = true, detail = '';
  for (const [ch, snap] of Object.entries(snapshot)) {
    if (!snap) continue;
    const r = await ota.push(ch, s.room_type, s.biz_date, { action: 'adjust_price', price: snap.price });
    if (!r.ok) { ok = false; detail = `渠道 ${ch} 回滚写入失败`; break; }
    const r2 = await ota.push(ch, s.room_type, s.biz_date, { action: 'adjust_inventory', stock: snap.stock });
    if (!r2.ok) { ok = false; detail = `渠道 ${ch} 房量回滚失败`; break; }
    if (snap.on_sale === 0) await ota.push(ch, s.room_type, s.biz_date, { action: 'close_room' });
    else await ota.push(ch, s.room_type, s.biz_date, { action: 'open_room' });
    const back = await ota.read(ch, s.room_type, s.biz_date);
    if (!back || back.price !== snap.price || back.stock !== snap.stock || back.on_sale !== snap.on_sale) {
      ok = false;
      detail = `渠道 ${ch} 回滚后回读不一致`;
      break;
    }
  }
  if (ok) detail = '已恢复到调整前的值并回读一致';

  if (ok) {
    db.prepare(`UPDATE suggestions SET status = 'rolled_back', rolled_back_at = datetime('now','localtime'), rolled_back_by = ? WHERE id = ?`)
      .run(user.id, id);
  }
  audit.audit({
    actorId: user.id, actorName: user.display_name, action: 'rollback',
    objectType: 'suggestion', objectId: id, after: { ok, detail },
    detail: `回滚建议 #${id}：${detail}`,
  });
  return { ok, detail };
}

module.exports = { create, list, findOpen, checkPermission, confirm, reject, rollback, deadlineOf };
