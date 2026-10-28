# 酒店 OTA 24 小时盯盘系统

7×24 小时盯住携程、美团、飞猪等 OTA 渠道的房态、价格、订单和点评，发现问题即时告警并给出调价/上下架建议。**开房、上架、调价必须由管理者确认后才执行**；唯一例外是超售风险下的紧急关房（只关不开、不改价，可在设置中关闭）。

当前阶段：**账号与权限是真实功能；盯盘数据仍是模拟的**，未连接选住云管家（PMS）或任何 OTA。

## 目录

| 路径 | 内容 |
| --- | --- |
| `index.html` | 前端页面：登录、盯盘各页面、账号管理 |
| `server/app.py` | 后台（仅用 Python 3.10+ 标准库）：账号、角色、会话、权限检查、操作记录、模拟盯盘数据 |
| `deploy/` | Nginx 站点配置、systemd 服务文件 |
| `docs/需求文档.md` | 需求文档 |

## 账号与角色

| 功能 | 管理者 | 前台 | 只读 |
| --- | :-: | :-: | :-: |
| 查看总览、房态、价格、订单、点评 | ✓ | ✓ | ✓ |
| 处理告警、订单，回复点评，手动巡检 | ✓ | ✓ | — |
| 确认 / 驳回上架、调价、开关房，回滚（需再次输入登录密码） | ✓ | — | — |
| 修改阈值、底价、封顶价，紧急关房开关 | ✓ | — | — |
| 操作记录 | 全部 | 只看自己 | — |
| 账号管理（新建、改角色、停用、重置密码） | ✓ | — | — |

- 每个接口都在后台检查权限，页面上隐藏按钮只是为了好用。
- 密码用 scrypt 加盐保存；新账号和重置后的账号必须先改临时密码。
- 连续 5 次密码错误锁定 15 分钟；闲置 2 小时或登录满 12 小时自动退出。
- 改角色、停用、重置密码后，对方立即被退出登录。
- 操作记录在数据库层面只能新增，不能修改或删除。
- 登录失败、账号锁定、越权尝试都记入「登录与账号日志」。

## 部署（Ubuntu 22.04）

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin hotelota
mkdir -p /opt/hotel-ota/data && chown hotelota:hotelota /opt/hotel-ota/data && chmod 700 /opt/hotel-ota/data
cp server/app.py /opt/hotel-ota/
cp deploy/hotel-ota.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now hotel-ota
cp index.html /var/www/hotel-ota/ && cp -r docs /var/www/hotel-ota/
cp deploy/nginx-hotel-ota.conf /etc/nginx/sites-available/hotel-ota && nginx -t && systemctl reload nginx
```

命令行管理账号（在服务器上运行）：

```bash
cd /opt/hotel-ota
sudo -u hotelota python3 -I app.py adduser zhangsan front 张三   # 角色：admin / front / viewer
sudo -u hotelota python3 -I app.py resetpw zhangsan              # 忘记密码或被锁定时
sudo -u hotelota python3 -I app.py users
```

## 接入真实数据

`server/app.py` 里「数据适配器」的几个函数（`pms_availability`、`ota_read`、`ota_push`）换成真实接口即可，监控规则、确认流程、账号权限不变。

## 限制

- 还没有 HTTPS：上真实数据前必须先上（需要域名和 ICP 备案）。
- 二次验证目前是再输一次登录密码；以后可以换成短信或企业微信验证码。
- 通知只在页面内提示，不会真实发送。
- 模拟数据每天零点重置（阈值和底价/封顶价会保留）。
