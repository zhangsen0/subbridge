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
const { handleSubscribe } = require('./subscribe');
const { resolveRole, buildSubscriptionUrl } = require('./auth');
const { getStore } = require('../config/loader');
const { LocalNodeManager } = require('../localnode/manager');

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
  localnode.start();

  // 优雅退出时关闭本地代理与隧道
  app.addHook('onClose', async () => {
    localnode.stop();
  });

  // 多级用户鉴权钩子（/ping 与静态资源除外）
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/ping' || req.url === '/' || req.url.startsWith('/static/')) return;
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
      return { ok: true, localnode: await localnode.status() };
    } catch (err) {
      return reply.code(500).send({ error: `重启失败: ${err.message}` });
    }
  });

  return app;
}

module.exports = { createServer };
