'use strict';

/**
 * 抓取预览 API（管理员/普通用户）
 *
 * GET /api/grab?url=...（自动识别：订阅链接 / 网页地址 / 节点文本）
 * 抓取并入库节点池后，返回结构化预览：本次解析节点明细（脱敏）、入库统计、告警。
 * 转换不是独立步骤：抓取即自动识别入库；需要特定格式时用 /convert?url=...&target=... 或本机订阅源 /sub。
 */

const { buildConverted, buildOptions, extractUrls } = require('./convert');
const { buildSubscriptionUrl } = require('./auth');

/** 列表展示脱敏：不返回密码/配置文件等敏感字段 */
function maskNode(n) {
  return {
    name: n.name,
    type: n.type,
    server: n.server,
    port: n.port,
    enabled: n.enabled !== false,
    source: n.source || '',
    probe: n.probe
      ? { alive: !!n.probe.alive, latencyMs: n.probe.latencyMs, speedBps: n.probe.speedBps }
      : null,
  };
}
/**
 * 注册抓取预览路由
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx
 */
function registerGrabApi(app, ctx) {
  app.get('/api/grab', async (req, reply) => {
    const urls = extractUrls(req.query && req.query.url);
    if (!urls.length) {
      return reply.code(400).send({ error: '缺少 url 参数（订阅链接 / 网页地址 / 节点文本）' });
    }

    const opts = buildOptions({ ...(req.query || {}), probe: '0' }, ctx.config);
    let result;
    try {
      result = await buildConverted(urls, opts, ctx);
    } catch (err) {
      if (err.detail) return reply.code(502).send({ error: err.message, detail: err.detail });
      return reply.code(500).send({ error: err.message });
    }

    const role = req.role || 'admin';
    return {
      summary: {
        parsed: result.nodes.length,
        poolAdded: result.poolStats ? result.poolStats.added : 0,
        poolUpdated: result.poolStats ? result.poolStats.updated : 0,
      },
      nodes: result.nodes.map(maskNode),
      warnings: result.warnings,
      subscriptionUrl: buildSubscriptionUrl(req, ctx.config, role),
    };
  });
}

module.exports = { registerGrabApi, maskNode };
