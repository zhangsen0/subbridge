'use strict';

/**
 * Fastify 服务器装配
 *
 * 路由：
 *   GET  /                        Web 前台
 *   GET  /static/:file            Web 静态资源
 *   GET  /ping                    健康检查（无需令牌）
 *   GET  /convert                 订阅转换（管理员/普通用户）
 *   GET  /sub /subscribe          本机订阅源（管理员/普通用户）
 *   GET  /api/me                  当前角色与订阅链接（管理员/普通用户）
 *   GET/POST /api/config          配置读取/更新（仅管理员）
 *   GET/PUT /api/templates        模板管理（仅管理员）
 *   GET/POST /api/localnode*      本地节点管理（仅管理员）
 *
 * 多级用户：配置了 security.api_token 时为管理员（完全访问）；
 * 配置了 security.user_token 时为普通用户（仅转换/订阅，无法改配置）。
 */

const Fastify = require('fastify');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../../package.json');
const { handleConvert } = require('./convert');
const { registerConfigApi } = require('./configApi');
const { registerBackupApi } = require('./backupApi');
const { registerPoolApi } = require('./poolApi');
const { registerProbeApi } = require('./probeApi');
const { registerGrabApi } = require('./grabApi');
const { registerDashboardApi } = require('./dashboardApi');
const { registerLoginApi } = require('./loginApi');
const { registerPresetsApi } = require('./presetsApi');
const { registerScenarioApi } = require('./scenarioApi');
const { FetchLog } = require('./fetchLog');
const { handleSubscribe } = require('./subscribe');
const { resolveRole, buildSubscriptionUrl } = require('./auth');
const { getStore } = require('../config/loader');
const { LocalNodeManager } = require('../localnode/manager');
const { NodePool } = require('../core/nodePool');

/** 静态资源 MIME 映射 */
const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * 创建 Fastify 实例
 * @param {object} config 生效配置
 * @returns {import('fastify').FastifyInstance}
 */
