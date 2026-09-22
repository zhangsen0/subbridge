'use strict';

/**
 * 节点池 API（仅管理员）
 *
 * GET  /api/pool              节点列表（敏感字段脱敏，支持搜索/类型过滤）
 * GET  /api/pool/:key         单节点详情（含 OpenVPN 配置等完整字段，供导出）
 * POST /api/pool/probe        对池内节点测速并写回状态（keys 为空则测全部，limit 可限数量）
 * POST /api/pool/remove       手动删除指定节点（keys 数组）
 * POST /api/pool/clear        清空节点池（显式操作）
 */

const { checkNode } = require('../probe/checker');

/** 列表展示时脱敏：不返回密码与配置文件原文，仅标记是否存在；附带质量分 */
function maskNode(n) {
  const { password, configBase64, ...rest } = n;
  const { qualityScore } = require('../core/quality');
  if (rest.probe) {
    rest.probe = { ...rest.probe, score: qualityScore(n) };
  }
  return {
    ...rest,
    hasPassword: !!password,
    hasConfig: !!configBase64,
  };
}

/**
 * 注册节点池路由
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx
 */
function registerPoolApi(app, ctx) {
  // 节点列表
  app.get('/api/pool', async (req) => {
    const pool = ctx.nodePool;
    let nodes = await pool.list();
    const q = req.query || {};
    if (q.search) {
      const kw = String(q.search).toLowerCase();
      nodes = nodes.filter(
        (n) =>
          (n.name || '').toLowerCase().includes(kw) ||
          (n.server || '').toLowerCase().includes(kw) ||
          (n.country || '').toLowerCase().includes(kw) ||
          (n.source || '').toLowerCase().includes(kw),
      );
    }
    if (q.type) nodes = nodes.filter((n) => n.type === q.type);
    if (q.ok === '1') nodes = nodes.filter((n) => n.probe && n.probe.alive);
    // 启用状态过滤：enabled=1 仅启用、enabled=0 仅停用、all 全部（默认全部）
    if (q.enabled === '1') nodes = nodes.filter((n) => n.enabled !== false);
    if (q.enabled === '0') nodes = nodes.filter((n) => n.enabled === false);
    return { total: nodes.length, nodes: nodes.map(maskNode) };
  });

  // 单节点详情（完整字段，供导出 OpenVPN 配置等）
  app.get('/api/pool/:key', async (req, reply) => {
    const pool = await ctx.nodePool.load();
    const node = pool[req.params.key];
    if (!node) return reply.code(404).send({ error: '节点不存在' });
    return { node };
  });

  // 池内节点测速并写回
  app.post('/api/pool/probe', async (req, reply) => {
    const body = req.body || {};
    const keys = Array.isArray(body.keys) ? body.keys : [];
    let nodes = await ctx.nodePool.list();
    if (keys.length) nodes = nodes.filter((n) => keys.includes(`${n.type}:${n.server}:${n.port}`));
    const limit = Number(body.limit) > 0 ? Number(body.limit) : nodes.length;
    nodes = nodes.slice(0, limit);

    const probeCfg = (ctx.config.probe || {});
    const checked = await Promise.all(
      nodes.map((n) =>
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

    // 写回检测结果
    const probeMap = {};
    for (const n of checked) {
      if (n.probe) probeMap[`${n.type}:${n.server}:${n.port}`] = n.probe;
    }
    await ctx.nodePool.updateProbe(probeMap);

    const aliveCount = checked.filter((n) => n.probe && n.probe.alive).length;
    // 测速事件记入日志
    ctx.fetchLog.record({
      type: 'probe',
      kind: 'pool',
      url: keys.length ? `池内节点 ${keys.length} 个` : '池内全部节点',
      nodes: checked.length,
      alive: aliveCount,
      durationMs: 0,
      error: '',
    });

    // 测速完成后按质量门槛自动开关节点（默认关闭，可配置）
    let quality = null;
    const { maybeApplyQuality, maybeCleanup } = require('./qualityApi');
    quality = await maybeApplyQuality(ctx);
    // 测速完成后按自定义删除逻辑自动清理（默认关闭，可配置）
    let cleanup = null;
    cleanup = await maybeCleanup(ctx);

    return {
      tested: checked.length,
      results: checked.map((n) => ({
        key: `${n.type}:${n.server}:${n.port}`,
        name: n.name,
        alive: !!(n.probe && n.probe.alive),
        latencyMs: n.probe ? n.probe.latencyMs : null,
        speedBps: n.probe ? n.probe.speedBps : null,
        score: n.probe ? require('../core/quality').qualityScore(n) : null,
        error: n.probe && n.probe.error ? n.probe.error : '',
      })),
      quality,
      cleanup,
    };
  });

  // 手动应用质量门槛（忽略 quality_enabled 开关强制应用）
  app.post('/api/pool/apply-quality', async (req, reply) => {
    const { maybeApplyQuality } = require('./qualityApi');
    const q = await maybeApplyQuality(ctx, { force: true });
    if (!q) return reply.code(400).send({ error: '未配置质量门槛（pool.quality_gates 为空）' });
    return { ok: true, ...q };
  });

  // 手动执行清理（自定义删除逻辑，忽略 cleanup_enabled 开关强制应用）
  app.post('/api/pool/cleanup', async (req, reply) => {
    const { maybeCleanup } = require('./qualityApi');
    const c = await maybeCleanup(ctx, { force: true });
    if (!c) return reply.code(400).send({ error: '未配置清理规则（pool.cleanup_rules 为空）' });
    return { ok: true, ...c };
  });

  // 手动删除节点
  app.post('/api/pool/remove', async (req, reply) => {
    const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
    if (!keys.length) return reply.code(400).send({ error: '缺少 keys 参数' });
    const removed = await ctx.nodePool.remove(keys);
    ctx.fetchLog.record({ type: 'pool', kind: 'remove', nodes: removed, url: `删除 ${removed} 个节点`, error: '' });
    return { ok: true, removed };
  });

  // 开关节点（启用/停用；停用节点保留在池中但不参与订阅输出）
  app.post('/api/pool/toggle', async (req, reply) => {
    const body = req.body || {};
    if (!body.key) return reply.code(400).send({ error: '缺少 key 参数' });
    const enabled = body.enabled === true || body.enabled === 'true' || body.enabled === 1;
    const ok = await ctx.nodePool.toggle(String(body.key), enabled);
    if (!ok) return reply.code(404).send({ error: '节点不存在' });
    ctx.fetchLog.record({
      type: 'pool', kind: 'toggle', url: `${enabled ? '启用' : '停用'}节点 ${body.key}`,
      nodes: 0, error: '',
    });
    return { ok: true, key: body.key, enabled };
  });

  // 清空节点池
  app.post('/api/pool/clear', async () => {
    const before = (await ctx.nodePool.list()).length;
    await ctx.nodePool.clear();
    ctx.fetchLog.record({ type: 'pool', kind: 'clear', nodes: before, url: `清空节点池（${before} 个）`, error: '' });
    return { ok: true };
  });
}

module.exports = { registerPoolApi };
