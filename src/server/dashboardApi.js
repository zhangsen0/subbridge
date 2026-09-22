'use strict';

/**
 * 驾驶舱概览 API（管理员/普通用户）
 *
 * GET /api/dashboard
 * 返回抓取中心主页所需的聚合数据：节点池统计、订阅源配置、本机节点/隧道状态、
 * 抓取日志统计与最近动态（日志明细仅管理员可见）。
 */

const { buildSubscriptionUrl } = require('./auth');
const { maskNode } = require('./grabApi');

/**
 * 注册驾驶舱概览路由
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx
 */
function registerDashboardApi(app, ctx) {
  app.get('/api/dashboard', async (req) => {
    const role = req.role || 'admin';
    const nodes = await ctx.nodePool.list();
    const alive = nodes.filter((n) => n.probe && n.probe.alive).length;
    const enabledCount = nodes.filter((n) => n.enabled !== false).length;
    const logs = ctx.fetchLog.list({ limit: 200 });
    const lastLog = logs[0] || null;
    const okCount = logs.filter((l) => !l.error).length;
    const subCfg = ctx.config.subscription || {};

    const localStatus = await ctx.localnode.status();
    const tunnel = localStatus.tunnel || {};
    const publicHost = tunnel.publicHost || localStatus.publicAddress || '';

    const data = {
      pool: { total: nodes.length, alive, dead: nodes.length - alive, enabled: enabledCount, disabled: nodes.length - enabledCount },
      subscription: {
        mainUrls: Array.isArray(subCfg.main_urls) ? subCfg.main_urls.length : 0,
        mergeMainUrls: subCfg.merge_main_urls !== false,
        includePool: subCfg.include_pool !== false,
        subscriptionUrl: buildSubscriptionUrl(req, ctx.config, role),
      },
      localnode: {
        enabled: !!localStatus.enabled,
        httpRunning: !!(localStatus.http && localStatus.http.running),
        socksRunning: !!(localStatus.socks5 && localStatus.socks5.running),
        tunnelRunning: !!tunnel.running,
        publicHost,
      },
      logs: {
        total: logs.length,
        ok: okCount,
        fail: logs.length - okCount,
        lastAt: lastLog ? lastLog.ts : null,
        lastStatus: lastLog ? (lastLog.error ? 'fail' : 'ok') : null,
      },
      recentNodes: nodes.slice(0, 8).map(maskNode),
    };
    // 抓取日志明细仅管理员可见
    if (role === 'admin') data.recentLogs = logs.slice(0, 8);
    return data;
  });
}

module.exports = { registerDashboardApi };
