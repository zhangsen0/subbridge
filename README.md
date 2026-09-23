# SubBridge

**订阅管理与节点质量检测系统** —— 把"订阅源管理 → 节点解析入库 → 可用性检测 → 规则选取 → 多格式输出"串起来的一站式订阅管理工具。

- 从**任意来源**导入订阅：订阅链接、网页（自动发现并递归）、直接粘贴文本、站点（如 vpngate），自动识别多种协议
- 所有节点（含主订阅、其他订阅源）统一**入节点池**，自动补充/更新、不自动删除；支持手动/按规则开关与自定义清理逻辑
- 外部客户端仅凭**一条订阅链接 + 令牌**即可拉取合并后的订阅，输出格式兼容 Clash / sing-box / V2RayN 等主流客户端
- 内置**一键配置向导**（20 个使用场景模板）、登录页与多级角色、三级使用难度 UI、全站参数表、事件日志，是一个完整系统而非架子
- 支持 Docker 自托管与主流 PaaS 部署（Render / Zeabur / Waifly 等）

> 代码遵循阿里巴巴编码规范核心原则：英文命名 / 中文注释、参数全配置化、禁止写死、可读性与可拓展性优先。开发规范见 [AGENTS.md](AGENTS.md)。

> **使用须知**：请遵守所在国家/地区的法律法规及所部署平台的服务条款。本工具面向网络基础设施管理、订阅管理与服务质量检测等合法场景（如企业海外网络管理、开发者联调、学术科研网络需求）。请勿用于任何违法违规用途，部署者自行承担合规责任。

## 特性

### 一键配置向导（不懂也能用）
- **三步配好**：选场景 → 填订阅（可留空）→ 开关 → 确认应用，全程下一步/上一步，无需理解协议
- **20 个使用场景模板**：日常上网 / 视频流媒体 / 游戏加速 / 办公远程 / 跨境电商 / 自媒体运营 / 留学生 / 回国加速 / 学术科研 / 开发者调试 / 语音视频通话 / 大文件下载 / 轻量浏览 / 高可用容灾 / 隐私保护 / 直播推流 / 数据采集 / 移动端省电 / 企业组网 / 极客折腾
- 每场景内置：选取规则 + 质量门槛 + 清理规则 + 推荐参数补丁；一键应用即写配置并生效，之后随时可在全站参数调整
- 入口：驾驶舱顶栏「🚀 快速开始」/ 登录页「快速开始」/ 新手引导卡；未登录自动引导去登录

### 订阅源管理（主功能）
- **自动识别**：订阅链接（SS / SSR / VMess / VLESS / Trojan / Hysteria / Hysteria2 / TUIC，以及 Clash YAML、V2RayN JSON、sing-box JSON 订阅）· 网页（自动发现页面内订阅链接并递归抓取，深度/数量可配）· 直接粘贴节点文本 · 站点适配器（vpngate 等，可扩展）
- **多订阅拉取**：一次导入支持多个订阅链接（逗号/换行分隔）；可配置「其他订阅源」列表自动拉取入库
- **自定义请求头**：全局 `fetcher.headers`（JSON），也支持请求参数 `?headers=` 临时覆盖，满足需鉴权的订阅源
- **抓取链路可配置**：默认本机直连；可配置上游网关（`fetcher.upstream_proxy`）或从节点池挑选可用节点作为抓取上游；`fetcher.pool_empty_fallback_direct` 控制池空时是否放行直连
- **内置规则模板一键初始化**：规则 / 质量门槛 / 清理规则各内置多套现成模板（`GET /api/presets`），前台一键填入，无需手写
- **抓取即入库**：抓取结果自动补充/更新进节点池（来源标注进节点备注），不会自动删除

### 节点池（资产库）
- **累积与开关**：按 `类型:服务器:端口` 去重 upsert；节点可手动启用/停用（停用不输出），新节点默认启用可配置
- **质量门槛**：按 alive / latency / speed / 质量分（可用性 40 + 延迟 30 + 速度 30）多指标自动开关节点（`pool.quality_gates`），默认关闭、可手动强制执行
- **自定义清理逻辑**：按 unreachable / stale / no_probe / latency / speed / score / name / source 规则自动清理（`pool.cleanup_rules`），默认关闭、可手动执行
- **自定义选取规则**：从节点池按 include/exclude/type/country/source/latency/speed/sort/limit 规则选取节点生成订阅（`/sub?rules=` 或配置 `subscription.rules`），规则默认开启、可逐条停用

