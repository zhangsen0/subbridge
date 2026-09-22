# SubBridge

通用订阅转换与节点转发服务：支持多种节点协议解析，一键转换为 **Clash / Mihomo**、**sing-box**、**V2RayN** 等客户端可用的订阅格式；支持将**本机作为订阅节点**对外提供（HTTP / SOCKS5 代理 + Cloudflare Tunnel），可抓取公开订阅做**可用性检测并合并**进主订阅；支持多级鉴权、数据持久化与快捷迁移。可部署在 Waifly 等 PaaS 平台，也可通过 Docker 自托管。

> 本项目代码遵循阿里巴巴编码规范核心原则：命名清晰、单一职责、参数全配置化、可读性与可拓展性优先。开发规范见 [AGENTS.md](AGENTS.md)。

## 特性

### 订阅转换
- **多协议支持**：SS / SSR / VMess / VLESS / Trojan / Hysteria / Hysteria2 / TUIC 分享链接解析，兼容 Clash YAML、V2RayN JSON、sing-box JSON 订阅格式（自动探测）
- **多目标输出**：Clash / Mihomo（YAML）、sing-box（JSON）、分享链接（TXT）、V2RayN 订阅（BASE64）
- **多订阅合并**：一次请求可合并多个订阅地址，自动去重
- **节点处理管道**：正则包含/排除过滤、去重、排序、名称前后缀重命名

### 本机作为订阅节点（节点转发）
- **本机 HTTP / SOCKS5 代理**：纯标准库实现，支持绝对形式转发、CONNECT 隧道（HTTP）与 UDP ASSOCIATE（SOCKS5），可选 Basic 认证
- **Cloudflare Tunnel 集成**：无公网 IP 也能把本机节点映射为公网 HTTPS 地址（支持 token 远程 / 命名 / 快速三种模式）
- **订阅自动注入本机节点**：`/sub` 输出自动包含经公网地址可达的本机节点，外部客户端拉取订阅即可直接使用

### 公开订阅采集与检测
- **可用性检测**：TCP 连通检测 + 经代理下载测速，可按需丢弃不可用节点
- **自中继采集**：支持从本机可用节点中继后抓取公开订阅（`fetcher.relay_through_localnode`）
- **合并进主订阅**：配置主订阅地址（`subscription.main_urls`）后，`/sub` 默认合并主订阅 + 检测 + 本机节点；未配置时静默降级为仅返回本机节点

### 工程与安全
- **参数全配置化**：端口、超时、UA、代理、测速地址、策略组名等全部可通过配置文件 / 环境变量 / **Web 前台**修改，无需改代码
- **多级鉴权**：管理员令牌（`security.api_token`，全权限）与普通用户令牌（`security.user_token`，仅转换/订阅）；未配置令牌时完全开放
- **数据持久化与迁移**：配置、模板、订阅缓存统一走可插拔存储层（默认文件存储），支持导出/导入 JSON 一键迁移
- **SSRF 防护**：默认拦截内网/保留地址抓取
- **模板可编辑**：Clash 模板与规则模板可在前台在线编辑，保存立即生效
- **高效运行**：Node.js 异步 I/O + 受限并发抓取 + 订阅缓存（TTL）；Docker 镜像约 100MB；支持健康检查与优雅退出
- **易部署**：单进程无编译，支持 Docker / docker-compose / Waifly（Node.js Egg）等平台

## 架构

```
外部客户端 ──> /sub（本机订阅源，令牌鉴权）
                │
                ├─ 合并主订阅（subscription.main_urls，对外隐藏上游地址）
                ├─ 可用性检测（TCP/代理测速，可开关）
                └─ 注入本机节点（HTTP/SOCKS5 代理，经 CF 隧道公网可达）

/convert ──> 抓取订阅(Fetcher) ──> 格式探测(parsers) ──> 处理管道(pipeline)
                                                          │ 过滤/去重/排序/重命名
                                                          ▼
                                    Clash/sing-box/links/v2ray ──<── 转换器(converters)
```

