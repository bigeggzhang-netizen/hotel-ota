'use strict';

const state = { me: null, tab: 'dashboard' };
const app = document.querySelector('#app');
const title = document.querySelector('#page-title');
const ROLE_NAMES = { manager: '管理者', revenue: '收益经理', frontdesk: '前台值班', service: '客服/点评专员', viewer: '只读/老板' };
const ACTION_NAMES = { open_room: '开房', close_room: '关房', adjust_inventory: '调整房量', adjust_price: '调价', online: '上架', offline: '下架' };
const STATUS_NAMES = { pending: '待确认', confirmed: '已确认', rejected: '已驳回', expired: '已过期', rolled_back: '已回滚', open: '未处理', handled: '已处理', ignored: '已忽略' };
const LEVEL_NAMES = { critical: '紧急', major: '重要', minor: '提示', urgent: '紧急', important: '重要', normal: '普通' };
const RULE_NAMES = {
  price_diff_pct: '渠道价差阈值（%）', price_diff_abs: '渠道价差阈值（元）', comp_change_pct: '竞对调价阈值（%）',
  occupancy_high: '入住率提醒（%）', order_timeout_min: '订单超时（分钟）', urgent_wait_min: '紧急确认等待（分钟）',
  important_wait_min: '重要确认等待（分钟）', emergency_close_enabled: '超售自动关房（1 开 / 0 关）',
};