### 订阅输出（/sub）
- **所有节点都从池来**：主订阅、其他订阅源、网页/文本抓取统一入池，`/sub` 输出 = 节点池启用节点（可含停用 `?include_disabled=1`）
- 上游订阅地址对外隐藏；外部仅凭订阅链接 + 令牌拉取
- 可用性检测（TCP + 真实测速）可开关，检测结果写回节点池
- 输出格式：Clash / sing-box / 分享链接 / V2RayN（base64）

### 系统与工程
- **登录页 + 多级角色**：账号密码（`security.*_username/password`）或令牌登录；管理员全权限、普通用户仅抓取/订阅/节点库
- **三级使用难度 UI**：简单（驾驶舱+节点库）/ 高级（+事件日志/本地节点/全站参数/规则/质量/清理）/ 专家（+原始 JSON 调试 + 配置原文 YAML），一键切换
- **驾驶舱主页**：KPI 概览（节点池/可用/停用、抓取日志、主订阅源）、**本机订阅链接常驻一键复制**、抓取输入区、最近动态双栏
- **全站参数表**：所有参数分组展示、可搜索、可编辑保存立即生效；专家模式可直改 YAML 原文
- **事件日志**：抓取（含网页递归子链接、使用的上游）、测速、节点池变更、配置变更、系统操作，全站可检测数据均有记录，可按类型/结果筛选
- **节点接入能力**：可把部署主机作为订阅节点对外提供接入（HTTP / SOCKS5，纯标准库），支持端口复用（`localnode.mode=shared`，与 Web 同端口）与 Cloudflare Tunnel（token / 命名 / 快速三模式）；本地节点页展示接入信息并支持一键复制
- **加载永不"卡死"**：前台请求带超时（`ui.request_timeout_seconds` 可配），超时/失败显示「加载失败·点击重试」；未登录时主页显示「未登录·点击登录」引导，不再一直转圈
- **数据持久化与迁移**：配置/模板/节点池经可插拔存储层增量持久化，支持**文件存储（默认，零依赖）**与 **SQLite（`storage.driver=sqlite`，需 `npm install better-sqlite3`）**；导出/导入 JSON 一键迁移（含节点池）
- **安全**：SSRF 防护（默认拦截内网）、令牌/账号鉴权、模板白名单、日志脱敏

## 快速开始

### 本地运行

```bash
npm install
npm start          # 默认 0.0.0.0:8080
```

打开 http://localhost:8080 进入驾驶舱。

**不想研究配置？** 点顶栏「🚀 快速开始」：选一个使用场景 → 粘贴订阅链接（可留空）→ 确认应用，三步完成。

**想自己配？** 在「全站参数」配置主订阅地址、令牌等；在驾驶舱输入订阅链接/网页/文本点击「抓取并入库」。

### 外部客户端订阅链接

`http://<你的域名>:8080/sub?token=<管理员或用户令牌>`

- 转换格式：链接加 `&target=clash|singbox|links|v2ray`
- 规则取节点：链接加 `&rules=<JSON数组>`（也可在参数表配置 `subscription.rules`）
- 含停用节点：`&include_disabled=1`；跳过检测：`&probe=0`

## 接口速查

| 接口 | 说明 | 权限 |
| --- | --- | --- |
| `GET /login` | 登录页（账号密码 / 令牌） | 公开 |
| `POST /api/login` | 登录，返回角色令牌 | 公开 |
| `GET /api/me` | 当前角色与本机订阅链接 | 管理员/用户 |
| `GET /api/dashboard` | 驾驶舱聚合（KPI/最近动态/订阅链接） | 管理员/用户 |
| `GET /api/grab?url=...` | 抓取预览：自动识别 → 入库 → 返回节点明细/统计 | 管理员/用户 |
| `GET /api/probe?url=...` | 抓取并实时测速，结果写回池 | 管理员/用户 |
| `GET /api/pool?search=&type=&enabled=&ok=` | 节点库列表（脱敏，含质量分） | 管理员/用户 |
| `POST /api/pool/probe` | 全池测速（写回），测速后自动应用质量门槛/清理 | 管理员 |
| `POST /api/pool/toggle` | 开关节点 `{key, enabled}` | 管理员 |
| `POST /api/pool/remove` / `clear` | 删除 / 清空节点 | 管理员 |
| `POST /api/pool/apply-quality` | 手动应用质量门槛 | 管理员 |
| `POST /api/pool/cleanup` | 手动执行自动清理 | 管理员 |
| `GET /api/logs?type=&ok=&limit=` | 事件日志 | 管理员 |
| `POST /api/logs/clear` | 清空日志 | 管理员 |
| `GET/POST /api/config` | 读取 / 增量更新配置（嵌套对象，白名单顶层键） | 管理员 |
| `GET/POST /api/config/raw` | 配置原文 YAML 读取 / 更新（专家模式） | 管理员 |
| `GET /api/localnode` / `POST /api/localnode/restart` | 本地节点接入状态 / 重启 | 管理员 |
| `GET /api/templates` / `GET|PUT /api/templates/:name` | 模板管理 | 管理员 |
| `GET /api/backup` / `POST /api/restore` | 数据备份导出 / 导入迁移（含节点池） | 管理员 |
| `GET /api/scenarios` / `POST /api/setup/apply` | 一键配置向导：场景列表 / 一键应用 | 管理员 |
| `GET /convert?url=&target=...` | 实时转换（`&rules=` 支持规则取节点） | 管理员/用户 |
| `GET /sub` | 本机订阅源（输出 = 节点池启用节点） | 管理员/用户 |
| `GET /ping` | 健康检查 | 公开 |

