# RelayRank · 大模型中转站测评榜单

给 AI API 中转站做体检：五维真实探测、模型质量评测、提交自动审核、可视化榜单。

零运行时依赖的 Node.js 单文件服务，前台榜单 + 管理后台 + 审核流水线一条龙，数据落在本地 `db.json`。

```
Node >= 18  ·  零依赖  ·  SQLite 都不用  ·  一个 json 文件装下全站
```

---

## 目录

- [为什么做这个](#为什么做这个)
- [核心特性](#核心特性)
- [评分体系](#评分体系)
- [实测引擎](#实测引擎)
- [模型质量评测](#模型质量评测)
- [自动实测与自动审核](#自动实测与自动审核)
- [审核流程](#审核流程)
- [快速开始](#快速开始)
- [配置项](#配置项)
- [HTTP 接口](#http-接口)
- [安全设计](#安全设计)
- [生产部署](#生产部署)
- [目录结构](#目录结构)
- [设计取舍](#设计取舍)
- [路线图](#路线图)

---

## 为什么做这个

大模型中转站越开越多，宣传页上写"稳定 99.9%"、"支持 Claude / GPT / Gemini"，实际用起来：

- 首页能打开，`/v1/chat/completions` 却 502
- 流式请求第一个 token 等 20 秒
- 并发一上去就排队，或者直接限流
- 模型列表写着 20 个，真正能调的只有 3 个
- 说是 GPT-4，回包 `model` 字段却是 `some-other-model`

人工挨个试太慢，凭感觉打分太主观。RelayRank 把这些做成可重复、可量化、可复核的自动检测：

**同一套请求、同一套计时、同一套判分，对所有站点跑一遍，把结果摆在一张榜上。**

---

## 核心特性

| 模块 | 能力 |
|---|---|
| 五维实测 | 连通、目录、补全、流式、并发，全部是真实 HTTP 请求的成功率 |
| 模型评测 | 19 题题库 + 本地代码单测，性能/能力/上下文三项独立打分 |
| 自动实测 | 定时串行复测，结果写回榜单，前后端自动刷新 |
| 自动审核 | 访客提交后自动跑实测，达标直接上线，不达标转人工 |
| 提交审核 | 蜜罐字段 + IP 限流，公开提交永远不能改已发布站点 |
| 管理后台 | 增删改查、批量导入导出、批量审核、图标上传、改密 |
| 登录防护 | scrypt 加盐、持久化防爆破、指数锁定、CSRF 全覆盖 |
| 零依赖 | `package.json` 没有 `dependencies`，`node server.js` 就能跑 |

---

## 评分体系

五个维度都是**成功率百分比**，按业务权重加权：

| 维度 | 键名 | 权重 | 测什么 | SLA |
|---|---|---|---|---|
| 连通成功率 | `reach` | 10% | 首页 HTTP 可达、TTFB | ≤ 3000 ms |
| 目录成功率 | `catalog` | 15% | `/v1/models` 可读、模型数量 | ≤ 5000 ms |
| 补全成功率 | `chat` | 25% | `/v1/chat/completions` 正常回包 | ≤ 10000 ms |
| 流式成功率 | `stream` | 25% | 首个 `data:` 分片到达时间 | ≤ 10000 ms |
| 并发成功率 | `concurrent` | 25% | 3 路 + 5 路并发整轮完成 | ≤ 30000 ms |

```
综合分 = reach×0.10 + catalog×0.15 + chat×0.25 + stream×0.25 + concurrent×0.25
```

等级：

```
S ≥ 90   A ≥ 80   B ≥ 70   C ≥ 60   D < 60
```

**缺测按 0 计入。** 没测到的维度就是没有分数支撑，不给"默认 60 分"这种安慰奖。

---

## 实测引擎

`probe.js` 对目标站发真实请求，不做任何模拟：

```
连通   5 次首页请求，统计 TTFB 达标率
目录   5 次 /v1/models，统计成功率和模型条数
补全   8 次 /v1/chat/completions，统计 200 + 非空正文
流式   8 次 stream=true，统计首个分片到达时间
并发   3 路 + 5 路同时打，统计整轮成功率
```

每一维都记录逐次证据（耗时、状态码、是否达标），存进 `site.probe.evidence`，可以在后台点开看每一次的原始结果。

探测结果结构：

```json
{
  "at": "2026-10-31T02:51:59.878Z",
  "durationMs": 68001,
  "reachable": true,
  "dims": { "reach": 100, "catalog": 100, "chat": 100, "stream": 100, "concurrent": 100 },
  "samples": 3,
  "metrics": { "dns": 0, "tcp": 179.8, "tls": 540.5, "ttfb": 718.1, "total": 768.5, "status": 200 },
  "sla": { "reach": 3000, "catalog": 5000, "chat": 10000, "stream": 10000, "concurrent": 30000 }
}
```

没有 API Key 时只能测连通和目录，补全/流式/并发三维留空。**这就是为什么提交表单要填 Key** —— 不填，榜单上就只有半个分数。

---

## 模型质量评测

站点分和模型分是两套东西，分开算、分开存、分开排序。

| 面 | 权重 | 指标 | 判分方式 |
|---|---|---|---|
| 性能 | 20% | TTFT、tok/s、抖动 | 流式请求 3 次，抓首个 `data:` 分片 |
| 能力 | 60% | 19 题通过率 | 固定题库，正则 / JSON / 本地单测 |
| 上下文 | 20% | 真实可捞回长度 | 逐级塞 8k / 32k，中间埋 `ZEBRA-7741` |

19 道题：

| 类别 | 题数 | 判分 | 例子 |
|---|---|---|---|
| 数学 | 5 | 正则提数比对 | `17 × 23 = ?` → `391` |
| 指令跟随 | 5 | 严格格式校验 | "只输出 OK" → `trim() === "OK"` |
| 中文理解 | 4 | 关键词命中 | "差点没摔倒" → 必须答"没摔倒" |
| 代码 | 4 | 提取代码块，写临时文件跑单测 | `add()` / `reverse_string()` / `is_prime()` / `fib()` |
| 工具调用 | 1 | `tool_calls` 结构 + arguments 合法 JSON | `get_weather({"city":"北京"})` |

代码题是本机 `spawnSync` 跑 6 秒超时的单测，看有没有 `AssertionError`；开了 `EVAL_SANDBOX=1` 就只走 Docker：`--network=none`、只读根、非 root、128 MB 内存、0.5 CPU、64 PID、丢弃全部 capability。

**分数不请模型当裁判。** 全部由程序判定，同一份回答永远得到同一个分。

```bash
node eval-models.js --url=https://api.example.com --key=sk-xxx --model=gpt-4o-mini
```

输出完整 JSON：19 题逐题结果、TTFT、tok/s、上下文逐级验证明细。

---

## 自动实测与自动审核

### 自动实测

后台面板可开关、改间隔（5 分钟 – 24 小时，默认 5 分钟）、选范围（只看已发布 / 已发布 + 待审）。

- 调度器每 30 秒检查 `db.settings.autoProbe.nextRunAt`，到点后串行执行，避免并发打爆目标站
- 默认「只测有 API Key 的站点」：没有 Key 强行测会把补全/流式/并发打成 0
- 每轮写回 `lastRunAt` / `lastFinishedAt` / `lastSummary`，按完成时间重算下一次，不会因为单轮耗时漂移

### 自动审核

访客提交站点时如果填了 API Key，系统自动排队实测，按三项标准判定：

| 条件 | 默认值 |
|---|---|
| 综合分 | ≥ 75 |
| 任一已测维度 | ≥ 60 |
| 至少测到维度数 | 5 |

三项全满足 → 直接 `published` 上线；任一不满足 → 留在 `pending` 等人工，并记录未通过原因。

```
[approve]  TinyGate  自动审核通过 — 综合分 100（S）· 连通 100 / 目录 100 / 补全 100 / 流式 100 / 并发 100
[auto-review] 某站点  自动审核未通过 — 站点不可达
```

阈值存在 `db.settings.autoReview`，后台「自动实测」面板可改，保存即时生效。只对 `pending` 站点生效，已发布站点的定期复测不会改状态。

---

## 审核流程

```
访客提交 /api/submit ─┐
后台新增站点 ─────────┼─→ status=pending ─→ 自动实测 ─┬─ 达标 → published（自动）
批量导入 ─────────────┘                              └─ 不达标 → 人工审核 ─┬─ approve → published
                                                                          └─ reject  → rejected
```

公开接口 `GET /api/sites` 只返回 `published`。待审、驳回、草稿一律不出现。

后台动作：

| 操作 | 说明 |
|---|---|
| 通过 | `pending/rejected → published` |
| 驳回 | 必须填原因，公开榜不可见 |
| 回待审 | `published/rejected → pending` |
| 批量通过 / 驳回 | 勾选后一次处理 |
| 新增 / 编辑 | 五维滑杆实时算总分，可上传图标 |
| 批量导入 | JSON 或 CSV，默认进待审 |
| 导出 | `/api/admin/export`，API Key 脱敏 |

---

## 快速开始

```bash
git clone https://github.com/<your-name>/relayrank.git
cd relayrank
node server.js --port=8803
```

打开：

- 前台：`http://127.0.0.1:8803/`
- 后台：`http://127.0.0.1:8803/admin`
- 首次启动自动生成 `data/initial-admin.txt`，里面是 `admin` 和随机 20 位密码

Windows 双击 `run.cmd` 也行，它会自动探测数据目录并设置环境变量。

预设密码：

```bash
ADMIN_PASSWORD='至少12位强密码' node server.js
```

---

## 配置项

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8803` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，生产建议 `127.0.0.1` |
| `DATA_DIR` | `./data` | 数据库与会话存放目录 |
| `LOG_DIR` | `./logs` | 日志目录 |
| `TRUST_PROXY` | `1` | 反代后取 `X-Forwarded-For` |
| `COOKIE_SECURE` | 自动 | HTTPS 下为 `1`；纯 HTTP 必须设 `0` |
| `ADMIN_PASSWORD` | 随机 | 启动时覆盖管理员密码，至少 12 位 |
| `KEY_ENCRYPTION_KEY` | 空 | 设置后 API Key 用 AES-256-GCM 加密落盘 |
| `ENABLE_DETECTIVE` | `1` | 是否反代模型侦探 Flask 服务 |
| `DETECTIVE_PORT` | `5000` | 侦探服务端口 |
| `EVAL_SANDBOX` | `0` | 设为 `1` 时代码题只走 Docker |

`detective.config.json` 管侦探的 `dir` / `python` / `port` / `enabled` / `autostart`。

---

## HTTP 接口

| 方法 | 路径 | 鉴权 |
|---|---|---|
| GET | `/api/health` | 否 |
| GET | `/api/sites` | 否（仅 published） |
| POST | `/api/submit` | 否（10 次/10 分钟/IP，带蜜罐字段） |
| POST | `/api/admin/login` | 密码，5 次/5 分钟 |
| GET | `/api/admin/session` | Cookie |
| GET | `/api/admin/sites?status=` | Cookie |
| POST | `/api/admin/sites` | Cookie + CSRF |
| PUT / DELETE | `/api/admin/sites/:id` | Cookie + CSRF |
| POST | `/api/admin/sites/:id/probe` | Cookie + CSRF |
| POST | `/api/admin/sites/:id/eval` | Cookie + CSRF |
| POST | `/api/admin/sites/:id/review` | Cookie + CSRF，`{action: approve\|reject\|reset}` |
| POST | `/api/admin/reviews/bulk` | Cookie + CSRF |
| POST | `/api/admin/import` | Cookie + CSRF，`{format: json\|csv, text, publish}` |
| POST | `/api/admin/upload` | Cookie + CSRF，仅 PNG/JPG/WEBP/ICO，≤ 2 MB |
| GET | `/api/admin/export` | Cookie |
| POST | `/api/admin/password` | Cookie + CSRF |

提交示例：

```bash
curl -X POST http://127.0.0.1:8803/api/submit \
  -H "Content-Type: application/json" \
  -d '{
    "name": "MyRelay",
    "domain": "api.example.com",
    "url": "https://api.example.com",
    "kind": "commercial",
    "apiKey": "sk-xxx",
    "note": "稳定，支持 Claude / GPT"
  }'
```

返回：

```json
{
  "ok": true,
  "status": "pending",
  "autoReview": true,
  "message": "提交成功，正在自动实测；综合分与五维达标后自动上线，不达标进人工审核。",
  "id": "st_7f412def2431"
}
```

---

## 安全设计

这不是一个"能跑就行"的玩具，默认就按公网可暴露的标准写：

- **密码**：`scrypt` 加盐哈希；登录接口不返回 token
- **会话**：库里只存 `sha256(sid)` 和随机 CSRF，Cookie 是 `HttpOnly; SameSite=Strict; Secure`，8 小时绝对过期
- **CSRF**：所有写操作校验 `X-CSRF-Token`
- **防爆破**：同一「用户名 + IP」15 分钟失败 5 次锁 15 分钟，连续触发按 2 倍递增；同一 IP 15 分钟失败 20 次锁 30 分钟；全站 120 次/分钟暂停 60 秒；账号不存在也执行一次 scrypt，避免响应时间枚举
- **SSRF**：只允许 HTTP/HTTPS，默认拒绝私网/回环/链路本地/云元数据地址；带 Key 的请求只允许 HTTPS；DNS 解析结果固定后连接，防 rebinding
- **响应体上限**：探测 2 MB、评测 4 MB，总超时 = 单次超时 + 2 秒
- **上传**：只收 PNG/JPG/WEBP/ICO，按文件头校验，拒 SVG；SVG 静态文件额外加 `CSP: sandbox`
- **静态目录**：`path.relative` + `realpath` 双重校验，阻止 `..` 与符号链接逃逸
- **密钥**：设置 `KEY_ENCRYPTION_KEY` 后 API Key 用 AES-256-GCM 加密；后台列表和导出永远脱敏
- **数据**：原子写入（临时文件 + rename），损坏自动回滚 `db.json.bak`
- **日志**：token / key / password 参数全部脱敏

---

## 生产部署

### Linux（nginx + systemd + TLS）

Node 只监听回环，TLS 和限流交给 nginx。

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
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

nginx 反代：

```nginx
server {
    listen 443 ssl http2;
    server_name rank.example.com;

    ssl_certificate     /etc/letsencrypt/live/rank.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/rank.example.com/privkey.pem;

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

### Windows Server（一键）

发行包根目录带 `deploy-windows.ps1` 和 `deploy-windows.cmd`：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy-windows.ps1 `
  -Domain rank.example.com `
  -Email admin@example.com
```

脚本自动完成：安装 Node.js 22 LTS、内置 NSSM 注册服务、下载 Caddy 配自动 HTTPS、建目录、设权限、放行防火墙、生成管理员密码和加密密钥。

执行前把域名 A 记录指向服务器公网 IP，确认 80/443 没被 IIS 占用。

---

## 目录结构

```
relayrank-site/
├─ server.js            服务端（HTTP + 存储 + 鉴权 + 审核 + 自动实测 + 侦探反代）
├─ probe.js             探测引擎（DNS/TCP/TLS/HTTP 五维成功率）
├─ eval-models.js       模型评测引擎（19 题题库 + 判分）
├─ eval-sandbox.js      Docker 隔离的 Python 单测执行器
├─ security.js          URL/SSRF/会话/安全头工具
├─ login-guard.js       登录防爆破（持久化计数 + 指数锁定）
├─ secret-box.js        API Key 的 AES-256-GCM 加解密
├─ detective.config.json  模型侦探目录/端口/自动拉起配置
├─ run.cmd              Windows 启动入口
├─ deploy-windows.ps1   Windows Server 一键部署
├─ tools/nssm.exe       内置 NSSM 2.24 x64
├─ scripts/
│  ├─ security-reset.js  清会话 / 清 Key / 轮换密码
│  ├─ set-password.js    只换密码，不动站点
│  └─ unlock-login.js    查看 / 清除登录锁定
├─ data/                运行时生成，禁止打包
│  ├─ db.json
│  ├─ login-guard.json
│  └─ initial-admin.txt
└─ public/
   ├─ index.html  styles.css  app.js     前台榜单
   ├─ admin.html  admin.css   admin.js  管理后台
   ├─ admin-boot.js  admin-fallback.js   启动检查 / 兜底登录
   └─ uploads/    站点图标（seed/ 为例图）
```

---

## 设计取舍

**为什么不用数据库？**
站点量级是几百到几千，`db.json` 全量读进内存完全够用。省掉 ORM、连接池、迁移脚本，部署就是解压 + `node server.js`。原子写入 + `.bak` 回滚已经覆盖单机场景的可靠性需求。

**为什么探测要串行？**
并发探测会把目标站打限流，测出来的"成功率"是探测器自己造成的。串行慢一点，但数据是真的。

**为什么缺测按 0 算？**
"没测到"和"测了很好"是两回事。给缺测默认分会让没配 Key 的站点凭空拿到一个体面分数，榜单就失去意义了。

**为什么模型分和站点分分开？**
站点分衡量线路和配置，模型分衡量模型本身。混在一起，一个快但笨的模型会被线路分拉高，一个聪明但慢的模型会被线路分拖低。

**为什么自动审核还要保留人工？**
自动审核只处理"有 Key + 五维齐全 + 分数够"的提交，覆盖大部分正常情况。没 Key、测不全、分数擦线的，交给人工看日志和备注。自动化省掉重复劳动，不替代判断。

---

## 路线图

- [ ] 历史趋势图（每个站点五维随时间变化）
- [ ] 多节点探测（不同地区分别测，取中位数）
- [ ] 站点对比页（并排看两家的逐项差异）
- [ ] 公开 API 的只读 Token
- [ ] 探测结果导出 CSV
- [ ] 模型评测题库可配置

---

## 许可

仓库暂未声明开源许可证。使用、修改、分发前请先联系作者。
