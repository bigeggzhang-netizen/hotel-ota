'use strict';

const SOURCE_TYPE_NAMES = { commercial: '外购商用数据库', internal: '自有知识库', research: '一手调研', public: '公开宏观数据' };
const DATA_KIND_NAMES = { fact: '事实', estimate: '推算', unknown: '未知' };

async function renderCompetitorAnalysis(stayDate = null) {
  const data = await api(`/api/competitors/analysis${stayDate ? `?stayDate=${encodeURIComponent(stayDate)}` : ''}`);
  const trendDates = [...new Set(data.trends.map(row => row.stay_date))].sort();
  app.innerHTML = `
    <section class="panel"><div class="panel-heading"><h2>竞对经营情报</h2><form id="competitor-date-form" class="inline-form"><input name="stayDate" type="date" value="${esc(data.stayDate)}"><button type="submit">切换日期</button></form></div>
      <p class="section-note">仅比较 OTA 可比展示数据。竞对真实 PMS 入住率、ADR、RevPAR 未获取时保持未知，不用满房状态替代。</p>
      <div class="grid cards">
        <div class="panel"><p class="muted">本店平均展示价</p><div class="metric">${data.ownAveragePrice == null ? '—' : '¥' + data.ownAveragePrice}</div><small>当前所选日期</small></div>
        <div class="panel"><p class="muted">观察覆盖率</p><div class="metric">${data.coverage.percent}%</div><small>${data.coverage.observed} / ${data.coverage.expected} 个样本</small></div>
        <div class="panel"><p class="muted">高置信度样本</p><div class="metric">${data.coverage.highConfidencePercent}%</div><small>来源与置信度逐条留痕</small></div>
        <div class="panel"><p class="muted">内部建议采纳率</p><div class="metric">${data.knowledge.adoptionRate == null ? '—' : data.knowledge.adoptionRate + '%'}</div><small>采纳 ${data.knowledge.adopted || 0} · 驳回 ${data.knowledge.rejected || 0} · 回滚 ${data.knowledge.rolled_back || 0}</small></div>
      </div>
    </section>
    <section class="panel"><div class="panel-heading"><h2>行业对标总览</h2><span class="muted">价格指数大于 100 表示本店更贵</span></div>
      <div class="table-wrap"><table><thead><tr><th>竞对酒店</th><th>均价 / 与本店差额</th><th>市场价格指数</th><th>满房样本比例</th><th>评分 / 点评量</th><th>最佳排名</th><th>促销</th><th>置信度</th><th>未知数据</th></tr></thead><tbody>
      ${data.benchmarks.map(row => `<tr><td><strong>${esc(row.name)}</strong><br><small>${esc(row.segment)} · ${row.distanceKm} km</small></td><td>${row.averagePrice == null ? '—' : '¥' + row.averagePrice}<br><small>${row.priceDifference == null ? '无比价' : `本店 ${row.priceDifference >= 0 ? '+' : ''}¥${row.priceDifference}`}</small></td><td>${row.marketPriceIndex ?? '—'}</td><td>${row.soldOutRate == null ? '未知' : row.soldOutRate + '%'}<br><small>不等于 PMS 入住率</small></td><td>${row.rating ?? '—'} 分 / ${row.reviewCount ?? '—'}</td><td>${row.bestSearchRank ?? '—'}</td><td>${row.promotions.map(esc).join('<br>') || '—'}</td><td><span class="badge">${row.confidence.name} ${row.confidence.score}</span><br><small>${row.sources.map(esc).join('、') || '无来源'}</small></td><td><small>${row.unknown.map(esc).join('<br>')}</small></td></tr>`).join('')}
      </tbody></table></div></section>
    <section class="panel"><div class="panel-heading"><h2>渠道全板块分析</h2><span class="muted">价格、满房、排名、促销和来源置信度</span></div>
      <div class="table-wrap"><table><thead><tr><th>竞对</th><th>渠道</th><th>平均展示价</th><th>最佳搜索排名</th><th>满房样本比例</th><th>促销活动</th><th>置信度</th></tr></thead><tbody>
      ${data.channelAnalysis.map(row => `<tr><td>${esc(row.competitor)}</td><td>${esc(row.channel)}</td><td>${row.averagePrice == null ? '未知' : '¥' + row.averagePrice}</td><td>${row.bestSearchRank ?? '未知'}</td><td>${row.soldOutRate == null ? '未知' : row.soldOutRate + '%'}</td><td>${row.promotions.map(esc).join('<br>') || '—'}</td><td>${row.confidence.name} ${row.confidence.score}</td></tr>`).join('')}
      </tbody></table></div></section>
    <section class="panel"><div class="panel-heading"><h2>竞对价格趋势</h2><span class="muted">前后 27 天历史快照，样本不足时留空</span></div>
      <div class="table-wrap"><table><thead><tr><th>适用日期</th>${data.benchmarks.map(row => `<th>${esc(row.name)}</th>`).join('')}</tr></thead><tbody>
      ${trendDates.map(date => `<tr><td>${esc(date)}</td>${data.benchmarks.map(competitor => { const point = data.trends.find(row => row.competitor_id === competitor.id && row.stay_date === date); return `<td>${point ? '¥' + point.average_price + `<br><small>${point.samples} 个样本</small>` : '未知'}</td>`; }).join('')}</tr>`).join('')}
      </tbody></table></div></section>
    <div class="grid two-col">
      <section class="panel"><div class="panel-heading"><h2>公开宏观与商圈事件</h2></div>
        ${data.events.length ? data.events.map(row => `<div class="channel"><strong>${esc(row.name)}</strong><span>${esc(row.start_date)} 至 ${esc(row.end_date)}</span><span class="badge ${row.impact === 'high' ? 'major' : ''}">${row.impact === 'high' ? '高影响' : row.impact === 'medium' ? '中影响' : '低影响'}</span><small>${esc(row.detail)} · 来源：${esc(row.source_name || '未知')}</small></div>`).join('') : empty('暂无宏观事件')}
      </section>
      <section class="panel"><div class="panel-heading"><h2>数据源与授权</h2></div>
        <div class="table-wrap"><table><thead><tr><th>来源</th><th>类型</th><th>当前记录</th><th>授权与说明</th></tr></thead><tbody>${data.sources.map(row => `<tr><td>${esc(row.name)}</td><td>${esc(SOURCE_TYPE_NAMES[row.type] || row.type)}</td><td>${row.record_count}</td><td><small>${esc(row.license_note || '—')}</small></td></tr>`).join('')}</tbody></table></div>
      </section>
    </div>
    ${can('competitor:research') ? `<section class="panel"><div class="panel-heading"><h2>录入一手调研</h2><span class="muted">事实、推算和未知必须分开</span></div>
      <form id="research-form" class="form-grid"><label>竞对酒店<select name="competitorId">${data.benchmarks.map(row => `<option value="${row.id}">${esc(row.name)}</option>`).join('')}</select></label><label>调研日期<input name="researchDate" type="date" value="${new Date().toISOString().slice(0, 10)}" required></label><label>主题<input name="topic" placeholder="设施、客群、服务等" required></label><label>数据性质<select name="dataKind"><option value="fact">事实</option><option value="estimate">推算</option><option value="unknown">未知</option></select></label><label>置信度<select name="confidence"><option value="high">高</option><option value="medium" selected>中</option><option value="low">低</option></select></label><label>证据引用<input name="evidenceRef" placeholder="访谈编号、附件路径等"></label><label>调研结论<input name="finding" required></label><button class="primary" type="submit">保存并留痕</button></form>
    </section>` : ''}
    <section class="panel"><div class="panel-heading"><h2>调研与内部知识库</h2><span class="muted">最近 ${data.research.length} 条</span></div>
      <div class="table-wrap"><table><thead><tr><th>日期</th><th>竞对</th><th>主题</th><th>结论</th><th>性质 / 置信度</th><th>证据与录入人</th></tr></thead><tbody>${data.research.map(row => `<tr><td>${esc(row.research_date)}</td><td>${esc(row.competitor_name)}</td><td>${esc(row.topic)}</td><td>${esc(row.finding)}</td><td>${esc(DATA_KIND_NAMES[row.data_kind])} / ${row.confidence === 'high' ? '高' : row.confidence === 'medium' ? '中' : '低'}</td><td>${esc(row.evidence_ref || '无附件')}<br><small>${esc(row.created_by_name || '系统种子')}</small></td></tr>`).join('')}</tbody></table></div>
    </section>
    <section class="panel"><h2>指标口径</h2><p class="muted">${esc(data.methodology.marketPriceIndex)}</p><p class="muted">${esc(data.methodology.soldOutRate)}</p><p class="muted">${esc(data.methodology.confidence)}</p><p class="error">${esc(data.methodology.unknown)}</p></section>`;
  document.querySelector('#competitor-date-form').addEventListener('submit', async event => {
    event.preventDefault();
    const date = new FormData(event.target).get('stayDate');
    loading();
    try { await renderCompetitorAnalysis(date); } catch (error) { toast(error.message, true); }
  });
  const researchForm = document.querySelector('#research-form');
  if (researchForm) researchForm.addEventListener('submit', async event => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target));
    body.competitorId = Number(body.competitorId);
    try {
      await api('/api/competitors/research', { method: 'POST', body });
      toast('调研已录入并写入审计日志');
      await renderCompetitorAnalysis(data.stayDate);
    } catch (error) { toast(error.message, true); }
  });
}
