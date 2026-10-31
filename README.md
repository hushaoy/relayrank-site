# RelayRank · 大模型中转站测评榜单（带后台 / 审核）

零依赖 Node 服务，前台榜单 + 后台管理 + 提交审核一条龙。数据落本地 `data/db.json`。

## 启动

```cmd
cd /d D:\新建文件夹\relayrank-site-hardened-20261028\relayrank-site
run.cmd
```

或手动 `node server.js --port=8803`。`run.cmd` 会自动：

- 数据目录自动探测：站点自带 `data\db.json` → 工作副本 `..\data\db.json` → 桌面整理包 `..\..\relayrank-data\data\db.json`，找到哪个用哪个
- 设置 `ENABLE_DETECTIVE=1`、`DETECTIVE_PORT=5000`
- 日志写 `logs\server.log`、`logs\boot.log`、`logs\detective.log`

- 前台：http://127.0.0.1:8803/
- 后台：http://127.0.0.1:8803/admin
- 模型侦探：http://127.0.0.1:8803/detective/
- 首次启动自动生成账号，见 `data/initial-admin.txt`（用户名 `admin`，密码随机 20 位；也可用 `ADMIN_PASSWORD` 预设，至少 12 位）
- 模型侦探目录、Python 解释器写在 `detective.config.json`；换机器时改 `dir` / `python` 两项即可

## 审核流程

```
访客提交 /api/submit ─┐
后台新增站点 ─────────┼─→ status=pending ─→ 后台审核 ─┬─ approve → published（进入公开榜）
批量导入 ─────────────┘                              └─ reject  → rejected（公开榜不可见，留原因）
```

公开接口 `GET /api/sites` 只返回 `published`；待审、驳回、草稿一律不出现。

后台动作：

| 操作 | 说明 |
|---|---|
| 通过 | `pending/rejected → published`，记录审核日志 |
| 驳回 | 必须填原因，写入审核日志，公开榜不可见 |
| 回待审 | `published/rejected → pending`，重新排队 |
| 批量通过 / 批量驳回 | 勾选后一次处理，原因统一记录 |
| 新增 / 编辑 | 五维滑杆实时算总分；可上传图标；状态可选手「待审核 / 直接发布 / 草稿 / 驳回」 |
| 批量导入 | JSON 或 CSV，默认进入待审核；`publish` 勾选后直接发布 |
| 导出 | `/api/admin/export` 下载完整 JSON |
| 修改密码 | 需要当前密码；改密后其它会话失效 |

## 评分规则

```
综合分 = 模型真实性×25% + 服务稳定性×25% + 基础可用性×20% + 站点安全×20% + 响应完整性×10%
S ≥ 90 · A ≥ 80 · B ≥ 70 · C ≥ 60 · D < 60
```

## 实测引擎（probe.js）

五维分数默认由人工录入。点后台的「实测」或「全部实测」，服务端会对站点发真实网络请求，把四个维度替换成测出来的值，并记录探测元数据。

```
可用性 availability  DNS / TCP / TLS / TTFB 耗时，5xx 封顶 40，4xx 封顶 70
稳定性 stability     连打 3 次：成功率×70% + TTFB 变异系数×30%
安全   security      HTTPS +30、TLS1.3 +15、证书剩余天数分档、HSTS +10、nosniff +8、XFO/CSP +7、不暴露版本号 +10；明文 HTTP 封顶 30
完整性 integrity     content-length 与实际字节一致 +30、content-type +15、结构可解析 +35、date 头 +10
真实性 authenticity  无 Key 不判定，保留人工值并标记 basis=unverified
                     有 Key 时：/v1/models 可读 +25、请求模型在列表 +15、补全 200 +20、回包 model 一致 +15、usage 完整 +15、finish_reason +5、正文非空 +5
```

每个站点会多出 `probe` 字段：

```json
{
  "at": "2026-10-26T19:24:55.722Z",
  "reachable": true,
  "basis": { "availability": "probe", "authenticity": "unverified" },
  "details": { "security": "HTTPS +30；TLS 1.3 +15；证书剩余 162 天 +20" },
  "metrics": { "dns": 1.2, "tcp": 50.8, "tls": 104.5, "ttfb": 152.5, "protocol": "TLSv1.3", "certDays": 162, "ip": "1.95.77.214" }
}
```

