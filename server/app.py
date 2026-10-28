#!/usr/bin/env python3
"""OTA 盯盘台 · 后台（演示版）

只用 Python 标准库。真实功能：账号与三种角色、登录会话、每个接口的权限检查、
确认上架/调价时的二次验证、只能追加不能修改的操作记录。
盯盘数据（房态、价格、订单、点评、竞对）仍是模拟的；以后接入选住云管家和各 OTA，
只替换「数据适配器」里的几个函数，账号和权限部分不用动。

用法：
  python3 app.py serve                       启动服务（由 systemd 调用）
  python3 app.py adduser 用户名 角色 姓名     新建账号并打印临时密码（角色：admin / front / viewer）
  python3 app.py resetpw 用户名               重置密码并解锁，打印临时密码
  python3 app.py users                       列出账号
"""
import copy
import hashlib
import hmac
import json
import math
import os
import random
import re
import secrets
import sqlite3
import sys
import threading
import time
import traceback
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

TZ = ZoneInfo('Asia/Shanghai')
HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get('OTA_DB', os.path.join(HERE, 'data', 'ota.db'))
HOST, PORT = '127.0.0.1', int(os.environ.get('OTA_PORT', '8001'))

IDLE_SEC = 2 * 3600          # 闲置 2 小时自动退出
MAX_AGE_SEC = 12 * 3600      # 一次登录最长 12 小时
MAX_FAIL, LOCK_SEC = 5, 15 * 60
IP_MAX_FAIL = 20             # 同一 IP 15 分钟内最多失败次数
MIN_PW_LEN = 8
COOKIE = 'ota_sid'

ROLES = {'admin': '管理者', 'front': '前台', 'viewer': '只读'}
PERMS = {
    'admin':  {'view', 'scan', 'alert', 'order', 'review', 'confirm', 'settings', 'log_all', 'users'},
    'front':  {'view', 'scan', 'alert', 'order', 'review', 'log_own'},
    'viewer': {'view'},
}

LOCK = threading.RLock()     # 演示规模很小，一把锁保护数据库和盯盘数据


class ApiError(Exception):
    def __init__(self, code, msg, **extra):
        super().__init__(msg)
        self.code, self.msg, self.extra = code, msg, extra


# ================= 数据库 =================
SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  role TEXT NOT NULL, pw TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 1,
  disabled INTEGER NOT NULL DEFAULT 0, fails INTEGER NOT NULL DEFAULT 0,
  locked_until REAL NOT NULL DEFAULT 0, created REAL NOT NULL, last_login REAL);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created REAL NOT NULL, seen REAL NOT NULL, ip TEXT);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY, time REAL NOT NULL, user_id INTEGER, actor TEXT NOT NULL,
  kind TEXT NOT NULL, action TEXT NOT NULL, target TEXT, before_v TEXT, after_v TEXT,
  result TEXT, ip TEXT, snap TEXT, rolled_back INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS audit_kind ON audit(kind, id);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
  BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_update
  BEFORE UPDATE OF id, time, user_id, actor, kind, action, target, before_v, after_v, result, ip, snap ON audit
  BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