```
subbridge/
├── app.js                  # 服务入口
├── src/
│   ├── config/             # 配置加载（defaults.yaml + data/config.yaml + 环境变量）
│   ├── core/               # 节点模型 / 抓取器 / 处理管道 / 工具函数
│   ├── parsers/            # 各协议解析器（按协议一文件，易扩展）
│   ├── converters/         # 各目标格式转换器（按格式一文件，易扩展）
│   ├── localnode/          # 本机 HTTP/SOCKS5 代理、CF 隧道、节点管理
│   ├── probe/              # 可用性检测（TCP 连通 / 代理测速）
│   ├── store/              # 可插拔存储层（文件存储打底，驱动可配）
│   └── server/             # Fastify 路由、鉴权、订阅源、备份迁移
├── templates/              # Clash 模板与规则模板（可在前台编辑覆盖）
├── web/                    # Web 前台（原生 JS，无构建，多端自适应）
├── test/                   # 单元测试（node:test）
└── data/                   # 运行时数据（gitignore：配置覆盖、模板覆盖、缓存）
```

## 快速开始

### 本地运行（Node.js >= 18）

```bash
npm install
npm start
# 打开 http://127.0.0.1:8080 使用 Web 前台
```

### Docker 运行

```bash
docker build -t subbridge .
docker run --rm -p 8080:8080 -v $(pwd)/data:/app/data subbridge
# 如需启用本机节点与 CF 隧道，按下方环境变量注入并挂载 cloudflared 二进制
```

### docker-compose

```bash
docker compose up -d
```

## 部署到 Waifly

Waifly（Pterodactyl 面板，免费额度 300MB 内存 / 30% CPU）支持 Node.js Egg，无需 Docker：