function can(permission) { return state.me.perms.includes(permission); }
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function fmt(value) { return value ? String(value).replace('T', ' ').replace(/\.\d{3}Z$/, '') : '—'; }
function badge(value, type = 'status') {
  const text = type === 'action' ? ACTION_NAMES[value] : type === 'level' ? LEVEL_NAMES[value] : STATUS_NAMES[value];
  return `<span class="badge ${esc(value)}">${esc(text || value)}</span>`;
}
function toast(message, isError = false) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = 'toast'; }, 3500);
}
async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: {}, ...options };
  if (options.body && typeof options.body !== 'string') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  if (response.status === 401) { window.location.replace('/login.html'); throw new Error('请重新登录'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
  return result;
}
function empty(text) { return `<div class="empty">${esc(text)}</div>`; }
function loading() { app.innerHTML = '<div class="panel empty">正在加载…</div>'; }

function renderNav() {
  const tabs = [
    ['dashboard', '总览', true],
    ['suggestions', '待确认建议', can('dashboard:view')],
    ['alerts', '告警中心', can('alert:handle') || can('alert:handle:order') || can('alert:handle:review')],
    ['users', '账户与权限', can('user:manage')],
    ['rules', '规则设置', can('dashboard:view')],
    ['audit', '操作审计', can('audit:view')],
  ].filter(tab => tab[2]);
  document.querySelector('#main-nav').innerHTML = tabs.map(([id, name]) =>
    `<button data-tab="${id}" class="${state.tab === id ? 'active' : ''}">${name}</button>`).join('');
}

async function showTab(tab) {
  state.tab = tab;
  renderNav();
  title.textContent = { dashboard: '总览', suggestions: '建议与确认', alerts: '告警中心', users: '账户与权限', rules: '规则设置', audit: '操作审计' }[tab];
  loading();
  try {
    if (tab === 'dashboard') await renderDashboard();
    if (tab === 'suggestions') await renderSuggestions();
    if (tab === 'alerts') await renderAlerts();
    if (tab === 'users') await renderUsers();
    if (tab === 'rules') await renderRules();
    if (tab === 'audit') await renderAudit();
  } catch (error) {
    app.innerHTML = `<div class="panel error">${esc(error.message)}</div>`;
  }
}

async function renderDashboard() {
  const requests = [api('/api/data/dashboard')];
  const detailed = can('monitor:view') || can('monitor:room');
  requests.push(detailed ? api('/api/data/inventory') : Promise.resolve([]));
  requests.push(detailed ? api('/api/data/orders') : Promise.resolve([]));
  requests.push(can('monitor:view') || can('monitor:review') ? api('/api/data/reviews') : Promise.resolve([]));
  requests.push(can('monitor:view') ? api('/api/data/competitors') : Promise.resolve([]));
  const [data, inventory, orders, reviews, competitors] = await Promise.all(requests);
  app.innerHTML = `
    <section class="grid cards">
      <div class="panel"><p class="muted">待确认建议</p><div class="metric">${data.pendingSuggestions}</div><small>需要人工把关</small></div>
      <div class="panel"><p class="muted">紧急告警</p><div class="metric critical">${data.openAlerts.critical}</div><small>优先处理</small></div>
      <div class="panel"><p class="muted">重要告警</p><div class="metric major">${data.openAlerts.major}</div><small>今日待办</small></div>
      <div class="panel"><p class="muted">今日订单</p><div class="metric">${data.today.orders}</div><small>均价 ${data.today.averagePrice == null ? '—' : '¥' + data.today.averagePrice}</small></div>
    </section>
    <section class="panel"><div class="panel-heading"><h2>渠道连接</h2><span class="muted">${esc(data.today.date)}</span></div>
      <div class="channel-list">${data.channels.map(row => `<div class="channel"><span class="dot"></span><strong>${esc(row.channel)}</strong><span class="muted">${esc(row.mode)}</span></div>`).join('')}</div>
    </section>
    ${detailed ? `<section class="panel"><div class="panel-heading"><h2>房态与渠道价格</h2><span class="muted">最近 ${Math.min(inventory.length, 12)} 条</span></div>
      <div class="table-wrap"><table><thead><tr><th>日期</th><th>房型</th><th>PMS 可售</th><th>维修房</th><th>渠道状态</th></tr></thead><tbody>
      ${inventory.slice(0, 12).map(row => `<tr><td>${esc(row.biz_date)}</td><td>${esc(row.room_type)}</td><td>${row.total_rooms - row.ooo_rooms}</td><td>${row.ooo_rooms}</td><td>${Object.entries(row.channels).map(([channel, value]) => `<small>${esc(channel)} ${value.onSale ? '在售' : '关房'} · ¥${value.price} · ${value.stock} 间</small>`).join('<br>') || '—'}</td></tr>`).join('')}
      </tbody></table></div></section>` : ''}
    <div class="grid two-col">
      ${detailed ? `<section class="panel"><div class="panel-heading"><h2>最新订单</h2><span class="muted">客人信息已脱敏</span></div>${orders.length ? `<div class="table-wrap"><table><thead><tr><th>渠道</th><th>房型</th><th>客人</th><th>状态</th><th>创建时间</th></tr></thead><tbody>${orders.slice(0, 8).map(row => `<tr><td>${esc(row.channel)}</td><td>${esc(row.room_type)}</td><td>${esc(row.guest)}</td><td>${row.status === 'confirmed' ? '已确认' : '待确认'}</td><td>${fmt(row.created_at)}</td></tr>`).join('')}</tbody></table></div>` : empty('暂无订单')}</section>` : ''}
      ${can('monitor:view') || can('monitor:review') ? `<section class="panel"><div class="panel-heading"><h2>最新评价</h2><span class="muted">平均 ${data.today.averageRating ?? '—'} 分</span></div>${reviews.length ? `<div class="table-wrap"><table><thead><tr><th>渠道</th><th>评分</th><th>评价</th><th>时间</th></tr></thead><tbody>${reviews.slice(0, 8).map(row => `<tr><td>${esc(row.channel)}</td><td>${row.rating} 分</td><td>${esc(row.content)}</td><td>${fmt(row.created_at)}</td></tr>`).join('')}</tbody></table></div>` : empty('暂无评价')}</section>` : ''}
    </div>
    ${competitors.length ? `<section class="panel"><div class="panel-heading"><h2>竞对今日价格</h2></div><div class="channel-list">${competitors.map(row => `<div class="channel"><strong>${esc(row.competitor)}</strong><span>${row.price == null ? '—' : '¥' + row.price}</span>${row.soldOut ? badge('critical', 'level') : ''}</div>`).join('')}</div></section>` : ''}`;
}

async function renderSuggestions() {
  const rows = await api('/api/suggestions');
  const canCreate = can('suggest:create');
  const canConfirm = can('suggest:confirm') || can('suggest:confirm:limited');
  app.innerHTML = `
    ${canCreate ? `<section class="panel"><div class="panel-heading"><h2>发起申请</h2><span class="muted">提交后仍需有确认权的账户审批</span></div>
      <form id="suggestion-form" class="form-grid">
        <label>动作<select name="action"><option value="adjust_price">调价</option><option value="adjust_inventory">调整房量</option><option value="open_room">开房</option><option value="close_room">关房</option><option value="online">上架</option><option value="offline">下架</option></select></label>
        <label>渠道<select name="channel"><option value="">全部渠道</option><option>携程</option><option>美团</option><option>飞猪</option></select></label>
        <label>房型<select name="roomType"><option>大床房</option><option>双床房</option><option>家庭房</option></select></label>
        <label>日期<input name="bizDate" type="date" value="${new Date().toISOString().slice(0, 10)}" required></label>
        <label>调整值<input name="afterValue" placeholder="如 439；开房/关房填写状态" required></label>
        <label>原因<input name="reason" placeholder="申请原因" required></label>
        <button class="primary" type="submit">提交申请</button>
      </form></section>` : ''}
    <section class="panel"><div class="panel-heading"><h2>建议记录</h2><span class="muted">收益经理单次调价限额 ±15%</span></div>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>ID / 状态</th><th>动作</th><th>渠道 / 房型 / 日期</th><th>调整前 → 调整后</th><th>原因</th><th>执行结果</th><th>操作</th></tr></thead><tbody>
      ${rows.map(row => `<tr><td>#${row.id} ${badge(row.status)}<br>${badge(row.urgency, 'level')}</td><td>${badge(row.action, 'action')}</td><td>${esc(row.channel || '全部渠道')}<br><small>${esc(row.room_type)} · ${esc(row.biz_date)}</small></td><td>${esc(row.before_value ?? '—')} → <strong>${esc(row.after_value)}</strong></td><td>${esc(row.reason)}<br><small>${esc(row.created_by)} · ${fmt(row.created_at)}</small></td><td>${row.execute_ok == null ? '—' : row.execute_ok ? badge('execute_ok') + ' 回读一致' : '执行失败'}<br><small>${esc(row.execute_detail || '')}</small></td><td><div class="actions">
        ${canConfirm && row.status === 'pending' ? `<button class="primary" data-action="confirm" data-id="${row.id}" data-value="${esc(row.after_value)}">确认</button><button data-action="reject" data-id="${row.id}">驳回</button>` : ''}
        ${can('suggest:confirm') && row.status === 'confirmed' && row.execute_ok === 1 ? `<button class="danger" data-action="rollback" data-id="${row.id}">回滚</button>` : ''}
      </div></td></tr>`).join('')}</tbody></table></div>` : empty('暂无建议')}</section>`;
  if (canCreate) document.querySelector('#suggestion-form').addEventListener('submit', createSuggestion);
}

async function createSuggestion(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target));
  try {
    await api('/api/suggestions', { method: 'POST', body });
    toast('申请已提交，等待确认');
    await renderSuggestions();
  } catch (error) { toast(error.message, true); }
}

async function renderAlerts() {
  const rows = await api('/api/alerts');
  app.innerHTML = `<section class="panel"><div class="panel-heading"><h2>告警闭环</h2><span class="muted">忽略必须填写原因</span></div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>级别 / 状态</th><th>告警</th><th>渠道</th><th>创建时间</th><th>处理记录</th><th>操作</th></tr></thead><tbody>
    ${rows.map(row => `<tr><td>${badge(row.level, 'level')} ${badge(row.status)}</td><td><strong>${esc(row.title)}</strong><br><small>${esc(row.detail || row.type)}</small></td><td>${esc(row.channel || '全部')}</td><td>${fmt(row.created_at)}</td><td>${fmt(row.handled_at)}<br><small>${esc(row.handle_note || '')}</small></td><td>${row.status === 'open' ? `<div class="actions"><button class="primary" data-action="handle-alert" data-id="${row.id}">已处理</button><button data-action="ignore-alert" data-id="${row.id}">忽略</button></div>` : '—'}</td></tr>`).join('')}
    </tbody></table></div>` : empty('暂无告警')}</section>`;
}