## 配置

全部参数配置化，可在「全站参数」前台修改，也可用环境变量覆盖。主要分组：

- **抓取** `fetcher.*`：超时/重试/UA/并发/上游网关/池内节点/自定义头/SSRF 防护；`grab.*`：网页递归深度/链接数/特征关键词
- **节点池** `pool.*`：默认启用、包含停用、质量门槛（开关/模式/未测放行/门槛列表）、自动清理（开关/规则列表）、输出剔除不可达
- **订阅源** `subscription.*`：主订阅地址、其他订阅源（`名称|URL`）、合并策略、缓存、默认格式、选取规则
- **转换** `converter.*`：默认目标、去重、来源备注、过滤/重命名、Clash 策略组
- **检测** `probe.*`：开关、并发、超时、上游探测网关（http/socks5）、真实测速、追加延迟、剔除不可达
- **本地节点** `localnode.*`（含 `mode: standalone/shared` 端口复用）与 **隧道** `cf_tunnel.*`
- **界面** `ui.*`：前台请求超时秒数
- **安全** `security.*`：管理员/用户令牌与账号密码
- **存储与日志** `storage.driver`、`fetch_log.capacity`、`logging.level`

关键环境变量：`PORT` `HOST` `SUBBRIDGE_API_TOKEN` `SUBBRIDGE_USER_TOKEN` `SUBBRIDGE_ADMIN_USERNAME/PASSWORD` `SUBBRIDGE_USER_USERNAME/PASSWORD` `SUBBRIDGE_UPSTREAM_PROXY` `SUBBRIDGE_BLOCK_PRIVATE` `SUBBRIDGE_LOCALNODE_*` `SUBBRIDGE_CF_TUNNEL_*` 等（完整见 `src/config/loader.js`）。

## 部署

### 方式一：Docker 自托管（推荐生产使用）

需要：Docker 19+（或 Docker Compose）。

```bash
# 1. 克隆仓库
git clone https://github.com/zhangsen0/subbridge.git
cd subbridge

# 2. 构建并启动（默认 0.0.0.0:8080）
docker compose up -d

# 3. 查看日志
docker compose logs -f
```

Docker Compose 会：
- 构建 `node:22-alpine` 镜像并安装生产依赖
- 挂载 `./data` 目录持久化配置、节点池、模板（重启不丢失）
- 默认暴露 `8080` 端口（可在 `docker-compose.yml` 或环境变量 `PORT` 修改）

停止：`docker compose down`；更新：`git pull && docker compose up -d --build`。

### 方式二：Render（免费 PaaS，零成本体验）

需要：GitHub 账号 + 手机号验证。**免费档限制**：750 小时/月、15 分钟无流量休眠（冷启动 30-60s）、实例重启后磁盘数据清空（见下方「数据持久化」）。

