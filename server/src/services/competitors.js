'use strict';
const db = require('../db/connection');
const audit = require('./audit');
const { CHANNELS, ROOM_TYPES } = require('../adapters');

const CONFIDENCE_NAMES = { high: '高', medium: '中', low: '低' };

function average(rows, key) {
  const values = rows.map(row => row[key]).filter(value => value != null && Number.isFinite(Number(value))).map(Number);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function minimum(rows, key) {
  const values = rows.map(row => row[key]).filter(value => value != null && Number.isFinite(Number(value))).map(Number);
  return values.length ? Math.min(...values) : null;
}

function round(value, digits = 1) {
  return value == null ? null : Number(value.toFixed(digits));
}

function confidenceOf(rows) {
  if (!rows.length) return { level: 'low', name: '低', score: 0 };
  const weights = { high: 1, medium: 0.65, low: 0.25 };
  const score = rows.reduce((sum, row) => sum + weights[row.confidence], 0) / rows.length;
  const level = score >= 0.85 ? 'high' : score >= 0.55 ? 'medium' : 'low';
  return { level, name: CONFIDENCE_NAMES[level], score: round(score * 100, 0) };
}

function getAnalysis(stayDate) {
  const competitors = db.prepare('SELECT * FROM competitors WHERE active = 1 ORDER BY id').all();
  const observations = db.prepare(`SELECT o.*, c.name AS competitor_name, s.name AS source_name, s.type AS source_type
    FROM competitor_observations o JOIN competitors c ON c.id = o.competitor_id JOIN data_sources s ON s.id = o.source_id
    WHERE o.stay_date = ? AND c.active = 1 ORDER BY c.id, o.channel, o.room_type`).all(stayDate);
  const own = db.prepare('SELECT AVG(price) AS average_price FROM mock_ota_state WHERE biz_date = ? AND on_sale = 1').get(stayDate);
  const ownAveragePrice = round(own.average_price);

  const benchmarks = competitors.map(competitor => {
    const rows = observations.filter(row => row.competitor_id === competitor.id);
    const averagePrice = round(average(rows, 'price'));
    const soldOutRows = rows.filter(row => row.sold_out != null);
    const soldOutRate = soldOutRows.length ? round(soldOutRows.filter(row => row.sold_out).length / soldOutRows.length * 100, 0) : null;
    return {
      id: competitor.id,
      name: competitor.name,
      segment: competitor.segment,
      distanceKm: competitor.distance_km,
      averagePrice,
      priceDifference: averagePrice == null || ownAveragePrice == null ? null : round(ownAveragePrice - averagePrice),
      marketPriceIndex: averagePrice && ownAveragePrice ? round(ownAveragePrice / averagePrice * 100) : null,
      soldOutRate,
      rating: round(average(rows, 'rating')),
      reviewCount: rows.length ? Math.max(...rows.map(row => row.review_count || 0)) : null,
      bestSearchRank: minimum(rows, 'search_rank'),
      promotions: [...new Set(rows.map(row => row.promotion).filter(Boolean))],
      sources: [...new Set(rows.map(row => row.source_name))],
      confidence: confidenceOf(rows),
      observedAt: rows.length ? rows.map(row => row.observed_at).sort().at(-1) : null,
      unknown: ['真实 PMS 入住率', '实际 ADR', '实际 RevPAR'],
    };
  });

  const channelAnalysis = competitors.flatMap(competitor => CHANNELS.map(channel => {
    const rows = observations.filter(row => row.competitor_id === competitor.id && row.channel === channel);
    const soldOutRows = rows.filter(row => row.sold_out != null);
    return {
      competitorId: competitor.id,
      competitor: competitor.name,
      channel,
      averagePrice: round(average(rows, 'price')),
      bestSearchRank: minimum(rows, 'search_rank'),
      soldOutRate: soldOutRows.length ? round(soldOutRows.filter(row => row.sold_out).length / soldOutRows.length * 100, 0) : null,
      promotions: [...new Set(rows.map(row => row.promotion).filter(Boolean))],
      confidence: confidenceOf(rows),
    };
  }));

  const trends = db.prepare(`SELECT c.id AS competitor_id, c.name AS competitor, o.stay_date,
      ROUND(AVG(o.price), 1) AS average_price, COUNT(o.id) AS samples
    FROM competitor_observations o JOIN competitors c ON c.id = o.competitor_id
    WHERE o.stay_date BETWEEN date(?, '-13 days') AND date(?, '+13 days')
    GROUP BY c.id, o.stay_date ORDER BY o.stay_date, c.id`).all(stayDate, stayDate);
  const research = db.prepare(`SELECT r.*, c.name AS competitor_name, u.display_name AS created_by_name
    FROM field_research r JOIN competitors c ON c.id = r.competitor_id LEFT JOIN users u ON u.id = r.created_by
    ORDER BY r.research_date DESC, r.id DESC LIMIT 20`).all();
  const events = db.prepare(`SELECT e.*, s.name AS source_name FROM market_events e
    LEFT JOIN data_sources s ON s.id = e.source_id WHERE e.end_date >= date('now', 'localtime')
    ORDER BY e.start_date LIMIT 20`).all();
  const sources = db.prepare(`SELECT s.*, COUNT(o.id) AS record_count FROM data_sources s
    LEFT JOIN competitor_observations o ON o.source_id = s.id AND o.stay_date = ?
    WHERE s.active = 1 GROUP BY s.id ORDER BY s.id`).all(stayDate);
  const knowledge = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status IN ('confirmed','rolled_back') THEN 1 ELSE 0 END) AS adopted,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN execute_ok = 1 THEN 1 ELSE 0 END) AS executed,
      SUM(CASE WHEN status = 'rolled_back' THEN 1 ELSE 0 END) AS rolled_back
    FROM suggestions`).get();
  const decided = (knowledge.adopted || 0) + (knowledge.rejected || 0);

  const expected = competitors.length * CHANNELS.length * ROOM_TYPES.length;
  const highConfidence = observations.filter(row => row.confidence === 'high').length;
  return {
    stayDate,
    ownAveragePrice,
    benchmarks,
    channelAnalysis,
    trends,
    research,
    events,
    sources,
    coverage: {
      expected,
      observed: observations.length,
      percent: expected ? round(observations.length / expected * 100) : 0,
      highConfidencePercent: observations.length ? round(highConfidence / observations.length * 100, 0) : 0,
      lastObservedAt: observations.length ? observations.map(row => row.observed_at).sort().at(-1) : null,
    },
    knowledge: { ...knowledge, adoptionRate: decided ? round((knowledge.adopted || 0) / decided * 100, 0) : null },
    methodology: {
      marketPriceIndex: '本店 OTA 平均展示价 ÷ 竞对可比平均展示价 × 100；大于 100 表示本店价格更高',
      soldOutRate: '本次竞对 OTA 观察样本中显示满房的比例，不代表真实 PMS 入住率',
      confidence: '高=100，中=65，低=25，按当前样本计算加权平均值',
      unknown: '未获取的竞对 PMS 数据保持未知，不用 OTA 房态或主观推算替代',
    },
  };
}

function addResearch(user, input) {
  const { competitorId, researchDate, topic, finding, evidenceRef = null, confidence = 'medium', dataKind = 'fact' } = input;
  const competitor = db.prepare('SELECT id, name FROM competitors WHERE id = ? AND active = 1').get(competitorId);
  if (!competitor) return { error: '竞对酒店不存在' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(researchDate || '')) return { error: '调研日期无效' };
  if (!String(topic || '').trim() || !String(finding || '').trim()) return { error: '调研主题和结论不能为空' };
  if (!['high', 'medium', 'low'].includes(confidence)) return { error: '置信度无效' };
  if (!['fact', 'estimate', 'unknown'].includes(dataKind)) return { error: '数据性质无效' };
  const info = db.prepare(`INSERT INTO field_research
    (competitor_id, research_date, topic, finding, evidence_ref, confidence, data_kind, created_by)
    VALUES (?,?,?,?,?,?,?,?)`).run(competitor.id, researchDate, String(topic).trim(), String(finding).trim(),
    evidenceRef ? String(evidenceRef).trim() : null, confidence, dataKind, user.id);
  audit.audit({
    actorId: user.id, actorName: user.display_name, action: 'competitor_research',
    objectType: 'field_research', objectId: info.lastInsertRowid,
    after: { competitor: competitor.name, researchDate, topic, confidence, dataKind },
    detail: `录入竞对调研：${competitor.name} / ${topic}`,
  });
  return { ok: true, id: Number(info.lastInsertRowid) };
}

module.exports = { getAnalysis, addResearch };