接口：`POST /api/admin/sites/:id/probe` 单条，`POST /api/admin/probe-all` 全部已发布。探测串行执行，两者都返回 202，前端轮询 `/api/admin/sites` 的 `probing` 字段获知剩余数量。

真实性需要站点支持 OpenAI 兼容接口。在编辑弹窗填 API Key 与实测模型名后，实测会拉模型列表并发一次 `/v1/chat/completions`，核对回包的 model、usage、finish_reason。


## 模型质量评测（eval-models.js）

五维打分量的是网站，模型分是另一套。这个模块回答"这家店卖的货到底怎么样"，全部由程序判定，不请模型当裁判。

### 评什么

| 面 | 权重 | 指标 | 怎么来的 |
|---|---|---|---|
| 性能 | 20% | TTFT、tok/s、抖动 | 流式请求 3 次，抓第一个 `data:` 分片的到达时间 |
| 能力 | 60% | 19 题通过率 | 固定题库，正则 / JSON / 本地单测判分 |
| 上下文 | 20% | 真实可捞回长度 | 逐级塞 8k / 32k，中间埋 `ZEBRA-7741`，看能不能捞回来 |

### 题库（19 题）

| 类别 | 题数 | 判分方式 | 例子 |
|---|---|---|---|
| 数学 | 5 | 正则提数，比对唯一答案 | `17 × 23 = ?` → 391 |
| 指令跟随 | 5 | 严格格式校验 | "只输出 OK" → `trim() === "OK"`，多一个字就扣 |
| 中文理解 | 4 | 关键词命中 | "差点没摔倒" → 必须答"没摔倒" |
| 代码 | 4 | 提取代码块 → 写临时 py → 跑单测 | `add()` / `reverse_string()` / `is_prime()` / `fib()` |
| 工具调用 | 1 | `tool_calls` 结构 + arguments 合法 JSON | 问天气，检查 `get_weather({"city":"北京"})` |

代码题是本地的 `spawnSync`，6 秒超时，临时目录跑完即删。判分靠 `AssertionError` 是否出现，不靠模型自评。

### 用法

**后台**：编辑站点 → 填 `API Key` 和 `实测模型名` → 列表里点「评测」→ 30-90 秒后「模型分」列出数，点分数看完整报告。

**HTTP**：

```bash
# 触发（body 可带 apiKey / model / baseUrl 覆盖）
curl -X POST http://127.0.0.1:8803/api/admin/sites/<id>/eval \
  -b ck.txt -H "x-csrf-token: <csrf>" \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"sk-xxx","model":"gpt-4o-mini"}'

# 轮询：GET /api/admin/sites 的 evaling 归零即完成
```

**命令行**：

```bash
node eval-models.js --url=https://api.example.com --key=sk-xxx --model=gpt-4o-mini
```

输出直接是完整 JSON，含 19 题逐题结果、TTFT、tok/s、上下文验证明细。

### 结果结构

```json
{
  "ok": true,
  "model": "mock-gpt-4o",
  "score": 100,
  "parts": { "perf": 100, "ability": 100, "context": 100 },
  "perf": { "ttft": 41.4, "tps": 146.9, "jitter": 0, "score": 100 },
  "ability": {
    "pass": 19, "total": 19, "rate": 100,
    "byCat": [{ "cat": "数学", "pass": 5, "total": 5, "rate": 100 }]
  },
  "context": { "maxVerified": 32000, "score": 100, "levels": [...] },
  "items": [{ "id": "math-1", "pass": true, "got": "391", "ms": 1.3 }]
}
```

### 已验证的判分行为

同一个 mock 服务，两种应答：

| 模式 | 总分 | 性能 | 能力 | 上下文 | 说明 |
|---|---|---|---|---|---|
| 全对 | 100 | 100 | 19/19 | 32k 捞出 | 代码题本地单测真跑通 |
| 全错 | 24.5 | 92.5 | 0/19 | 捞不回 | 4 道代码题报 `AssertionError`；工具题返回纯文本被判失败；回包 `model` 字段被改成 `some-other-model`，被逐题记录抓出 |

性能分和能分是独立的：全错那份性能还有 92.5，因为响应确实快。这就是模型质量评测该有的样子——快和聪明分开算。

### 模型分与综合分的关系

综合分（`score`）= 五维加权，量的是站点线路和配置。

模型分（`modelScore`）= 上表三项加权，量的是模型本身。

两者独立存储、独立展示、独立排序，互不污染。没跑过评测的站点模型分显示 `—`。