1. **创建服务**：登录 [render.com](https://render.com) → 右上角 **New** → **Web Service**
2. **连接仓库**：授权 GitHub → 选择 `zhangsen0/subbridge`
3. **基础配置**：
   | 配置项 | 填写 |
   | --- | --- |
   | Name | `subbridge`（自定义） |
   | Language | 选 **Node**（不要选 Docker，构建更快更省额度） |
   | Region | **Singapore**（亚洲访问延迟最低） |
   | Branch | `main` |
4. **构建与启动**：
   - Build Command：`npm install --omit=dev`
   - Start Command：`npm start`
   - Instance Type：**Free**
5. **环境变量**（Environment 区域添加）：
   | Key | Value |
   | --- | --- |
   | `SUBBRIDGE_API_TOKEN` | 一串随机字符（建议 UUID），订阅链接鉴权用 |
   | `SUBBRIDGE_ADMIN_USERNAME` | `admin` |
   | `SUBBRIDGE_ADMIN_PASSWORD` | 你的登录密码 |
   | `PORT` | 留空（Render 自动注入） |
6. **部署**：点 **Deploy Web Service**，等 3-5 分钟，日志出现 `SubBridge 已启动` 即成功
7. **访问**：`https://<服务名>.onrender.com` → 登录 → 驾驶舱顶部「本机订阅链接」一键复制

**免费档数据持久化**：实例重启/重新部署会清空 `data/` 目录（配置、节点池丢失）。对策：
- 登录后在「备份迁移」随时导出 JSON 留底；重启后重新导入（新版导入含节点池，立即可见）
- 或配置「其他订阅源」+ 抓取，让节点自动回补

**自定义域名**：Settings → Custom Domains → 添加域名 → 到域名商 DNS 加 CNAME（`sub` → `<服务名>.onrender.com`）→ 自动签发 HTTPS。建议套 Cloudflare CDN 加速与隐藏真实 IP。

### 方式三：Zeabur

Zeabur 免费档为「管理自有服务器」模式，免费托管已下线；若你有自购服务器可通过 Zeabur 控制台统一管理并部署（构建命令/环境变量同上）。详见 [zeabur.com/pricing](https://zeabur.com/pricing)。

### 方式四：VPS / 云主机

任意 Linux 主机（1C1G 即可）：

```bash
git clone https://github.com/zhangsen0/subbridge.git && cd subbridge
npm install --omit=dev
# 生产建议用 pm2 守护
npm i -g pm2
PORT=8080 SUBBRIDGE_API_TOKEN=你的令牌 pm2 start app.js --name subbridge
pm2 save && pm2 startup
```

配合 Nginx 反代 + HTTPS 证书（Caddy / certbot）可获得稳定公网访问。

## 开发

### 项目结构

```
src/config/       配置加载：defaults.yaml（默认值）+ data/config.yaml（前台覆盖）+ 环境变量
src/core/         proxy（统一节点模型）/ fetcher（抓取，SSRF 防护、上游网关）
                  grabber（抓取中心：自动识别/网页递归）/ nodePool（节点池）
                  rules（选取规则）/ quality（质量门槛）/ cleanup（清理逻辑）/ poolProxy（池内节点）
src/grabbers/     站点适配器框架（vpngate 等）
src/parsers/      协议解析器：ss/ssr/vmess/vless/trojan/hysteria/hysteria2/tuic/clash/v2ray
src/converters/   目标格式：clash / singbox / links / v2ray
src/server/       路由：convert / subscribe / grabApi / dashboardApi / poolApi / probeApi
                  qualityApi / loginApi / configApi / backupApi / scenarioApi / fetchLog（事件日志）
web/              Web 前台（index.html + app.js + style.css + login.html + setup.html）
templates/        clash.tmpl.yaml（{{proxies}} {{proxy-groups}} {{rules}} {{name}}）、rules.tmpl.txt（{{proxy}}）
test/             单元测试（node:test）
```

### 扩展指南

- **新增协议**：`src/parsers/` 新增文件导出 `parse(link)`，在 `share.js` 的 `REGISTRY` 注册前缀，并在 `converters/clash.js` / `singbox.js` 补映射，最后补测试
- **新增目标格式**：`src/converters/` 新增文件导出 `convert(nodes, opts, ctx)`，在 `index.js` 注册并补 `contentTypeFor` / `TARGET_TYPE_SUPPORT`
- **新增站点适配器**：在 `src/grabbers/` 注册域名与 URL 归一化规则，返回订阅链接/节点列表
- **新增配置项**：`src/config/defaults.yaml` 加默认值；如需环境变量支持加到 `loader.js` 的 `ENV_MAP`；前台字段在 `web/app.js` 的 `CONFIG_FIELDS` 注册
- **新增事件类型**：`FetchLog.record` 的 `type` 字段自由扩展，前台 `web/app.js` 的 `LOG_TYPES` 补充中文名

### 测试与提交

```bash
npm run check                     # 语法检查 + 全部单元测试（提交前必须全绿）
npm test
node scripts/smoke-api-test.js    # 接口冒烟（需本地服务 18081 运行，含 admin-token 环境）
python3 scripts/test-all-ui.py       # 全量浏览器级 UI 测试 67 项（登录/模式/节点池/规则/质量/清理/备份/向导/复制/失败重试/未登录引导）
python3 scripts/test-wizard-ui.py    # 一键配置向导流程测试 18 项
python3 scripts/mock-sources.js      # 本地抓取测试源（订阅/base64/Clash/网页/vpngate 模拟，端口 18100）
```

commit 一律使用中文；提交前必须 `npm run check` 全绿。

## License

MIT
