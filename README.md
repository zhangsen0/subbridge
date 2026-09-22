# SubBridge

通用订阅转换与节点转发服务：支持多种节点协议解析，一键转换为 **Clash / Mihomo**、**sing-box**、**V2RayN** 等客户端可用的订阅格式；支持 HTTP(S) 订阅抓取与上游代理转发，可部署在 Waifly 等 PaaS 平台，也可通过 Docker 自托管。

> 本项目代码遵循阿里巴巴编码规范核心原则：命名清晰、单一职责、参数全配置化、可读性与可拓展性优先。开发规范见 [AGENTS.md](AGENTS.md)。

## 特性

- **多协议支持**：SS / SSR / VMess / VLESS / Trojan / Hysteria / Hysteria2 / TUIC 分享链接解析，兼容 Clash YAML、V2RayN JSON、sing-box JSON 订阅格式
- **多目标输出**：Clash / Mihomo（YAML）、sing-box（JSON）、分享链接（TXT）、V2RayN 订阅（BASE64）
- **HTTP(S) 抓取与转发**：支持抓取 http/https 订阅地址；支持配置上游转发代理（http/https）统一出口
- **多订阅合并**：一次请求可合并多个订阅地址，自动去重
- **节点处理管道**：正则包含/排除过滤、去重、排序、名称前后缀重命名
- **参数全配置化**：端口、超时、UA、代理、测速地址、策略组名等全部可通过配置文件 / 环境变量 / **Web 前台**修改，无需改代码
- **模板可编辑**：Clash 模板与规则模板可在前台在线编辑，保存立即生效
- **安全设计**：SSRF 防护（默认拦截内网地址）、可选接口令牌鉴权、路径穿越防护
- **高效运行**：Node.js 异步 I/O + 受限并发抓取；Docker 镜像仅 ~100MB；支持健康检查与优雅退出
- **易部署**：单进程无编译，支持 Docker / docker-compose / Waifly（Node.js Egg）等平台

## 架构