async function renderUsers() {
  const [users, delegates] = await Promise.all([api('/api/admin/users'), api('/api/admin/delegates')]);
  const activeUsers = users.filter(user => user.active && user.id !== state.me.user.id);
  app.innerHTML = `
    <section class="panel"><div class="panel-heading"><h2>新建账户</h2><span class="muted">密码至少 6 位</span></div>
      <form id="user-form" class="form-grid">
        <label>登录名<input name="username" required></label><label>姓名<input name="displayName" required></label>
        <label>初始密码<input name="password" type="password" minlength="6" required></label>
        <label>角色<select name="role">${Object.entries(ROLE_NAMES).map(([key, name]) => `<option value="${key}">${name}</option>`).join('')}</select></label>
        <label>手机号<input name="phone" type="tel"></label>
        <label>授权渠道<select name="channel"><option value="">默认 / 全部</option><option>携程</option><option>美团</option><option>飞猪</option></select></label>
        <button class="primary" type="submit">创建账户</button>
      </form></section>
    <section class="panel"><div class="panel-heading"><h2>账户列表</h2><span class="muted">受限角色按门店和渠道授权</span></div>
      <div class="table-wrap"><table><thead><tr><th>账户</th><th>角色</th><th>门店 / 渠道</th><th>启用</th><th>操作</th></tr></thead><tbody>
      ${users.map(user => `<tr data-user-row="${user.id}"><td><strong>${esc(user.display_name)}</strong><br><small>${esc(user.username)} · ${esc(user.phone || '无手机号')}</small></td><td><select class="user-role" data-user-role>${Object.entries(ROLE_NAMES).map(([key, name]) => `<option value="${key}" ${user.role === key ? 'selected' : ''}>${name}</option>`).join('')}</select></td><td>总店<br><input data-user-channels value="${esc(user.channels || '')}" placeholder="携程,美团,飞猪"></td><td><input data-user-active type="checkbox" ${user.active ? 'checked' : ''}></td><td><div class="actions"><button data-action="save-user" data-id="${user.id}">保存</button><button data-action="reset-password" data-id="${user.id}">重置密码</button></div></td></tr>`).join('')}
      </tbody></table></div></section>
    <section class="panel"><div class="panel-heading"><h2>代理审批人</h2><span class="muted">在指定时间段内授予完整确认权</span></div>
      <form id="delegate-form" class="form-grid"><label>代理人<select name="delegateId">${activeUsers.map(user => `<option value="${user.id}">${esc(user.display_name)}（${esc(ROLE_NAMES[user.role])}）</option>`).join('')}</select></label><label>开始时间<input name="startAt" type="datetime-local" required></label><label>结束时间<input name="endAt" type="datetime-local" required></label><button class="primary" type="submit">授予权限</button></form>
      <div class="table-wrap"><table><thead><tr><th>管理者</th><th>代理人</th><th>开始</th><th>结束</th><th>操作</th></tr></thead><tbody>${delegates.map(row => `<tr><td>${esc(row.manager_name)}</td><td>${esc(row.delegate_name)}</td><td>${fmt(row.start_at)}</td><td>${fmt(row.end_at)}</td><td><button data-action="revoke-delegate" data-id="${row.id}">撤销</button></td></tr>`).join('')}</tbody></table></div>
    </section>`;
  document.querySelector('#user-form').addEventListener('submit', createUser);
  document.querySelector('#delegate-form').addEventListener('submit', createDelegate);
}