## 接口

| 方法 | 路径 | 鉴权 |
|---|---|---|
| GET | `/api/health` | 否 |
| GET | `/api/sites` | 否（仅 published） |
| POST | `/api/submit` | 否（限流 10 次/10 分钟/IP，带蜜罐字段；不直接改已发布站点） |
| POST | `/api/admin/login` | 密码，限流 5 次/5 分钟（用户名+IP） |
| POST | `/api/admin/logout` | CSRF |
| GET | `/api/admin/session` | Cookie |
| GET | `/api/admin/sites?status=` | Cookie |
| POST | `/api/admin/sites` | Cookie + CSRF |
| PUT/DELETE | `/api/admin/sites/:id` | Cookie + CSRF |
| POST | `/api/admin/sites/:id/probe` | Cookie + CSRF |
| POST | `/api/admin/sites/:id/eval` | Cookie + CSRF，`{apiKey, model, baseUrl?}` → 202 |
| POST | `/api/admin/reviews/bulk` | Cookie + CSRF，`{ids, action, reason}` |
| GET | `/api/admin/reviews` | Cookie |
| POST | `/api/admin/import` | Cookie + CSRF，`{format: json\|csv, text, publish}` |
| POST | `/api/admin/upload` | Cookie + CSRF，仅 PNG/JPG/WEBP/ICO，≤2 MB |
| GET | `/api/admin/export` | Cookie（API Key 脱敏） |
| POST | `/api/admin/password` | Cookie + CSRF |

## 登录与恢复

| 方式 | 地址 | 说明 |
|---|---|---|
| 表单登录 | `/admin` → `POST /login-form` | 成功后写入 HttpOnly Cookie，不再把 token 放进 URL |
| 命令行重置 | `node scripts/set-password.js 新密码` | 只换密码，不动站点/API Key；至少 12 位；清空全部旧会话 |
| 启动时覆盖 | `ADMIN_PASSWORD=新密码 node server.js` 或 `node server.js --password=新密码` | 至少 12 位；会清空全部旧会话 |
| 紧急恢复 | `KEEP_PASSWORD=1 node scripts/security-reset.js` | 只清会话/密钥，不轮换密码 |

- 会话只存 `sha256(sid)` 与随机 CSRF，数据库泄露不能直接重放 Cookie
- Cookie：`HttpOnly; SameSite=Strict; Secure`（生产环境），8 小时绝对过期
- 服务端不接受 `?tk=`、不提供 Basic 认证；旧版明文会话在启动时全部失效，需重新登录
- 所有写操作校验 `X-CSRF-Token`
- 登录防爆破（持久化在 `data/login-guard.json`，重启不清零）：
  - 同一「用户名 + IP」15 分钟内失败 5 次 → 锁定 15 分钟，连续触发按 2 倍递增（15/30/60… 分钟）
  - 同一 IP 15 分钟内失败 20 次 → 锁定 30 分钟，同样指数递增
  - 全站失败超过 120 次/分钟 → 全局暂停 60 秒
  - 账号不存在时也执行一次 scrypt 校验，避免通过响应时间枚举用户名
  - 后台「登录防护」面板可查看锁定记录并手动解锁；命令行 `node scripts/unlock-login.js --clear`
- 登录页底部灰字显示服务信息，用于确认连的是哪个服务实例

## 模型侦探（/detective）

前台导航「模型侦探」会以同源 iframe 打开 `http://127.0.0.1:5000` 的 Flask 检测台，路径 `/detective/*` 由 Node 反向代理，静态资源 `/static/*` 与接口 `/api/*` 自动改写到 `/detective/` 前缀。

- 默认公开访问；设置 `DETECTIVE_REQUIRE_LOGIN=1` 后必须登录后台才能使用
- 默认开启自动拉起：`detective.config.json` 配置 `dir` / `python` / `port`，Node 启动时探测端口，未监听则 `spawn` Python，日志写 `logs/detective.log`
- 关闭检测台：`ENABLE_DETECTIVE=0` 或配置 `"enabled": false`
- 关闭自动拉起：`DETECTIVE_AUTOSTART=0` 或配置 `"autostart": false`
- 检测台离线时返回可重试的说明页，并自动尝试重新拉起；状态接口 `GET /api/detective/status`
- 检测台页面使用独立 CSP（允许内联脚本与 Google Fonts），不影响主站 `script-src 'self'`

## 自动实测（默认每 1 小时）