function createServer(config) {
  const app = Fastify({
    logger: {
      level: (config.logging && config.logging.level) || 'info',
    },
    trustProxy: !!(config.server && config.server.trust_proxy),
  });

  // 共享上下文：模板目录（内置）+ 存储实例 + 本地节点管理器
  const ctx = {
    config,
    templatesDir: path.join(__dirname, '..', '..', 'templates'),
    store: getStore(),
  };

  // 本地节点管理器（本机作为订阅节点 + 可选 CF 隧道）
  const localnode = new LocalNodeManager(config, app.log, ctx.store);
  ctx.localnode = localnode;

  // 抓取日志（内存环形缓冲，容量可配置）与节点池（持久化，自动补充/更新、不自动删除）
  ctx.fetchLog = new FetchLog((config.fetch_log || {}).capacity);
  ctx.nodePool = new NodePool(ctx.store);

  // 本机节点默认加入节点池：启动后（以及重启本地节点后）自动同步
  // 节点池存在时，把本机节点 upsert 入池（来源 localnode），/sub 统一从池输出；
  // 若本机节点未启用或未开启注入，则移除池中来源为 localnode 的旧节点，避免残留失效节点
  async function syncLocalNodeToPool() {
    const lc = (config.localnode || {});
    try {
      if (lc.enabled && lc.inject_into_subscription && lc.auto_join_pool !== false) {
        const lns = await localnode.localNodes();
        if (lns.length) {
          const { added, updated } = await ctx.nodePool.upsert(lns, { source: 'localnode' });
          app.log.info(`本机节点已同步入节点池（新增 ${added} / 更新 ${updated}）`);
          return;
        }
      }
      // 本机节点不可用时，清理池中来源为 localnode 的残留节点
      const pool = await ctx.nodePool.list();
      const staleKeys = pool.filter((n) => n.source === 'localnode').map((n) => n.key);
      if (staleKeys.length) {
        await ctx.nodePool.remove(staleKeys);
        app.log.info(`本机节点未启用/不可用，已从节点池移除 ${staleKeys.length} 个本机节点`);
      }
    } catch (err) {
      app.log.warn(`本机节点同步入池失败: ${err.message}`);
    }
  }
  // 服务就绪后异步同步一次（不阻塞启动）
  localnode.start();
  setImmediate(() => { syncLocalNodeToPool().catch(() => {}); });

  // 优雅退出时关闭本地代理与隧道
  app.addHook('onClose', async () => {
    localnode.stop();
  });

  // 端口复用模式（localnode.mode=shared）：HTTP 代理 CONNECT 隧道挂到主服务端口，
  // 绝对 URL 转发（GET http://host/...）在此钩子拦截（必须先于鉴权钩子，代理请求走代理认证而非页面令牌）
  if (localnode.isSharedMode()) {
    localnode.attachTo(app.server);
    app.addHook('onRequest', (req, reply, done) => {
      if (localnode.handleAbsolute(req.raw, reply.raw)) {
        // 已由 HTTP 代理处理器接管底层 socket，不再进入 Fastify 路由与鉴权
        reply.hijack();
        return;
      }
      done();
    });
  }

  // 多级用户鉴权钩子（/ping、/login 与静态资源除外）
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/ping' || req.url === '/' || req.url === '/login' || req.url === '/setup' || req.url === '/api/login' || req.url.startsWith('/static/')) return;
    const role = resolveRole(req, config);
    if (!role) {
      return reply.code(401).send({ error: '未授权：请在请求中携带正确令牌' });
    }
    req.role = role;
    // /api/* 仅管理员可见（/api/me 除外，普通用户需用其识别自身角色与订阅链接）
    if (req.url.startsWith('/api/') && !req.url.startsWith('/api/me') && role !== 'admin') {
      return reply.code(403).send({ error: '权限不足：当前为普通用户，仅可访问 /convert 与 /sub' });
    }
  });

  // 健康检查
  app.get('/ping', async () => ({
    status: 'ok',
    service: pkg.name,
    version: pkg.version,
    time: new Date().toISOString(),
  }));

  // Web 前台
  const webDir = path.join(__dirname, '..', '..', 'web');
  app.get('/', async (req, reply) => {
    reply.type('text/html; charset=utf-8').send(fs.readFileSync(path.join(webDir, 'index.html')));
  });

  // 登录页（公开，无需令牌）
  app.get('/login', async (req, reply) => {
    reply.type('text/html; charset=utf-8').send(fs.readFileSync(path.join(webDir, 'login.html')));
  });

  // 一键配置向导页（公开加载页面，数据接口受令牌保护）
  app.get('/setup', async (req, reply) => {
    reply.type('text/html; charset=utf-8').send(fs.readFileSync(path.join(webDir, 'setup.html')));
  });

  // 静态资源（从磁盘读取，便于前台实时修改）
  app.get('/static/:file', async (req, reply) => {
    const file = path.basename(req.params.file); // 仅允许文件名，防路径穿越
    const filePath = path.join(webDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return reply.code(404).send('Not Found');
      const ext = path.extname(file).toLowerCase();
      reply.type(MIME_MAP[ext] || 'application/octet-stream').send(fs.readFileSync(filePath));
    } catch {
      return reply.code(404).send('Not Found');
    }
  });

  // 核心转换接口
  app.get('/convert', (req, reply) => handleConvert(req, reply, ctx));

  // 本机订阅源：外部客户端仅凭订阅链接 + token 拉取（受令牌保护）
  app.get('/sub', (req, reply) => handleSubscribe(req, reply, ctx));
  app.get('/subscribe', (req, reply) => handleSubscribe(req, reply, ctx));

  // 配置与模板管理
  registerConfigApi(app, ctx);

  // 账号密码 / 令牌登录（公开）
  registerLoginApi(app, ctx);

  // 内置模板（规则 / 质量门槛 / 清理规则，一键初始化）
  registerPresetsApi(app, ctx);

  // 一键配置向导（场景模板 + 快速开始）
  registerScenarioApi(app, ctx);

  // 节点池管理（仅管理员）与实时测速（管理员/普通用户）
  registerPoolApi(app, ctx);
  registerProbeApi(app, ctx);

  // 抓取预览（管理员/普通用户）与驾驶舱概览
  registerGrabApi(app, ctx);
  registerDashboardApi(app, ctx);

  // 事件日志（仅管理员）
  app.get('/api/logs', async (req) => {
    const q = req.query || {};
    const ok = q.ok === '1' ? true : q.ok === '0' ? false : undefined;
    return { logs: ctx.fetchLog.list({ limit: q.limit, ok, type: q.type || undefined }) };
  });
  app.post('/api/logs/clear', async () => {
    ctx.fetchLog.clear();
    return { ok: true };
  });

  // 数据备份与迁移（仅管理员）
  registerBackupApi(app, ctx);

  // 当前角色与订阅链接（管理员/普通用户均可用）
  app.get('/api/me', async (req) => ({
    role: req.role || 'admin',
    subscriptionUrl: buildSubscriptionUrl(req, config, req.role || 'admin'),
  }));

  // 本地节点状态（含本机订阅源链接）
  app.get('/api/localnode', async (req) => {
    const status = await localnode.status();
    // 构建对外订阅链接：带管理员 token（若已配置），客户端仅需该链接即可拉取
    status.subscriptionUrl = buildSubscriptionUrl(req, config, 'admin');
    return { localnode: status };
  });

  // 重启本地节点（配置修改端口/启用状态后调用）
  app.post('/api/localnode/restart', async (req, reply) => {
    try {
      await localnode.restart();
      await syncLocalNodeToPool();
      ctx.fetchLog.record({ type: 'system', kind: 'localnode.restart', url: '重启本地节点与隧道', error: '' });
      return { ok: true, localnode: await localnode.status() };
    } catch (err) {
      ctx.fetchLog.record({ type: 'system', kind: 'localnode.restart', url: '重启本地节点与隧道', error: err.message });
      return reply.code(500).send({ error: `重启失败: ${err.message}` });
    }
  });

  return app;
}

module.exports = { createServer };