async function createUser(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const body = { ...data, storeIds: [1], channels: data.channel ? [data.channel] : [] };
  delete body.channel;
  try { await api('/api/admin/users', { method: 'POST', body }); toast('账户已创建'); await renderUsers(); }
  catch (error) { toast(error.message, true); }
}
async function createDelegate(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  try {
    await api('/api/admin/delegates', { method: 'POST', body: { delegateId: Number(data.delegateId), startAt: new Date(data.startAt).toISOString(), endAt: new Date(data.endAt).toISOString() } });
    toast('代理审批权限已授予'); await renderUsers();
  } catch (error) { toast(error.message, true); }
}

async function renderRules() {
  const rows = await api('/api/rules');
  const editable = can('rule:edit');
  app.innerHTML = `<section class="panel"><div class="panel-heading"><h2>监控阈值与价格护栏</h2><span class="muted">每次修改都会写入审计日志</span></div>
    <p class="section-note">底价和封顶价仅管理者可修改；超售自动关房是唯一允许自动写入的动作。</p>
    <div class="table-wrap"><table><thead><tr><th>规则</th><th>键</th><th>当前值</th><th>操作</th></tr></thead><tbody>
    ${Object.entries(rows).map(([key, value]) => {
      const guardrail = key.startsWith('floor_price_') || key.startsWith('ceiling_price_');
      const allowed = editable && (!guardrail || can('rule:edit:guardrail'));
      const name = RULE_NAMES[key] || `${key.startsWith('floor_price_') ? '底价' : '封顶价'} · ${key.replace(/^(floor_price_|ceiling_price_)/, '')}`;
      return `<tr><td>${esc(name)}${guardrail ? ' <span class="badge">价格护栏</span>' : ''}</td><td class="rule-key">${esc(key)}</td><td><input data-rule-value="${esc(key)}" type="number" min="0" step="any" value="${esc(value)}" ${allowed ? '' : 'disabled'}></td><td><button data-action="save-rule" data-key="${esc(key)}" ${allowed ? '' : 'disabled'}>保存</button></td></tr>`;
    }).join('')}</tbody></table></div></section>`;
}