1. 在 [dash.waifly.com](https://dash.waifly.com) 的 **Servers** 页点击 **Create**，运行时选择 **Node.js**（版本 18 及以上），选择地区并创建。
2. 上传代码：使用面板 **File Manager** 或 **SFTP** 将本项目全部文件上传到服务器目录（或 `git clone https://github.com/zhangsen0/subbridge`）。
3. 在面板 **Console** 或 **Startup** 中执行安装依赖：`npm install --omit=dev`。
4. 设置启动命令为 `node app.js`；如有分配端口，通过环境变量 `PORT=<端口>` 覆盖。
5. 启动服务器，访问面板提供的域名即可。数据目录 `data/` 会持久化运行时配置与模板修改。
6. 如需启用 CF 隧道，将 `cloudflared` 二进制放入服务器任意目录，并在「服务配置 → CF 隧道」中填写二进制路径（如 `/home/container/cloudflared`）。

> 提示：免费套餐限制 300MB 内存，本项目常规运行占用约 50~80MB，满足要求。

## 部署到其他 PaaS / VPS

- **Railway / Render / Fly.io / Koyeb** 等：选择 Node.js 运行时，启动命令 `node app.js`，设置环境变量 `PORT`（平台会自动注入）。
- **任意 VPS**：`docker compose up -d` 或 `npm ci --omit=dev && node app.js`（建议搭配 pm2 / systemd）。

## 配置说明

所有参数默认值见 [src/config/defaults.yaml](src/config/defaults.yaml)，优先级：**默认配置 < data/config.yaml（前台修改） < 环境变量**。所有参数均可在 Web 前台「服务配置」页修改并持久化。

### 环境变量

| 环境变量 | 对应配置项 | 说明 |
| --- | --- | --- |
| `PORT` | server.port | 监听端口（PaaS 平台常用） |
| `HOST` | server.host | 监听地址，默认 0.0.0.0 |
| `SUBBRIDGE_UPSTREAM_PROXY` | fetcher.upstream_proxy | 上游转发代理（http/https），如 `http://user:pass@host:8080` |
| `SUBBRIDGE_API_TOKEN` | security.api_token | 管理员令牌，设置后 /convert、/sub 与 /api/* 需携带 |
| `SUBBRIDGE_USER_TOKEN` | security.user_token | 普通用户令牌，仅可访问 /convert、/sub 与 /api/me |
| `SUBBRIDGE_TIMEOUT_SECONDS` | fetcher.timeout_seconds | 订阅抓取超时（秒） |
| `SUBBRIDGE_USER_AGENT` | fetcher.user_agent | 抓取请求 UA |
| `SUBBRIDGE_DEFAULT_TARGET` | converter.default_target | 默认目标格式 |
| `SUBBRIDGE_LOG_LEVEL` | logging.level | 日志级别 |
| `SUBBRIDGE_BLOCK_PRIVATE` | fetcher.block_private | 是否启用 SSRF 防护（默认 true） |
| `SUBBRIDGE_LOCALNODE_ENABLED` | localnode.enabled | 是否启用本机节点代理 |
| `SUBBRIDGE_LOCALNODE_HTTP_PORT` | localnode.http_port | 本机 HTTP 代理端口 |
| `SUBBRIDGE_LOCALNODE_SOCKS_PORT` | localnode.socks_port | 本机 SOCKS5 代理端口 |
| `SUBBRIDGE_LOCALNODE_USERNAME` | localnode.username | 本机代理用户名（留空关闭认证） |
| `SUBBRIDGE_LOCALNODE_PASSWORD` | localnode.password | 本机代理密码 |
| `SUBBRIDGE_DATA_DIR` | 数据目录 | 运行时数据目录，默认 ./data |

### 关键配置项

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| fetcher.retries | 2 | 抓取失败重试次数 |
| fetcher.max_body_bytes | 10485760 | 订阅内容大小上限（10MB） |
| fetcher.max_concurrency | 5 | 并发抓取订阅数上限 |
| fetcher.private_host_allowlist | [] | 内网域名白名单（SSRF 防护放行） |
| fetcher.relay_through_localnode | false | 抓取公开订阅时经本机节点自中继（需 localnode 启用且存在公网地址） |
| converter.dedupe / udp / sort | true / true / "" | 去重 / UDP / 排序 |
| converter.include / exclude | "" | 节点名称正则过滤 |
| converter.rename_prefix / suffix | "" | 节点名称前后缀 |
| converter.skip_failed | true | 订阅抓取失败时跳过继续 |
| converter.clash.select_group_name | PROXY | 手动选择策略组名 |
| converter.clash.auto_group_name | AUTO | 自动测速策略组名 |
| converter.clash.url_test_url | http://www.gstatic.com/generate_204 | 测速探测地址 |
| converter.clash.url_test_interval | 300 | 测速间隔（秒） |
| probe.enabled / drop_unreachable | true / true | 可用性检测总开关 / 是否丢弃不可达节点 |
| probe.timeout_ms | 3000 | TCP 连通检测超时（毫秒） |
| probe.check_url | https://www.gstatic.com/generate_204 | 代理下载测速地址 |
| security.api_token / user_token | "" / "" | 管理员 / 普通用户令牌（留空不启用对应角色，均留空完全开放） |
| localnode.public_address | "" | 本机节点对外公网地址（优先于自动探测 / 隧道地址） |
| localnode.auto_detect_public_ip | true | 自动探测公网 IP（作为节点注入地址） |
| localnode.public_ip_detect_url | https://api.ipify.org | 公网 IP 探测接口 |
| localnode.inject_into_subscription | true | 是否把本机节点注入订阅输出 |
| cf_tunnel.enabled / binary | false / cloudflared | CF 隧道开关 / cloudflared 可执行文件路径（或命令名） |
| cf_tunnel.ingress_service | http://127.0.0.1:<http_port> | 隧道入口服务（默认指向本机 HTTP 代理） |
| subscription.main_urls | [] | 主订阅地址列表（/sub 默认合并；对外隐藏上游地址） |
| subscription.probe_by_default | true | /sub 默认是否做可用性检测（可用 probe=1/0 覆盖） |
| subscription.cache_seconds | 300 | /sub 结果缓存时长（秒，0 关闭） |
| subscription.default_target | clash | /sub 默认目标格式 |
| storage.driver | file | 存储驱动（file=文件存储；可扩展其他驱动） |

## API 文档

### 健康检查

```
GET /ping
```

### 订阅转换（核心接口）

```
GET /convert
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `url` | 是 | 订阅地址，支持多个（逗号/分号/换行分隔）或重复传参 |
| `target` | 否 | 目标格式：`clash`（默认）/ `singbox` / `links` / `v2ray` |
| `name` | 否 | 订阅名称（写入 Clash 配置 name 占位符） |
| `include` / `exclude` | 否 | 节点名称正则过滤 |
| `prefix` / `suffix` | 否 | 节点名称前后缀重命名 |
| `sort` | 否 | `name` 名称升序 / `name_desc` 名称降序 |
| `udp` | 否 | `true` / `false` 是否开启节点 UDP |
| `dedupe` | 否 | `true` / `false` 是否按 类型+服务器+端口 去重 |
| `selectGroupName` / `autoGroupName` | 否 | 覆盖 Clash 策略组名 |
| `template` | 否 | 覆盖 Clash 模板文件 |
| `token` | 否 | 接口令牌（配置了令牌时必填，也可用 `X-API-Token` 请求头） |

示例：

```bash
# 单个订阅转 Clash
curl "http://127.0.0.1:8080/convert?url=https://example.com/sub?token=xxx&target=clash&name=MySub"

# 多个订阅合并，仅保留含"香港"或"HK"的节点，加前缀，转 sing-box
curl -G "http://127.0.0.1:8080/convert" \
  --data-urlencode "url=https://a.com/sub,https://b.com/sub" \
  --data-urlencode "target=singbox" \
  --data-urlencode "include=香港|HK" \
  --data-urlencode "prefix=[机场A] "
```

### 本机订阅源（对外提供订阅）

```
GET /sub
```

外部客户端**仅凭本机订阅链接 + token** 即可拉取合并后的订阅（主订阅 + 可用节点 + 本机节点）。未配置主订阅时静默降级为**仅返回本机节点**，不会报错。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `token` | 是 | 接口令牌（也可用 `X-API-Token` 请求头） |
| `target` | 否 | 目标格式（默认取 `subscription.default_target`，clash） |
| `probe` | 否 | `1` / `0` 覆盖可用性检测开关 |
| `url` | 否 | 附加订阅地址（合并进本次输出，不写入配置） |
| `include` / `exclude` / `prefix` / `suffix` / `sort` | 否 | 与 /convert 相同 |

```bash
# 作为 Clash 订阅地址使用（把输出地址填进 Clash/Mihomo 客户端即可）
# 例：https://your-host/sub?token=你的令牌
```

### 本机节点管理

```
GET  /api/localnode   本机代理 / CF 隧道运行状态与公网地址
POST /api/localnode/restart   重启本机代理与隧道
```

### 配置管理

```
GET  /api/config            读取生效配置（敏感项脱敏）
POST /api/config            更新配置（JSON 对象，增量持久化到 data/config.yaml，立即生效）
GET  /api/templates         模板文件列表
GET  /api/templates/:name   读取模板内容
PUT  /api/templates/:name   保存模板（写入 data/templates/ 覆盖内置）
```

### 数据备份与迁移

```
GET  /api/backup    导出全部配置 / 模板覆盖 / 生成文件为单个 JSON（含令牌，注意保管）
POST /api/restore   上传备份 JSON 整体恢复（迁移语义：先清除旧键再写入）
```

> 设置令牌后，以上接口需携带令牌（`X-API-Token` 头 或 `?token=`）。`/api/*` 除 `/api/me` 外仅管理员可访问。

## 支持的协议与目标格式

| 协议 | 分享链接解析 | Clash 输出 | sing-box 输出 |
| --- | --- | --- | --- |
| Shadowsocks (ss) | ✅ | ✅ | ✅ |
| ShadowsocksR (ssr) | ✅ | ✅ | — |
| VMess | ✅ | ✅ | ✅ |
| VLESS（含 Reality） | ✅ | ✅ | ✅ |
| Trojan | ✅ | ✅ | ✅ |
| Hysteria (v1) | ✅ | ✅ | ✅ |
| Hysteria2 | ✅ | ✅ | ✅ |
| TUIC | ✅ | ✅ | ✅ |
| Clash YAML 订阅 | ✅（解析 proxies） | — | — |
| V2RayN / sing-box JSON | ✅ | — | — |

> `links` / `v2ray` 目标输出节点**原始分享链接**；来自 Clash/JSON 订阅的节点无原始链接，会被跳过（过滤、去重等规则仍然生效）。本机节点（HTTP/SOCKS5）为 Clash/sing-box 原生类型，注入仅对这两种目标生效。

## 多级用户与配置复杂度

Web 前台按登录角色展示不同复杂度：

- **管理员**：全部页签与高级选项（服务配置、模板、本机节点、订阅源、备份迁移、存储驱动）。
- **普通用户**：仅转换 / 订阅页签，可复制订阅链接、发起转换；不可见管理接口。
- **未登录**：仅公开页面与提示；未配置令牌时默认以管理员开放。

高级选项（如策略组名、测速地址、模板覆盖）默认折叠，按需展开，选择记忆于浏览器本地。

## 存储层与数据迁移

- 配置、模板覆盖、订阅缓存统一经 `src/store/` 抽象存储层访问，`storage.driver` 可切换（当前实现 `file` 文件存储，扩展新驱动只需实现同一接口并在工厂注册）。
- 配置写入采用**增量更新**（前台修改不丢失未触碰的键）；`/api/backup` / `/api/restore` 提供整体导出/导入，实现快捷迁移。

## 安全说明

- **SSRF 防护**：默认禁止抓取内网/保留地址（127.0.0.1、10.x、172.16-31.x、192.168.x、169.254.x、::1、fc00::/7 等），可通过 `fetcher.private_host_allowlist` 放行指定域名。
- **接口鉴权**：两级令牌（管理员/普通用户）；未配置任何令牌时完全开放（便于内网自用）。生产环境务必配置令牌。
- **本机代理认证**：`localnode.username/password` 未设置时本机代理不要求认证，公网暴露前请务必设置。
- **路径穿越防护**：静态资源与模板接口均校验文件名白名单。
- **敏感信息**：`/api/config` 返回内容自动脱敏（代理密码、令牌掩码）；备份 JSON 含明文令牌，请妥善保管；请勿将真实订阅地址、令牌提交到公开仓库。

## 开发指南

### 新增协议解析器

1. 在 `src/parsers/` 新增文件（如 `myproto.js`），导出 `parse(link)` 返回统一节点模型 `Proxy`。
2. 在 `src/parsers/share.js` 的 `REGISTRY` 中注册前缀。
3. 如需 Clash / sing-box 输出，在 `src/converters/clash.js` 的 `toClashProxy` 与 `src/converters/singbox.js` 的 `toSingBoxOutbound` 中补充映射。
4. 在 `test/parsers.test.js` 补充测试用例。

### 新增目标格式

1. 在 `src/converters/` 新增文件，导出 `convert(nodes, opts, ctx)`。
2. 在 `src/converters/index.js` 的 `TARGETS` 中注册，并补充 `contentTypeFor`。

### 新增存储驱动

1. 在 `src/store/` 新增文件，实现与 `fileStore` 相同的接口（readConfig / writeConfig / readTemplate / writeTemplate / readDataFile / writeDataFile / cacheGet / cacheSet / cacheDelete / dataDir）。
2. 在 `src/store/index.js` 的工厂中注册 driver 名称。
3. 在前台「服务配置 → 存储驱动」切换。

### 质量检查

```bash
make check   # 语法检查 + 单元测试（提交前必须运行）
npm test     # 仅运行单元测试
```

## License

[MIT](LICENSE) © 2026 zhangsen0
