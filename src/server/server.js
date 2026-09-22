'use strict';

/**
 * Fastify 服务器装配
 *
 * 路由：
 *   GET  /                        Web 前台
 *   GET  /static/:file             Web 静态资源
 *   GET  /ping                     健康检查
 *   GET  /convert                  订阅转换（核心接口）
 *   GET/POST /api/config           配置读取/更新
 *   GET/PUT /api/templates        模板管理
 *
 * 安全：配置了 security.api_token 时，/convert 与 /api/* 需要携带令牌。
 */

const Fastify = require('fastify');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../../package.json');
const { handleConvert } = require('./convert');
const { registerConfigApi } = require('./configApi');

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

/** 校验请求令牌（header 或 query） */
function checkToken(req, config) {
  const expected = (config.security && config.security.api_token) || '';
  if (!expected) return true;
  const fromHeader =
    req.headers['x-api-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const fromQuery = req.query && req.query.token;
  return fromHeader === expected || fromQuery === expected;
}

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

  // 共享上下文：模板目录（内置）+ 运行时数据目录
  const ctx = {
    config,
    templatesDir: path.join(__dirname, '..', '..', 'templates'),
    dataDir: path.join(process.cwd(), 'data'),
  };

  // 令牌校验钩子（/ping 与静态资源除外）
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/ping' || req.url.startsWith('/static/')) return;
    if (!checkToken(req, config)) {
      return reply.code(401).send({ error: '未授权：请在请求中携带正确令牌' });
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

  // 配置与模板管理
  registerConfigApi(app, ctx);

  return app;
}

module.exports = { createServer };