async function renderAudit() {
  const rows = await api('/api/audit');
  app.innerHTML = `<section class="panel"><div class="panel-heading"><h2>不可删除的操作记录</h2><span class="muted">最近 ${rows.length} 条</span></div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th><th>前后值</th></tr></thead><tbody>
    ${rows.map(row => `<tr><td>${fmt(row.created_at)}</td><td>${esc(row.actor_name || row.actor_id || 'system')}</td><td><span class="badge">${esc(row.action)}</span></td><td>${esc(row.object_type || '—')} ${esc(row.object_id || '')}</td><td>${esc(row.detail || '')}</td><td><small>${esc(row.before_json || '—')}<br>${esc(row.after_json || '—')}</small></td></tr>`).join('')}
    </tbody></table></div>` : empty('暂无审计记录')}</section>`;
}

async function handleAction(button) {
  const action = button.dataset.action;
  const id = Number(button.dataset.id);
  try {
    if (action === 'confirm') {
      const finalValue = window.prompt('确认调整值（可直接修改）', button.dataset.value);
      if (finalValue == null) return;
      const otp = window.prompt('请输入二次验证口令（本地演示为 1234）');
      if (otp == null) return;
      const result = await api(`/api/suggestions/${id}/confirm`, { method: 'POST', body: { finalValue, otp } });
      toast(result.detail || '操作已执行'); await renderSuggestions();
    }
    if (action === 'reject') {
      const reason = window.prompt('请输入驳回原因');
      if (!reason) return;
      await api(`/api/suggestions/${id}/reject`, { method: 'POST', body: { reason } });
      toast('建议已驳回'); await renderSuggestions();
    }
    if (action === 'rollback') {
      if (!window.confirm('确认恢复到调整前的快照？')) return;
      const otp = window.prompt('请输入二次验证口令');
      if (otp == null) return;
      const result = await api(`/api/suggestions/${id}/rollback`, { method: 'POST', body: { otp } });
      toast(result.detail || '回滚完成'); await renderSuggestions();
    }
    if (action === 'handle-alert') {
      await api(`/api/alerts/${id}/handle`, { method: 'POST', body: { note: '已在控制台处理' } });
      toast('告警已处理'); await renderAlerts();
    }
    if (action === 'ignore-alert') {
      const reason = window.prompt('请输入忽略原因');
      if (!reason) return;
      await api(`/api/alerts/${id}/ignore`, { method: 'POST', body: { reason } });
      toast('告警已忽略'); await renderAlerts();
    }
    if (action === 'save-user') {
      const row = button.closest('tr');
      const channels = row.querySelector('[data-user-channels]').value.split(',').map(value => value.trim()).filter(Boolean);
      await api(`/api/admin/users/${id}`, { method: 'PUT', body: { role: row.querySelector('[data-user-role]').value, active: row.querySelector('[data-user-active]').checked ? 1 : 0, channels, storeIds: [1] } });
      toast('账户权限已保存'); await renderUsers();
    }
    if (action === 'reset-password') {
      const password = window.prompt('请输入新密码（至少 6 位），重置后该账户将强制下线');
      if (!password) return;
      await api(`/api/admin/users/${id}`, { method: 'PUT', body: { password } });
      toast('密码已重置'); await renderUsers();
    }
    if (action === 'revoke-delegate') {
      await api(`/api/admin/delegates/${id}`, { method: 'DELETE' });
      toast('代理权限已撤销'); await renderUsers();
    }
    if (action === 'save-rule') {
      const value = document.querySelector(`[data-rule-value="${CSS.escape(button.dataset.key)}"]`).value;
      await api('/api/rules', { method: 'PUT', body: { key: button.dataset.key, value } });
      toast('规则已更新'); await renderRules();
    }
  } catch (error) { toast(error.message, true); }
}

async function init() {
  try {
    state.me = await api('/api/auth/me');
    document.querySelector('#current-user').textContent = `${state.me.user.displayName} · ${state.me.roleName}${state.me.delegateFor ? ' · 代理审批中' : ''}`;
    document.querySelector('#main-nav').addEventListener('click', event => {
      const button = event.target.closest('[data-tab]');
      if (button) showTab(button.dataset.tab);
    });
    document.querySelector('#refresh').addEventListener('click', () => showTab(state.tab));
    document.querySelector('#logout').addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' });
      window.location.replace('/login.html');
    });
    app.addEventListener('click', event => {
      const button = event.target.closest('[data-action]');
      if (button) handleAction(button);
    });
    await showTab('dashboard');
  } catch (error) { toast(error.message, true); }
}

init();
