'use strict';

/**
 * 实时测速 API（管理员/普通用户）
 *
 * GET /api/probe?urls=...&include=&exclude=...&sort=latency
 * 抓取输入（与 /convert 相同的自动识别：订阅链接 / 网页 / 文本）后，
 * 对解析出的节点逐个做 TCP 连通 + 真实下载测速（http/socks5 节点），
 * 返回结构化结果供前台展示，不输出订阅文件。
 */

const { checkNode } = require('../probe/checker');
const { buildConverted, buildOptions, extractUrls } = require('./convert');

/**
 * 注册实时测速路由
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx
 */
function registerProbeApi(app, ctx) {
  app.get('/api/probe', async (req, reply) => {
    const urls = extractUrls(req.query && req.query.url);
    if (!urls.length) return reply.code(400).send({ error: '缺少 url 参数（订阅地址 / 网页地址 / 节点文本）' });

    // 复用转换链路抓取与管道（跳过可用性检测，检测在这里单独执行）
    const opts = buildOptions({ ...(req.query || {}), probe: '0', target: 'clash' }, ctx.config);
    let result;
    try {
      result = await buildConverted(urls, opts, ctx);
    } catch (err) {
      if (err.detail) return reply.code(502).send({ error: err.message, detail: err.detail });
      return reply.code(500).send({ error: err.message });
    }

    const probeCfg = (ctx.config.probe || {});
    const checked = await Promise.all(
      result.nodes.map((n) =>
        checkNode({ ...n }, {
          timeoutMs: probeCfg.timeout_ms || 3000,
          speedTest: !!probeCfg.speed_test,
          speedTestUrl: probeCfg.speed_test_url,
          speedTestBytes: probeCfg.speed_test_bytes,
          // 上游探测代理：探测配置优先，回退抓取配置
          proxyUrl: probeCfg.upstream_proxy || (ctx.config.fetcher && ctx.config.fetcher.upstream_proxy) || '',
        }),
      ),
    );

    const results = checked.map((n) => ({
      name: n.name,
      type: n.type,
      server: n.server,
      port: n.port,
      alive: !!(n.probe && n.probe.alive),
      latencyMs: n.probe ? n.probe.latencyMs : null,
      speedBps: n.probe ? n.probe.speedBps : null,
      score: n.probe ? require('../core/quality').qualityScore(n) : null,
      error: n.probe && n.probe.error ? n.probe.error : '',
    }));

    const alive = results.filter((r) => r.alive);
    const withLatency = results.filter((r) => r.latencyMs != null);
    const avgLatency = withLatency.length
      ? Math.round(withLatency.reduce((s, r) => s + r.latencyMs, 0) / withLatency.length)
      : null;
    const withSpeed = results.filter((r) => r.speedBps != null);
    const avgSpeed = withSpeed.length
      ? Math.round(withSpeed.reduce((s, r) => s + r.speedBps, 0) / withSpeed.length)
      : null;

    // 测速事件记入日志（全站可检测数据均有记录可查）
    ctx.fetchLog.record({
      type: 'probe',
      kind: 'realtime',
      url: urls.join(', ').slice(0, 300),
      nodes: results.length,
      alive: alive.length,
      avgLatencyMs: avgLatency,
      avgSpeedBps: avgSpeed,
      durationMs: 0,
      error: '',
    });

    // 检测结果写回节点池，并按质量门槛自动开关、按删除逻辑自动清理（均默认关闭，可配置）
    let quality = null;
    let cleanup = null;
    if (ctx.nodePool) {
      try {
        const probeMap = {};
        for (const n of checked) {
          if (n.probe) probeMap[`${n.type}:${n.server}:${n.port}`] = n.probe;
        }
        await ctx.nodePool.updateProbe(probeMap);
        const { maybeApplyQuality, maybeCleanup } = require('./qualityApi');
        quality = await maybeApplyQuality(ctx);
        cleanup = await maybeCleanup(ctx);
      } catch (err) {
        quality = { error: err.message };
      }
    }

    return {
      summary: {
        total: results.length,
        alive: alive.length,
        dead: results.length - alive.length,
        avgLatencyMs: avgLatency,
        avgSpeedBps: avgSpeed,
      },
      results,
      quality,
      cleanup,
    };
  });
}

module.exports = { registerProbeApi };