"""
DB = None


def open_db():
    global DB
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    DB = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
    DB.row_factory = sqlite3.Row
    DB.execute('PRAGMA journal_mode=WAL')
    DB.executescript(SCHEMA)


def actor_name(user):
    return f"{user['name']}（{ROLES[user['role']]}）"


def audit(kind, action, user=None, actor=None, target='', before='', after='', result='', ip='', snap=None):
    """kind: ota = 写入渠道；ops = 日常处理；account = 登录与账号管理"""
    cur = DB.execute(
        'INSERT INTO audit(time,user_id,actor,kind,action,target,before_v,after_v,result,ip,snap) '
        'VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        (time.time(), user['id'] if user else None, actor or (actor_name(user) if user else '系统'), kind, action,
         target, before, after, result, ip, json.dumps(snap, ensure_ascii=False) if snap else None))
    return cur.lastrowid


# ================= 密码与会话 =================
def hash_pw(pw, salt=None):
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f'scrypt${salt.hex()}${dk.hex()}'


def check_pw(pw, stored):
    try:
        _, salt, _ = stored.split('$')
        return hmac.compare_digest(hash_pw(pw, bytes.fromhex(salt)), stored)
    except ValueError:
        return False


DUMMY_HASH = hash_pw(secrets.token_hex(8))   # 用户不存在时也算一次哈希，避免靠响应时间猜用户名


def temp_password():
    alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    return ''.join(secrets.choice(alphabet) for _ in range(12))


def tok_hash(t):
    return hashlib.sha256(t.encode()).hexdigest()


def new_session(uid, ip):
    t, now = secrets.token_urlsafe(32), time.time()
    DB.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', (tok_hash(t), uid, now, now, ip))
    return t


def session_user(token, touch=True):
    if not token:
        return None
    now = time.time()
    row = DB.execute(
        'SELECT s.token AS s_token, s.created AS s_created, s.seen AS s_seen, u.* '
        'FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', (tok_hash(token),)).fetchone()
    if not row:
        return None
    if row['disabled'] or now - row['s_seen'] > IDLE_SEC or now - row['s_created'] > MAX_AGE_SEC:
        DB.execute('DELETE FROM sessions WHERE token = ?', (row['s_token'],))
        return None
    if touch and now - row['s_seen'] > 30:
        DB.execute('UPDATE sessions SET seen = ? WHERE token = ?', (now, row['s_token']))
    return dict(row)


def kill_sessions(uid, keep=None):
    DB.execute('DELETE FROM sessions WHERE user_id = ? AND token IS NOT ?', (uid, keep))


def register_fail(u, ip):
    """密码错一次记一次；连续错满 MAX_FAIL 次锁定账号并踢掉所有登录。返回剩余次数。"""
    fails = u['fails'] + 1
    if fails >= MAX_FAIL:
        DB.execute('UPDATE users SET fails = 0, locked_until = ? WHERE id = ?', (time.time() + LOCK_SEC, u['id']))
        kill_sessions(u['id'])
        audit('account', '账号锁定', actor=f"{u['name']}（{u['username']}）", ip=ip,
              result=f'连续 {MAX_FAIL} 次密码错误，锁定 {LOCK_SEC // 60} 分钟')
        return 0
    DB.execute('UPDATE users SET fails = ? WHERE id = ?', (fails, u['id']))
    return MAX_FAIL - fails


IP_FAILS = {}


def ip_blocked(ip):
    cutoff = time.time() - LOCK_SEC
    IP_FAILS[ip] = [t for t in IP_FAILS.get(ip, []) if t > cutoff]
    return len(IP_FAILS[ip]) >= IP_MAX_FAIL


def verify_again(user, pw, ip):
    """确认上架、调价、回滚前再输一次登录密码。"""
    u = DB.execute('SELECT * FROM users WHERE id = ?', (user['id'],)).fetchone()
    if check_pw(str(pw or ''), u['pw']):
        DB.execute('UPDATE users SET fails = 0 WHERE id = ?', (u['id'],))
        return
    left = register_fail(u, ip)
    if not left:
        raise ApiError(401, '密码连续错误，账号已锁定，请联系其他管理者解锁')
    raise ApiError(403, f'登录密码不正确，还可以再试 {left} 次')


def me_payload(u):
    return {'id': u['id'], 'username': u['username'], 'name': u['name'], 'role': u['role'],
            'roleName': ROLES[u['role']], 'perms': sorted(PERMS[u['role']]), 'mustChange': bool(u['must_change'])}


# ================= 盯盘数据（模拟） =================
CH = [['ctrip', '携程'], ['meituan', '美团'], ['fliggy', '飞猪']]
CH_IDS = [c for c, _ in CH]
CH_NAME = dict(CH)
RT0 = [
    {'id': 'K', 'name': '高级大床房', 'total': 30, 'base': 398, 'floor': 328, 'cap': 688},
    {'id': 'T', 'name': '高级双床房', 'total': 25, 'base': 418, 'floor': 338, 'cap': 698},
    {'id': 'D', 'name': '豪华大床房', 'total': 15, 'base': 528, 'floor': 438, 'cap': 888},
    {'id': 'S', 'name': '行政套房', 'total': 6, 'base': 888, 'floor': 728, 'cap': 1588}]
DAYS = 14
THR0 = {'spreadPct': 3, 'spreadAbs': 10, 'reopenMin': 3, 'compPct': 10, 'urgentMin': 10, 'importantMin': 60,
        'autoCloseMin': 20, 'autoClose': True, 'orderMin': 10}
THR_LABEL = {'spreadPct': '渠道价差告警（%）', 'spreadAbs': '渠道价差告警（元）', 'reopenMin': '可售 ≥ N 间但关房时提醒',
             'compPct': '竞对调价幅度提醒（%）', 'urgentMin': '紧急建议等待（分钟）', 'importantMin': '重要建议等待（分钟）',
             'autoCloseMin': '超售无人确认自动关房（分钟）', 'orderMin': '订单待确认告警（分钟）', 'autoClose': '允许超售时紧急关房'}
COMPS0 = [
    {'name': '竞对 A · 同街精品酒店', 'dist': 0.4, 'y': 428, 't': 428, 'full': False},
    {'name': '竞对 B · 连锁中高端', 'dist': 0.9, 'y': 388, 't': 448, 'full': False},
    {'name': '竞对 C · 商务酒店', 'dist': 1.2, 'y': 358, 't': 358, 'full': False},
    {'name': '竞对 D · 设计酒店', 'dist': 1.8, 'y': 468, 't': 468, 'full': True},
    {'name': '竞对 E · 连锁经济型', 'dist': 2.3, 'y': 338, 't': 328, 'full': False},
    {'name': '竞对 F · 高端品牌', 'dist': 2.9, 'y': 518, 't': 518, 'full': False}]
ORDERS0 = [
    {'no': 'CT26102700187', 'ch': '携程', 'rt': '高级大床房', 'guest': '王**', 'stay': '今晚 1 晚', 'amt': 398, 'status': '待确认', 'mins': 12},
    {'no': 'MT26102700342', 'ch': '美团', 'rt': '高级双床房', 'guest': '李**', 'stay': '今晚 2 晚', 'amt': 836, 'status': '已确认', 'mins': 35},
    {'no': 'FZ26102700051', 'ch': '飞猪', 'rt': '豪华大床房', 'guest': '陈**', 'stay': '明晚 1 晚', 'amt': 528, 'status': '待确认', 'mins': 4},
    {'no': 'CT26102600954', 'ch': '携程', 'rt': '行政套房', 'guest': '赵**', 'stay': '今晚 1 晚', 'amt': 888, 'status': '已取消', 'mins': 80},
    {'no': 'MT26102700310', 'ch': '美团', 'rt': '高级大床房', 'guest': '周**', 'stay': '今晚 1 晚', 'amt': 398, 'status': '未同步到 PMS', 'mins': 18}]
REVIEWS0 = [
    {'id': 1, 'ch': '美团', 'score': 2, 'text': '卫生间有异味，晚上前台处理很慢。', 'time': '今天 07:42', 'status': 'open', 'draft': ''},
    {'id': 2, 'ch': '携程', 'score': 5, 'text': '位置方便，早餐不错，前台小姐姐很热情。', 'time': '今天 06:15', 'status': 'open', 'draft': ''},
    {'id': 3, 'ch': '飞猪', 'score': 3, 'text': '房间干净，但隔音一般，能听到走廊声音。', 'time': '昨天 22:30', 'status': 'open', 'draft': ''}]
ADAPTERS = [
    {'name': '选住云管家', 'use': '可售房、在住、维修房、PMS 订单', 'mode': '模拟数据', 'api': 'pms_availability(房型, 日期)'},
    {'name': '携程 / 美团 / 飞猪', 'use': '房态房价读写、订单、点评', 'mode': '模拟数据', 'api': 'ota_read(渠道, …) · ota_push(渠道, …, 变更)'},
    {'name': '竞对价格服务', 'use': '竞对公开价、满房状态', 'mode': '模拟数据', 'api': 'comp_rates(竞对列表)'},
    {'name': '通知通道', 'use': '电话、企业微信、短信', 'mode': '演示：页面内提示', 'api': 'notify(级别, 内容, 接收人)'}]
KIND = {'close': '关房', 'reduce': '减房量', 'open': '开房', 'price': '调价'}
WK = '日一二三四五六'
REJECT_REASONS = ['判断不同，不需要调整', '已在 OTA 后台手动处理', '数据有误', '其他']
W = None


def now_ms():
    return int(time.time() * 1000)


def jsround(x):
    return math.floor(x + 0.5)


def price8(x):
    return jsround(x / 10) * 10 - 2


def today():
    return datetime.now(TZ).date()


def day_date(w, i):
    return date.fromisoformat(w['base']) + timedelta(days=i)


def is_weekend(w, i):
    return day_date(w, i).weekday() in (4, 5)


def day_label(w, i):
    d = day_date(w, i)
    return f'今天 {d.month}/{d.day}' if i == 0 else f'{d.month}/{d.day} 周{WK[(d.weekday() + 1) % 7]}'


def rt_of(w, rid):
    return next(r for r in w['rt'] if r['id'] == rid)


# ---------- 数据适配器：接入真实系统时只替换这几个函数 ----------
def pms_availability(w, rt, di):
    return w['inv'][rt][di]['pms']


def ota_read(w, ch, rt, di):
    return w['inv'][rt][di]['ch'][ch]


def ota_push(w, ch, rt, di, patch):
    w['inv'][rt][di]['ch'][ch].update(patch)
    return True


# ---------- 规则与执行 ----------
def add_alert(w, level, text, sid=None, t=None):
    w['aid'] += 1
    w['alerts'].insert(0, {'id': f"A{w['aid']}", 'level': level, 'text': text, 'sid': sid, 'time': t or now_ms(), 'status': 'open'})


def add_sug(w, o):
    # 同一问题不重复推送：未处理、已驳回、已作废的不再提；已执行的只在问题再次出现时重新提醒
    if any(s['key'] == o['key'] and (s['status'] not in ('done', 'failed') or o['key'].startswith('comp-')) for s in w['sugs']):
        return 0
    w['sid'] += 1
    s = {'id': f"S{w['sid']}", 'created': now_ms(), 'status': 'pending', **o}
    w['sugs'].insert(0, s)
    add_alert(w, o['level'], o['title'], s['id'])
    return 1


def detect(w):
    n, thr = 0, w['thr']
    for rt in w['rt']:
        rid = rt['id']
        for di in range(DAYS):
            pms = pms_availability(w, rid, di)
            ref = ota_read(w, 'ctrip', rid, di)
            for c in CH_IDS:
                s = ota_read(w, c, rid, di)
                cn = CH_NAME[c]
                where = f"{rt['name']} {day_label(w, di)} · {cn}"
                if s['open'] and s['qty'] > pms:
                    close = pms == 0
                    n += add_sug(w, {'key': f'over-{rid}-{di}-{c}', 'level': 'urgent', 'kind': 'close' if close else 'reduce',
                                     'rt': rid, 'di': di, 'chs': [c], 'title': f'{where} 有超售风险',
                                     'patch': {'open': False, 'qty': 0} if close else {'qty': pms},
                                     'before': f"在售 {s['qty']} 间", 'after': '关房' if close else f'在售 {pms} 间',
                                     'editable': None if close else 'qty',
                                     'reason': f"选住云管家可售 {pms} 间，{cn}在售 {s['qty']} 间。"})
                if not s['open'] and pms >= thr['reopenMin']:
                    q = min(pms, 3)
                    n += add_sug(w, {'key': f'reopen-{rid}-{di}-{c}', 'level': 'important', 'kind': 'open', 'rt': rid, 'di': di,
                                     'chs': [c], 'title': f'{where} 有空房但处于关房', 'patch': {'open': True, 'qty': q},
                                     'before': '关房', 'after': f'开房 · {q} 间', 'editable': 'qty',
                                     'reason': f'选住云管家可售 {pms} 间，{cn}未开房，可能错失订单。'})
                if s['open'] and (s['price'] < rt['floor'] or s['price'] > rt['cap']):
                    ok_ref = c != 'ctrip' and rt['floor'] <= ref['price'] <= rt['cap']
                    to = ref['price'] if ok_ref else price8(rt['base'] * (1.15 if is_weekend(w, di) else 1))
                    n += add_sug(w, {'key': f"abn-{rid}-{di}-{c}-{s['price']}", 'level': 'urgent', 'kind': 'price', 'rt': rid,
                                     'di': di, 'chs': [c], 'title': f"{where} 价格异常 ¥{s['price']}", 'patch': {'price': to},
                                     'before': f"¥{s['price']}", 'after': f'¥{to}', 'editable': 'price',
                                     'reason': f"低于底价 ¥{rt['floor']}，疑似误操作。" if s['price'] < rt['floor']
                                     else f"高于封顶价 ¥{rt['cap']}，疑似误操作。"})
                elif s['open'] and c != 'ctrip' and ref['open']:
                    diff = s['price'] - ref['price']
                    if abs(diff) / ref['price'] * 100 > thr['spreadPct'] and abs(diff) > thr['spreadAbs']:
                        n += add_sug(w, {'key': f"spread-{rid}-{di}-{c}-{s['price']}", 'level': 'important', 'kind': 'price',
                                         'rt': rid, 'di': di, 'chs': [c], 'title': f'{where} 与携程价格不一致',
                                         'patch': {'price': ref['price']}, 'before': f"¥{s['price']}", 'after': f"¥{ref['price']}",
                                         'editable': 'price',
                                         'reason': f"携程 ¥{ref['price']}，{cn} ¥{s['price']}，相差 {'+' if diff > 0 else ''}{diff} 元，可能被判价格倒挂。"})
    for cp in w['comps']:
        pct = (cp['t'] - cp['y']) / cp['y'] * 100
        if pct > thr['compPct']:
            rt = w['rt'][0]
            cur = ota_read(w, 'ctrip', rt['id'], 0)['price']
            to = min(rt['cap'], price8(cur * 1.06))
            if to > cur:
                chs = [c for c in CH_IDS if ota_read(w, c, rt['id'], 0)['open']]
                n += add_sug(w, {'key': f"comp-{cp['name']}-{cp['t']}", 'level': 'important', 'kind': 'price', 'rt': rt['id'],
                                 'di': 0, 'chs': chs, 'title': f"{cp['name']} 今日上调 {pct:.0f}%", 'patch': {'price': to},
                                 'before': f'¥{cur}', 'after': f'¥{to}', 'editable': 'price',
                                 'reason': f"竞对由 ¥{cp['y']} 调到 ¥{cp['t']}。建议{rt['name']}今日全部已开渠道上调约 6%。"})
    w['last_scan'] = now_ms()
    return n


def perturb(w):
    """模拟巡检：轮流制造一种新情况"""
    step = w['scan_n'] % 3
    w['scan_n'] += 1
    di, rt = 1 + random.randrange(5), w['rt'][random.randrange(3)]
    cell = w['inv'][rt['id']][di]
    if step == 0:
        c = cell['ch']['meituan']
        if not c['open']:
            c['open'], c['qty'] = True, min(cell['pms'], 2) or 1
        c['price'] = cell['ch']['ctrip']['price'] + 60
    elif step == 1:
        c = cell['ch']['ctrip']
        c['open'], c['qty'] = True, max(c['qty'], 3)
        cell['pms'] = max(0, c['qty'] - 2)
    else:
        cp = w['comps'][2]
        cp['y'], cp['t'] = cp['t'], price8(cp['t'] * 1.14)


def target_text(w, s):
    return f"{rt_of(w, s['rt'])['name']} · {day_label(w, s['di'])} · {'、'.join(CH_NAME[c] for c in s['chs'])}"


def execute(w, s, user=None, actor=None, ip=''):
    """确认后才调用：写入渠道 → 回读核对 → 留痕。"""
    snap = {'gen': w['gen'], 'rt': s['rt'], 'di': s['di'],
            'ch': {c: dict(ota_read(w, c, s['rt'], s['di'])) for c in s['chs']}}
    results = [ota_push(w, c, s['rt'], s['di'], s['patch']) for c in s['chs']]
    ok = all(results) and all(ota_read(w, c, s['rt'], s['di'])[k] == v for c in s['chs'] for k, v in s['patch'].items())
    s['status'], s['doneAt'] = ('done' if ok else 'failed'), now_ms()
    s['by'] = actor or actor_name(user)
    audit('ota', KIND[s['kind']], user=user, actor=actor, target=target_text(w, s), before=s['before'], after=s['after'],
          result='成功，回读一致' if ok else '失败，已告警', ip=ip, snap=snap)
    close_alerts(w, s['id'])
    if not ok:
        add_alert(w, 'urgent', f'写入失败：{target_text(w, s)}')
    return ok


def close_alerts(w, sid):
    for a in w['alerts']:
        if a['sid'] == sid and a['status'] == 'open':
            a['status'] = 'done'


def tick(w):
    """定时：倒计时升级、紧急关房、过期作废"""
    t, thr = now_ms(), w['thr']
    for s in w['sugs']:
        if s['status'] != 'pending':
            continue
        m = (t - s['created']) / 60000
        lim = thr['urgentMin'] if s['level'] == 'urgent' else thr['importantMin']
        if m > lim and not s.get('escalated'):
            s['escalated'] = True
            add_alert(w, s['level'], f"已升级代理审批人：{s['title']}", s['id'])
        if s['level'] == 'urgent' and s['kind'] in ('close', 'reduce') and thr['autoClose'] and m > thr['autoCloseMin']:
            s['patch'], s['after'], s['kind'] = {'open': False, 'qty': 0}, '关房', 'close'
            execute(w, s, actor='系统 · 紧急关房')
        elif s['level'] == 'important' and m > 240:
            s['status'] = 'expired'


def trim(w):
    keep = [s for s in w['sugs'] if s['status'] in ('pending',)]
    rest = [s for s in w['sugs'] if s['status'] not in ('pending',)][:200]
    w['sugs'] = sorted(keep + rest, key=lambda s: -s['created'])
    w['alerts'] = w['alerts'][:300]


def new_world(first):
    r = random.Random(20261027)
    w = {'gen': secrets.token_hex(4), 'base': today().isoformat(), 'rt': copy.deepcopy(RT0), 'thr': dict(THR0),
         'inv': {}, 'comps': copy.deepcopy(COMPS0), 'orders': copy.deepcopy(ORDERS0), 'reviews': copy.deepcopy(REVIEWS0),
         'sugs': [], 'alerts': [], 'sid': 0, 'aid': 0, 'scan_n': 0, 'last_scan': None}
    if W:   # 跨天重建模拟数据时保留管理者改过的阈值和底价/封顶价
        w['thr'] = dict(W['thr'])
        for rt in w['rt']:
            old = next((o for o in W['rt'] if o['id'] == rt['id']), None)
            if old:
                rt['floor'], rt['cap'] = old['floor'], old['cap']
    for rt in w['rt']:
        rows = []
        for i in range(DAYS):
            occ = 0.45 + r.random() * 0.35 + (0.12 if is_weekend(w, i) else 0) - (0.15 if i > 7 else 0)
            pms = max(0, jsround(rt['total'] * (1 - min(occ, 0.98))))
            p = price8(rt['base'] * (1.15 if is_weekend(w, i) else 1))
            ch = {}
            for c in CH_IDS:
                q = min(pms, 5 if c == 'ctrip' else 3)
                ch[c] = {'open': q > 0, 'qty': q, 'price': p}
            rows.append({'pms': pms, 'ch': ch})
        w['inv'][rt['id']] = rows
    # 注入几种典型异常，便于演示
    inv = w['inv']
    k = inv['K'][0]
    k['pms'] = 1
    k['ch']['ctrip'].update(open=True, qty=3)
    k['ch']['meituan'].update(open=True, qty=1)
    k['ch']['fliggy'].update(open=True, qty=1)
    t = inv['T'][2]
    t['pms'] = max(t['pms'], 9)
    t['ch']['ctrip'].update(open=True, qty=5)
    t['ch']['meituan'].update(open=True, qty=3)
    t['ch']['fliggy'].update(open=False, qty=0)
    d = inv['D'][0]
    d['pms'] = max(d['pms'], 4)
    for c in CH_IDS:
        d['ch'][c].update(open=True, qty=min(d['pms'], 3))
    d['ch']['meituan']['price'] = 199
    k5 = inv['K'][5]
    k5['pms'] = max(k5['pms'], 6)
    for c in CH_IDS:
        k5['ch'][c].update(open=True, qty=3)
    k5['ch']['fliggy']['price'] = k5['ch']['ctrip']['price'] + 40
    s = inv['S'][0]
    s['pms'] = 0
    for c in CH_IDS:
        s['ch'][c].update(open=False, qty=0)
    if first:   # 第一次启动时预置一条历史：系统紧急关房
        snap = {'gen': w['gen'], 'rt': 'S', 'di': 0, 'ch': {'meituan': {**s['ch']['meituan'], 'open': True, 'qty': 1}}}
        audit('ota', '关房', actor='系统 · 紧急关房', target=f'行政套房 · {day_label(w, 0)} · 美团',
              before='在售 1 间', after='关房', result='成功，回读一致', snap=snap)
        add_alert(w, 'urgent', '行政套房今日已满房，美团 20 分钟无人确认，系统已紧急关房', None, now_ms() - 35 * 60000)
    detect(w)
    return w


def load_world():
    global W
    row = DB.execute("SELECT v FROM kv WHERE k = 'world'").fetchone()
    W = json.loads(row['v']) if row else None
    if not W or W.get('base') != today().isoformat():
        W = new_world(first=not row)
    save_world()


def save_world():
    DB.execute("INSERT INTO kv(k, v) VALUES('world', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
               (json.dumps(W, ensure_ascii=False),))


def background():
    n = 0
    while True:
        time.sleep(30)
        n += 1
        with LOCK:
            try:
                global W
                if W['base'] != today().isoformat():
                    W = new_world(first=False)
                tick(W)
                if n % 10 == 0:   # 每 5 分钟自动巡检
                    detect(W)
                trim(W)
                save_world()
                now = time.time()
                DB.execute('DELETE FROM sessions WHERE seen < ? OR created < ?', (now - IDLE_SEC, now - MAX_AGE_SEC))
            except Exception:
                traceback.print_exc()


# ================= 接口 =================
def can(user, perm):
    return perm in PERMS[user['role']]


def logs_for(user):
    if can(user, 'log_all'):
        rows = DB.execute("SELECT * FROM audit WHERE kind IN ('ota','ops') ORDER BY id DESC LIMIT 200").fetchall()
    elif can(user, 'log_own'):
        rows = DB.execute("SELECT * FROM audit WHERE kind IN ('ota','ops') AND user_id = ? ORDER BY id DESC LIMIT 200",
                          (user['id'],)).fetchall()
    else:
        return []
    out = []
    for r in rows:
        snap = json.loads(r['snap']) if r['snap'] else None
        out.append({'id': r['id'], 'time': int(r['time'] * 1000), 'actor': r['actor'], 'kind': r['kind'], 'action': r['action'],
                    'target': r['target'], 'before': r['before_v'], 'after': r['after_v'], 'result': r['result'],
                    'hasSnap': bool(snap), 'rolledBack': bool(r['rolled_back']),
                    'canRollback': bool(snap) and not r['rolled_back'] and snap.get('gen') == W['gen']})
    return out


def state_for(user):
    w = W
    return {'now': now_ms(), 'base': w['base'], 'days': DAYS, 'ch': CH, 'rt': w['rt'], 'thr': w['thr'], 'inv': w['inv'],
            'comps': w['comps'], 'orders': w['orders'], 'reviews': w['reviews'], 'sugs': w['sugs'], 'alerts': w['alerts'],
            'lastScan': w['last_scan'], 'adapters': ADAPTERS, 'logs': logs_for(user), 'rejectReasons': REJECT_REASONS}


def users_payload():
    now = time.time()
    users = [{'id': u['id'], 'username': u['username'], 'name': u['name'], 'role': u['role'], 'disabled': bool(u['disabled']),
              'mustChange': bool(u['must_change']), 'locked': u['locked_until'] > now,
              'lastLogin': int(u['last_login'] * 1000) if u['last_login'] else None, 'created': int(u['created'] * 1000)}
             for u in DB.execute('SELECT * FROM users ORDER BY id')]
    log = [{'id': r['id'], 'time': int(r['time'] * 1000), 'actor': r['actor'], 'action': r['action'], 'target': r['target'],
            'result': r['result'], 'ip': r['ip']}
           for r in DB.execute("SELECT * FROM audit WHERE kind = 'account' ORDER BY id DESC LIMIT 100")]
    return {'users': users, 'log': log, 'roles': ROLES}


USERNAME_RE = re.compile(r'^[A-Za-z0-9_.-]{3,32}$')


def clean_name(v):
    v = str(v or '').strip()
    if not 1 <= len(v) <= 20:
        raise ApiError(400, '姓名需要 1 到 20 个字')
    return v


def check_new_pw(pw, username):
    if len(pw) < MIN_PW_LEN:
        raise ApiError(400, f'新密码至少 {MIN_PW_LEN} 位')
    if pw.lower() == username.lower():
        raise ApiError(400, '新密码不能和用户名相同')
    if len(set(pw)) < 4:
        raise ApiError(400, '新密码太简单，请混合字母和数字')


def other_active_admins(uid):
    return DB.execute("SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?", (uid,)).fetchone()[0]


def find(lst, key, val):
    return next((x for x in lst if x[key] == val), None)


def to_int(v, lo, hi, what):
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ApiError(400, f'{what}需要填数字')
    if not math.isfinite(f):
        raise ApiError(400, f'{what}需要填数字')
    n = jsround(f)
    if not lo <= n <= hi:
        raise ApiError(400, f'{what}需在 {lo} 到 {hi} 之间')
    return n


def route(h, method, path):
    ip = h.ip()
    token = h.cookie_token()

    if method == 'POST' and path == '/api/login':
        d = h.body()
        uname, pw = str(d.get('username', '')).strip()[:64], str(d.get('password', ''))
        if ip_blocked(ip):
            raise ApiError(429, '尝试次数过多，请 15 分钟后再试')
        u = DB.execute('SELECT * FROM users WHERE username = ?', (uname,)).fetchone()
        now = time.time()
        if u and u['locked_until'] > now:
            raise ApiError(423, f"账号已锁定，请 {math.ceil((u['locked_until'] - now) / 60)} 分钟后再试，或请管理者解锁")
        good = check_pw(pw, u['pw'] if u else DUMMY_HASH) and u is not None
        if not good or u['disabled']:
            IP_FAILS.setdefault(ip, []).append(now)
            if u and not good:
                register_fail(u, ip)
            audit('account', '登录失败', actor=uname or '（空）', ip=ip,
                  result='账号已停用' if u and good else '密码错误或账号不存在')
            raise ApiError(401, '用户名或密码不正确')
        DB.execute('UPDATE users SET fails = 0, last_login = ? WHERE id = ?', (now, u['id']))
        t = new_session(u['id'], ip)
        audit('account', '登录', user=u, ip=ip)
        return 200, {'me': me_payload(u)}, h.make_cookie(t, MAX_AGE_SEC)

    if method == 'GET' and path == '/api/auth-check':   # 给 nginx auth_request 用
        u = session_user(token, touch=False)
        return (204 if u and not u['must_change'] else 401), None, None

    user = session_user(token, touch=h.headers.get('X-Poll') != '1')
    if not user:
        raise ApiError(401, '请先登录')

    if method == 'POST' and path == '/api/logout':
        DB.execute('DELETE FROM sessions WHERE token = ?', (tok_hash(token),))
        audit('account', '退出登录', user=user, ip=ip)
        return 200, {'ok': True}, h.make_cookie('', 0)
    if method == 'GET' and path == '/api/me':
        return 200, {'me': me_payload(user)}, None
    if method == 'POST' and path == '/api/password':
        d = h.body()
        old, new = str(d.get('old', '')), str(d.get('new', ''))
        u = DB.execute('SELECT * FROM users WHERE id = ?', (user['id'],)).fetchone()
        if not check_pw(old, u['pw']):
            left = register_fail(u, ip)
            raise ApiError(401 if not left else 403, '当前密码不正确' + (f'，还可以再试 {left} 次' if left else '，账号已锁定'))
        if new == old:
            raise ApiError(400, '新密码不能和当前密码相同')
        check_new_pw(new, u['username'])
        DB.execute('UPDATE users SET pw = ?, must_change = 0, fails = 0 WHERE id = ?', (hash_pw(new), u['id']))
        kill_sessions(u['id'], keep=tok_hash(token))
        audit('account', '修改密码', user=user, ip=ip, result='其他设备上的登录已退出')
        user = dict(DB.execute('SELECT * FROM users WHERE id = ?', (u['id'],)).fetchone())
        return 200, {'me': me_payload(user)}, None

    if user['must_change']:
        raise ApiError(403, '请先修改临时密码', mustChange=True)

    def need(perm):
        if not can(user, perm):
            audit('account', '无权限操作被拒绝', user=user, ip=ip, target=f'{method} {path}')
            raise ApiError(403, f"您的角色（{ROLES[user['role']]}）没有这个权限")

    w = W
    if method == 'GET' and path == '/api/state':
        need('view')
        return 200, state_for(user), None

    if method == 'POST' and path == '/api/scan':
        need('scan')
        perturb(w)
        n = detect(w)
        audit('ops', '手动巡检', user=user, ip=ip, result=f'新增 {n} 条建议' if n else '未发现新问题')
        return 200, {'msg': f'巡检完成，新增 {n} 条建议' if n else '巡检完成，未发现新问题'}, None

    m = re.fullmatch(r'/api/sugs/(S\d+)/(confirm|reject)', path)
    if method == 'POST' and m:
        need('confirm')
        s = find(w['sugs'], 'id', m[1])
        if not s:
            raise ApiError(404, '找不到这条建议')
        if s['status'] != 'pending':
            raise ApiError(409, '这条建议已经被处理过了，请刷新')
        d = h.body()
        if m[2] == 'reject':
            reason = str(d.get('reason', ''))
            if reason not in REJECT_REASONS:
                raise ApiError(400, '请选择驳回原因')
            s['status'], s['rejectReason'], s['by'] = 'rejected', reason, actor_name(user)
            audit('ota', '驳回', user=user, ip=ip, target=target_text(w, s), before=s['before'], after='未执行', result=reason)
            close_alerts(w, s['id'])
            return 200, {'msg': '已驳回，渠道未做任何改动'}, None
        rt = rt_of(w, s['rt'])
        patch, after = dict(s['patch']), s['after']
        if d.get('value') is not None:
            if not s.get('editable'):
                raise ApiError(400, '这条建议不能修改数值')
            if s['editable'] == 'price':
                v = to_int(d['value'], rt['floor'], rt['cap'], '价格')
                after = f'¥{v}'
            else:
                v = to_int(d['value'], 0, pms_availability(w, s['rt'], s['di']), '房量')
                after = f'开房 · {v} 间' if s['kind'] == 'open' else f'在售 {v} 间'
            patch[s['editable']] = v
        if 'price' in patch and not rt['floor'] <= patch['price'] <= rt['cap']:
            raise ApiError(400, f"价格 ¥{patch['price']} 超出底价 ¥{rt['floor']} – 封顶价 ¥{rt['cap']}，请修改后确认")
        verify_again(user, d.get('password'), ip)
        s['patch'], s['after'] = patch, after
        ok = execute(w, s, user=user, ip=ip)
        return 200, {'msg': '已写入渠道，回读核对一致' if ok else '回读不一致，已发紧急告警'}, None

    m = re.fullmatch(r'/api/logs/(\d+)/rollback', path)
    if method == 'POST' and m:
        need('confirm')
        r = DB.execute("SELECT * FROM audit WHERE id = ? AND kind = 'ota'", (int(m[1]),)).fetchone()
        snap = json.loads(r['snap']) if r and r['snap'] else None
        if not snap:
            raise ApiError(404, '这条记录不能回滚')
        if r['rolled_back']:
            raise ApiError(409, '这条记录已经回滚过了')
        if snap.get('gen') != w['gen']:
            raise ApiError(409, '模拟数据已经重置，这条记录无法回滚')
        verify_again(user, h.body().get('password'), ip)
        for c, val in snap['ch'].items():
            ota_push(w, c, snap['rt'], snap['di'], val)
        DB.execute('UPDATE audit SET rolled_back = 1 WHERE id = ?', (r['id'],))
        audit('ota', '回滚', user=user, ip=ip, target=r['target'], before=r['after_v'], after=r['before_v'],
              result='成功，已恢复调整前的值')
        return 200, {'msg': '已回滚到调整前的值'}, None

    m = re.fullmatch(r'/api/alerts/(A\d+)/(ack|ignore)', path)
    if method == 'POST' and m:
        need('alert')
        a = find(w['alerts'], 'id', m[1])
        if not a:
            raise ApiError(404, '找不到这条告警')
        if a['status'] != 'open':
            raise ApiError(409, '这条告警已经处理过了')
        a['status'] = 'done' if m[2] == 'ack' else 'ignored'
        audit('ops', '告警已处理' if m[2] == 'ack' else '告警已忽略', user=user, ip=ip, target=a['text'])
        return 200, {'msg': '已更新'}, None

    m = re.fullmatch(r'/api/orders/(\d+)/done', path)
    if method == 'POST' and m:
        need('order')
        i = int(m[1])
        if i >= len(w['orders']):
            raise ApiError(404, '找不到这个订单')
        o = w['orders'][i]
        before, o['status'] = o['status'], '已处理'
        audit('ops', '订单标记已处理', user=user, ip=ip, target=f"{o['no']} · {o['ch']} · {o['rt']}", before=before, after='已处理')
        return 200, {'msg': '已标记'}, None

    m = re.fullmatch(r'/api/reviews/(\d+)/(draft|send)', path)
    if method == 'POST' and m:
        need('review')
        r = find(w['reviews'], 'id', int(m[1]))
        if not r:
            raise ApiError(404, '找不到这条点评')
        if r['status'] == 'done':
            raise ApiError(409, '这条点评已经回复过了')
        if m[2] == 'draft':
            r['draft'] = (f"您好，非常抱歉这次入住给您带来不好的体验。关于您提到的“{r['text'][:12]}…”，我们已安排相关部门检查整改。"
                          f"欢迎您再次入住，届时请联系前台，我们会为您做好安排。") if r['score'] <= 3 else '感谢您的好评！很高兴您喜欢我们的服务，期待您再次光临。'
            return 200, {'msg': '已生成草稿，请修改后发出'}, None
        text = str(h.body().get('text', '')).strip()
        if not 1 <= len(text) <= 500:
            raise ApiError(400, '回复内容需要 1 到 500 个字')
        r['draft'], r['status'] = text, 'done'
        audit('ops', '回复点评（演示）', user=user, ip=ip, target=f"{r['ch']} · {r['score']} 星", after=text[:60])
        return 200, {'msg': '回复已标记发出（演示，未连接 OTA）'}, None

    if method == 'POST' and path == '/api/settings':
        need('settings')
        d = h.body()
        thr, rts, changes = dict(w['thr']), copy.deepcopy(w['rt']), []
        for k, v in (d.get('thr') or {}).items():
            if k not in THR0:
                continue
            nv = bool(v) if k == 'autoClose' else to_int(v, 0, 100000, THR_LABEL[k])
            if nv != thr[k]:
                changes.append(f'{THR_LABEL[k]} {thr[k]} → {nv}')
                thr[k] = nv
        for rid, fc in (d.get('rt') or {}).items():
            rt = find(rts, 'id', rid)
            if not rt or not isinstance(fc, dict):
                continue
            fl = to_int(fc.get('floor', rt['floor']), 1, 100000, f"{rt['name']}底价")
            cp = to_int(fc.get('cap', rt['cap']), 1, 100000, f"{rt['name']}封顶价")
            if fl >= cp:
                raise ApiError(400, f"{rt['name']}的底价要低于封顶价")
            if (fl, cp) != (rt['floor'], rt['cap']):
                changes.append(f"{rt['name']} ¥{rt['floor']}–{rt['cap']} → ¥{fl}–{cp}")
                rt['floor'], rt['cap'] = fl, cp
        if not changes:
            return 200, {'msg': '没有改动'}, None
        w['thr'], w['rt'] = thr, rts
        audit('ops', '修改设置', user=user, ip=ip, target='监控阈值 / 底价封顶价', after='；'.join(changes))
        return 200, {'msg': f'已保存 {len(changes)} 项设置，下次巡检生效'}, None

    if path == '/api/users' or path.startswith('/api/users/'):
        need('users')
        if method == 'GET' and path == '/api/users':
            return 200, users_payload(), None
        if method == 'POST' and path == '/api/users':
            d = h.body()
            uname, name, role = str(d.get('username', '')).strip(), clean_name(d.get('name')), d.get('role')
            if not USERNAME_RE.match(uname):
                raise ApiError(400, '用户名需要 3 到 32 位，只能用字母、数字和 _ . -')
            if role not in ROLES:
                raise ApiError(400, '请选择角色')
            if DB.execute('SELECT 1 FROM users WHERE username = ?', (uname,)).fetchone():
                raise ApiError(409, '这个用户名已经存在')
            pw = temp_password()
            DB.execute('INSERT INTO users(username,name,role,pw,must_change,created) VALUES(?,?,?,?,1,?)',
                       (uname, name, role, hash_pw(pw), time.time()))
            audit('account', '新建账号', user=user, ip=ip, target=f'{name}（{uname}）', after=ROLES[role])
            return 200, {'msg': '账号已创建', 'tempPassword': pw, 'username': uname}, None
        m = re.fullmatch(r'/api/users/(\d+)/(update|reset)', path)
        if method == 'POST' and m:
            t = DB.execute('SELECT * FROM users WHERE id = ?', (int(m[1]),)).fetchone()
            if not t:
                raise ApiError(404, '找不到这个账号')
            who = f"{t['name']}（{t['username']}）"
            if m[2] == 'reset':
                pw = temp_password()
                DB.execute('UPDATE users SET pw = ?, must_change = 1, fails = 0, locked_until = 0 WHERE id = ?',
                           (hash_pw(pw), t['id']))
                kill_sessions(t['id'], keep=tok_hash(token) if t['id'] == user['id'] else None)
                audit('account', '重置密码', user=user, ip=ip, target=who, result='已解锁，需用临时密码重新登录')
                return 200, {'msg': '密码已重置', 'tempPassword': pw, 'username': t['username']}, None
            d = h.body()
            name = clean_name(d['name']) if 'name' in d else t['name']
            role = d.get('role', t['role'])
            disabled = bool(d['disabled']) if 'disabled' in d else bool(t['disabled'])
            if role not in ROLES:
                raise ApiError(400, '角色不正确')
            if t['id'] == user['id'] and (role != t['role'] or disabled):
                raise ApiError(400, '不能停用自己，也不能修改自己的角色')
            if t['role'] == 'admin' and (role != 'admin' or disabled) and not other_active_admins(t['id']):
                raise ApiError(400, '至少要保留一个正常使用的管理者')
            changes = []
            if name != t['name']:
                changes.append(f"姓名 {t['name']} → {name}")
            if role != t['role']:
                changes.append(f"角色 {ROLES[t['role']]} → {ROLES[role]}")
            if disabled != bool(t['disabled']):
                changes.append('停用' if disabled else '启用')
            if not changes:
                return 200, {'msg': '没有改动'}, None
            DB.execute('UPDATE users SET name = ?, role = ?, disabled = ? WHERE id = ?', (name, role, int(disabled), t['id']))
            if role != t['role'] or disabled:
                kill_sessions(t['id'])
            audit('account', '修改账号', user=user, ip=ip, target=who, after='；'.join(changes))
            return 200, {'msg': '已保存'}, None

    raise ApiError(404, '接口不存在')


class Handler(BaseHTTPRequestHandler):
    server_version = 'ota'
    sys_version = ''

    def log_message(self, fmt, *args):
        sys.stderr.write(f'{self.ip()} {fmt % args}\n')

    def ip(self):
        return self.headers.get('X-Real-IP') or self.client_address[0]

    def cookie_token(self):
        for part in self.headers.get('Cookie', '').split(';'):
            k, _, v = part.strip().partition('=')
            if k == COOKIE:
                return v
        return None

    def make_cookie(self, token, max_age):
        secure = '; Secure' if self.headers.get('X-Forwarded-Proto') == 'https' else ''
        return f'{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}'

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > 65536:
            raise ApiError(413, '请求太大')
        if not n:
            return {}
        try:
            d = json.loads(self.rfile.read(n))
        except ValueError:
            raise ApiError(400, '请求格式不正确')
        if not isinstance(d, dict):
            raise ApiError(400, '请求格式不正确')
        return d

    def send(self, code, obj, cookie=None):
        body = b'' if obj is None else json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        if obj is not None:
            self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        if cookie is not None:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(body)

    def handle_api(self, method):
        path = urlparse(self.path).path
        try:
            if method == 'POST':
                if not self.headers.get('Content-Type', '').startswith('application/json'):
                    raise ApiError(415, '只接受 JSON 请求')
                origin = self.headers.get('Origin')
                if origin and urlparse(origin).netloc != self.headers.get('Host'):
                    raise ApiError(403, '请求来源不被允许')
            with LOCK:
                try:
                    code, obj, cookie = route(self, method, path)
                finally:
                    if method == 'POST':
                        save_world()
            self.send(code, obj, cookie)
        except ApiError as e:
            self.send(e.code, {'error': e.msg, **e.extra})
        except Exception:
            traceback.print_exc()
            self.send(500, {'error': '服务器内部错误'})

    def do_GET(self):
        self.handle_api('GET')

    def do_POST(self):
        self.handle_api('POST')


# ================= 命令行 =================
def cli_adduser(username, role, name):
    if role not in ROLES:
        sys.exit(f'角色必须是 {" / ".join(ROLES)}')
    if not USERNAME_RE.match(username):
        sys.exit('用户名需要 3 到 32 位，只能用字母、数字和 _ . -')
    pw = temp_password()
    try:
        DB.execute('INSERT INTO users(username,name,role,pw,must_change,created) VALUES(?,?,?,?,1,?)',
                   (username, name, role, hash_pw(pw), time.time()))
    except sqlite3.IntegrityError:
        sys.exit(f'用户名 {username} 已存在')
    audit('account', '新建账号', actor='命令行', target=f'{name}（{username}）', after=ROLES[role])
    print(f'{username}\t{ROLES[role]}\t临时密码：{pw}')


def cli_resetpw(username):
    u = DB.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    if not u:
        sys.exit(f'找不到用户 {username}')
    pw = temp_password()
    DB.execute('UPDATE users SET pw = ?, must_change = 1, fails = 0, locked_until = 0, disabled = 0 WHERE id = ?',
               (hash_pw(pw), u['id']))
    kill_sessions(u['id'])
    audit('account', '重置密码', actor='命令行', target=f"{u['name']}（{username}）", result='已解锁并启用')
    print(f'{username}\t临时密码：{pw}')


def main():
    open_db()
    cmd = sys.argv[1:] or ['serve']
    if cmd[0] == 'adduser' and len(cmd) == 4:
        cli_adduser(cmd[1], cmd[2], cmd[3])
    elif cmd[0] == 'resetpw' and len(cmd) == 2:
        cli_resetpw(cmd[1])
    elif cmd[0] == 'users':
        for u in DB.execute('SELECT * FROM users ORDER BY id'):
            print(u['id'], u['username'], u['name'], ROLES[u['role']], '已停用' if u['disabled'] else '正常', sep='\t')
    elif cmd[0] == 'serve':
        load_world()
        threading.Thread(target=background, daemon=True).start()
        print(f'OTA 盯盘台后台已启动 http://{HOST}:{PORT}', flush=True)
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == '__main__':
    main()
