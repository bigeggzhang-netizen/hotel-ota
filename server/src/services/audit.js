'use strict';
const db = require('../db/connection');

/** 审计日志只增不改，满足“保存≥1年、不可删除” */
function audit({ actorId = null, actorName = 'system', action, objectType = null, objectId = null, before = null, after = null, detail = null }) {
  db.prepare(`INSERT INTO audit_log (actor_id, actor_name, action, object_type, object_id, before_json, after_json, detail)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(actorId, actorName, action, objectType, objectId == null ? null : String(objectId),
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      detail);
}

function list({ action = null, actor = null, from = null, to = null, limit = 200, offset = 0 }) {
  const where = [], args = [];
  if (action) { where.push('action = ?'); args.push(action); }
  if (actor) { where.push('(actor_name = ? OR actor_id = ?)'); args.push(actor, actor); }
  if (from) { where.push('created_at >= ?'); args.push(from); }
  if (to) { where.push('created_at <= ?'); args.push(to); }
  const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY id DESC LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...args, limit, offset);
}

module.exports = { audit, list };