```
请求 ──> /convert ──> 抓取订阅(Fetcher) ──> 格式探测(parsers) ──> 处理管道(pipeline)
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
│   └── server/             # Fastify 路由与接口逻辑
├── templates/              # Clash 模板与规则模板（可在前台编辑覆盖）
├── web/                    # Web 前台（原生 JS，无构建）
├── test/                   # 单元测试（node:test）
└── data/                   # 运行时数据（gitignore：配置覆盖、模板覆盖）
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

> 提示：免费套餐限制 300MB 内存，本项目常规运行占用约 50~80MB，满足要求。

## 部署到其他 PaaS / VPS

- **Railway / Render / Fly.io / Koyeb** 等：选择 Node.js 运行时，启动命令 `node app.js`，设置环境变量 `PORT`（平台会自动注入）。
- **任意 VPS**：`docker compose up -d` 或 `npm ci --omit=dev && node app.js`（建议搭配 pm2 / systemd）。

## 配置说明

所有参数默认值见 [src/config/defaults.yaml](src/config/defaults.yaml)，优先级：**默认配置 < data/config.yaml（前台修改） < 环境变量**。

### 环境变量

| 环境变量 | 对应配置项 | 说明 |
| --- | --- | --- |
| `PORT` | server.port | 监听端口（PaaS 平台常用） |
| `HOST` | server.host | 监听地址，默认 0.0.0.0 |
| `SUBBRIDGE_UPSTREAM_PROXY` | fetcher.upstream_proxy | 上游转发代理（http/https），如 `http://user:pass@host:8080` |
| `SUBBRIDGE_API_TOKEN` | security.api_token | 接口鉴权令牌，设置后 /convert 与 /api/* 需携带 |
| `SUBBRIDGE_TIMEOUT_SECONDS` | fetcher.timeout_seconds | 订阅抓取超时（秒） |
| `SUBBRIDGE_USER_AGENT` | fetcher.user_agent | 抓取请求 UA |
| `SUBBRIDGE_DEFAULT_TARGET` | converter.default_target | 默认目标格式 |
| `SUBBRIDGE_LOG_LEVEL` | logging.level | 日志级别 |
| `SUBBRIDGE_BLOCK_PRIVATE` | fetcher.block_private | 是否启用 SSRF 防护 |
| `SUBBRIDGE_DATA_DIR` | 数据目录 | 运行时数据目录，默认 ./data |

### 关键配置项

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| fetcher.retries | 2 | 抓取失败重试次数 |
| fetcher.max_body_bytes | 10485760 | 订阅内容大小上限（10MB） |
| fetcher.max_concurrency | 5 | 并发抓取订阅数上限 |
| fetcher.private_host_allowlist | [] | 内网域名白名单（SSRF 防护放行） |
| converter.dedupe / udp / sort | true / true / "" | 去重 / UDP / 排序 |
| converter.include / exclude | "" | 节点名称正则过滤 |
| converter.rename_prefix / suffix | "" | 节点名称前后缀 |
| converter.skip_failed | true | 订阅抓取失败时跳过继续 |
| converter.clash.select_group_name | PROXY | 手动选择策略组名 |
| converter.clash.auto_group_name | AUTO | 自动测速策略组名 |
| converter.clash.url_test_url | http://www.gstatic.com/generate_204 | 测速探测地址 |
| converter.clash.url_test_interval | 300 | 测速间隔（秒） |
| security.api_token | "" | 接口令牌（留空关闭鉴权） |

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
| `token` | 否 | 接口令牌（配置了 security.api_token 时必填，也可用 `X-API-Token` 请求头） |

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

# 将转换后的地址填入 Clash 客户端即可作为订阅使用
# 例：http://127.0.0.1:8080/convert?url=...&target=clash
```

### 配置管理

```
GET  /api/config            读取生效配置（敏感项脱敏）
POST /api/config            更新配置（JSON 对象，持久化到 data/config.yaml，立即生效）
GET  /api/templates         模板文件列表
GET  /api/templates/:name   读取模板内容
PUT  /api/templates/:name   保存模板（写入 data/templates/ 覆盖内置）
```

> 设置了 `security.api_token` 后，以上接口需携带令牌（`X-API-Token` 头 或 `?token=`）。

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

> `links` / `v2ray` 目标输出节点**原始分享链接**；来自 Clash/JSON 订阅的节点无原始链接，会被跳过（过滤、去重等规则仍然生效）。

## 安全说明

- **SSRF 防护**：默认禁止抓取内网/保留地址（127.0.0.1、10.x、172.16-31.x、192.168.x、169.254.x、::1、fc00::/7 等），可通过 `fetcher.private_host_allowlist` 放行指定域名。
- **接口鉴权**：设置 `security.api_token` 后，所有转换与配置接口均需令牌。
- **路径穿越防护**：静态资源与模板接口均校验文件名白名单。
- **敏感信息**：`/api/config` 返回内容自动脱敏（代理密码、令牌掩码）；请勿将真实订阅地址、令牌提交到公开仓库。

## 开发指南

### 新增协议解析器

1. 在 `src/parsers/` 新增文件（如 `myproto.js`），导出 `parse(link)` 返回统一节点模型 `Proxy`。
2. 在 `src/parsers/share.js` 的 `REGISTRY` 中注册前缀。
3. 如需 Clash / sing-box 输出，在 `src/converters/clash.js` 的 `toClashProxy` 与 `src/converters/singbox.js` 的 `toSingBoxOutbound` 中补充映射。
4. 在 `test/parsers.test.js` 补充测试用例。

### 新增目标格式

1. 在 `src/converters/` 新增文件，导出 `convert(nodes, opts, ctx)`。
2. 在 `src/converters/index.js` 的 `TARGETS` 中注册，并补充 `contentTypeFor`。

### 质量检查

```bash
make check   # 语法检查 + 单元测试（提交前必须运行）
npm test     # 仅运行单元测试
```

## License

[MIT](LICENSE) © 2026 zhangsen0