后台「自动实测」面板可开关、改间隔（15 分钟 – 24 小时）、选择范围，并显示下次执行时间、上次结果与当前进度。

- 调度器每 30 秒检查一次 `db.settings.autoProbe.nextRunAt`，到点后按队列串行实测，避免并发打爆目标站
- 默认「只测有 API Key 的站点」：没有 Key 的站点无法完成补全/流式/并发测试，强行实测会把分数打成 0；需要测全部时取消勾选
- 每轮结束写回 `lastRunAt` / `lastFinishedAt` / `lastSummary`，并按完成时间重算下一次，不会因为单轮耗时漂移
- 手动触发：`POST /api/admin/auto-probe/run`；保存设置：`POST /api/admin/settings/auto-probe`

## 安全基线（本版本已内置）

- 密码 `scrypt` 加盐哈希；`/api/admin/login` 不返回 token
- 统一安全响应头：CSP（`script-src 'self'`）、HSTS、`X-Frame-Options`、`nosniff`、`Referrer-Policy`、`Permissions-Policy`
- 公开提交不能修改已发布站点；待审站点只允许同域名、未存 Key 时补充模型/备注
- SSRF 防护：只允许 HTTP/HTTPS，默认拒绝私网/回环/链路本地/云元数据地址；带 API Key 的请求只允许 HTTPS；DNS 解析结果固定后连接，防 DNS rebinding
- 探测响应体上限 2 MB、总超时 = 单次超时 + 2 秒；评测响应体上限 4 MB
- 模型代码题默认禁用。`EVAL_SANDBOX=1` 后只通过 Docker 执行：`--network=none`、只读根、非 root、128 MB 内存、0.5 CPU、64 PID、丢弃全部 capability
- 上传只接受 PNG/JPG/WEBP/ICO，按文件头校验，拒绝 SVG；SVG 静态文件额外加 `CSP: sandbox`
- `/detective` 默认开启并公开；需要登录时设置 `DETECTIVE_REQUIRE_LOGIN=1`
- 数据库原子写入（临时文件 + rename），损坏自动回滚 `db.json.bak`；读取时自动剥离 UTF-8 BOM，手工编辑过的 `db.json` 不会再把站点挡在启动阶段
- 日志对 token/key/password 参数脱敏
- 后台不返回明文 API Key（列表/导出脱敏），新增/修改时仍可写入
- 设置 `KEY_ENCRYPTION_KEY` 后，`db.json` 里的 API Key 使用 AES-256-GCM 加密；生成方式 `openssl rand -base64 32`，写入 `/etc/relayrank.env`（权限 600），丢失该 Key 将无法解密已有 Key
- 静态目录用 `path.relative` + `realpath` 双重校验，阻止 `..` 与符号链接逃逸；`/api/health` 不再暴露端口与站点数

## 生产部署（nginx + systemd + TLS）

Node 只监听回环，TLS 和限流交给 nginx。不要直接把 8803 暴露到公网。

Ubuntu 24.04 基础依赖：

```bash
sudo apt update
sudo apt install -y curl unzip nginx certbot python3-certbot-nginx ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

`/etc/nginx/conf.d/relayrank.conf`：

```nginx
server {
    listen 80;
    server_name rank.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name rank.example.com;

    ssl_certificate     /etc/letsencrypt/live/rank.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/rank.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    client_max_body_size 10m;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass http://127.0.0.1:8803;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300s;
        proxy_buffering off;
    }
}
```

`/etc/systemd/system/relayrank.service`：

```ini
[Unit]
Description=RelayRank site
After=network.target

[Service]
Type=simple
User=relayrank
Group=relayrank
WorkingDirectory=/opt/relayrank
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=8803
Environment=TRUST_PROXY=1
Environment=COOKIE_SECURE=1
Environment=DATA_DIR=/var/lib/relayrank
Environment=LOG_DIR=/var/log/relayrank
EnvironmentFile=-/etc/relayrank.env
ExecStart=/usr/bin/node /opt/relayrank/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/relayrank /var/log/relayrank /opt/relayrank/public/uploads
UMask=0077

[Install]
WantedBy=multi-user.target
```

`/etc/relayrank.env`（权限 600，仅 root 可读）：

```bash
ADMIN_PASSWORD=替换成至少12位强密码
KEY_ENCRYPTION_KEY=替换成 openssl rand -base64 32 的输出
```

日志轮转 `/etc/logrotate.d/relayrank`：

```text
/var/log/relayrank/*.log {
    daily
    rotate 14
    missingok
    notifempty
    compress
    copytruncate
    create 0600 relayrank relayrank
}
```

部署命令：

```bash
sudo useradd --system --home /opt/relayrank --shell /usr/sbin/nologin relayrank
sudo mkdir -p /opt/relayrank /var/lib/relayrank /var/log/relayrank
sudo unzip -o /tmp/relayrank-site-hardened-20261028.zip -d /tmp/relayrank-release
sudo cp -a /tmp/relayrank-release/relayrank-site/. /opt/relayrank/
sudo chown -R relayrank:relayrank /opt/relayrank /var/lib/relayrank /var/log/relayrank
sudo chmod 700 /var/lib/relayrank

ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -d '\n')"
KEY_ENCRYPTION_KEY="$(openssl rand -base64 32)"
sudo install -m 600 /dev/null /etc/relayrank.env
sudo tee /etc/relayrank.env >/dev/null <<EOF
ADMIN_PASSWORD=$ADMIN_PASSWORD
KEY_ENCRYPTION_KEY=$KEY_ENCRYPTION_KEY
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now relayrank
sudo systemctl status relayrank
sudo cat /var/lib/relayrank/initial-admin.txt
```

登录后台改密后删除 `/var/lib/relayrank/initial-admin.txt`，再执行：

```bash
sudo systemctl restart relayrank
```

发布 zip 不要包含 `data/`、`logs/`、`backup-*/`、`dist/`。生产数据在 `/var/lib/relayrank`，`db.json` 里有会话哈希和 API Key，属于机密数据；`/var/lib/relayrank/initial-admin.txt` 登录后立即删除。

## Windows Server 一键部署

发行包根目录带 `deploy-windows.ps1` 和 `deploy-windows.cmd`，适用于 Windows Server 2019/2022/2025 全新服务器。

直接双击 `deploy-windows.cmd`，按提示输入域名和邮箱；或在管理员 PowerShell 执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy-windows.ps1 `
  -Domain rank.example.com `
  -Email admin@example.com
```

脚本自动完成：

- 安装或检查 Node.js 22 LTS；
- 使用内置 NSSM，下载 Caddy；
- 创建 `C:\apps\relayrank`、`C:\ProgramData\RelayRank`；
- 设置 LocalService 文件权限；
- 注册 `RelayRank` 和 `Caddy` 两个 Windows 服务；
- 配置 Caddy 自动 HTTPS 和反向代理；
- 放行 Windows 防火墙 80/443；
- 生成管理员初始密码和 API Key 加密密钥。

执行前把域名 A 记录指向服务器公网 IP，并确认服务器没有 IIS 占用 80/443。脚本需要管理员 PowerShell。

## 目录

```
relayrank-site/
├─ security.js         URL/SSRF/会话/安全头工具
├─ login-guard.js      登录防爆破（持久化计数 + 指数锁定）
├─ secret-box.js       API Key 的 AES-256-GCM 加密/解密
├─ eval-sandbox.js     Docker 隔离的 Python 单测执行器
├─ probe.js            真实探测引擎（DNS/TCP/TLS/HTTP 五维打分）
├─ eval-models.js      模型质量评测引擎（题库 + 判分）
├─ server.js           服务端（HTTP + 存储 + 鉴权 + 审核 + 自动实测 + 侦探反代）
├─ detective.config.json  模型侦探目录/端口/自动拉起配置
├─ run.cmd             Windows 启动入口（数据目录 + 侦探环境变量）
├─ deploy-windows.ps1  Windows Server 一键部署脚本
├─ deploy-windows.cmd  双击运行入口（自动提权/输入域名）
├─ tools/nssm.exe      内置 NSSM 2.24 x64（无需联网下载）
├─ scripts/
│  ├─ security-reset.js  清会话/清 Key/轮换管理员密码
│  └─ unlock-login.js    查看/清除登录失败锁定
├─ data/               运行时生成，禁止打包
│  ├─ db.json
│  ├─ login-guard.json
│  └─ initial-admin.txt
└─ public/
   ├─ index.html  styles.css  app.js     前台榜单
   ├─ admin.html  admin.css   admin.js  后台
   ├─ admin-boot.js  admin-fallback.js   后台启动检查/兜底登录
   └─ uploads/    图标（seed/ 为示例站图标）
```
