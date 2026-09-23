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
    // 分页（page 从 1 开始；pageSize 上限 200，默认 100）
    const total = nodes.length;
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 100));
    const paged = nodes.slice((page - 1) * pageSize, page * pageSize);
    return {
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      nodes: paged.map(maskNode),
      // 全量类型（供筛选下拉，不受分页影响）
      types: [...new Set(nodes.map((n) => n.type).filter(Boolean))].sort(),
    };
  });

  // 单节点详情（完整字段，供导出 OpenVPN 配置等）
  app.get('/api/pool/:key', async (req, reply) => {
    const pool = await ctx.nodePool.load();
    const node = pool[req.params.key];
    if (!node) return reply.code(404).send({ error: '节点不存在' });
    return { node };
  });

  // 池内节点测速并写回（异步：立即返回，后台并发测速，测完写回池/质量门槛/清理/日志）
  app.post('/api/pool/probe', async (req, reply) => {
    const body = req.body || {};
    const keys = Array.isArray(body.keys) ? body.keys : [];
    let nodes = await ctx.nodePool.list();
    if (keys.length) nodes = nodes.filter((n) => keys.includes(`${n.type}:${n.server}:${n.port}`));
    const limit = Number(body.limit) > 0 ? Number(body.limit) : nodes.length;
    nodes = nodes.slice(0, limit);
    const total = nodes.length;

    // 立即返回：测速在后台执行，避免阻塞请求（全池测速可能持续数十秒）
    reply.send({ ok: true, started: true, total, message: '测速已后台启动，可在事件日志查看进度' });

    setImmediate(async () => {
      try {
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
        const { maybeApplyQuality, maybeCleanup } = require('./qualityApi');
        await maybeApplyQuality(ctx);
        // 测速完成后按自定义删除逻辑自动清理（默认关闭，可配置）
        await maybeCleanup(ctx);
      } catch (err) {
        ctx.fetchLog.record({ type: 'probe', kind: 'pool', url: '池内测速失败', error: err.message });
      }
    });
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

  // 手工添加节点（节点池直接入库）：links=粘贴节点链接（自动识别协议）或 node=手动字段对象
  app.post('/api/pool/add', async (req, reply) => {
    const body = req.body || {};
    const { parseSubscription } = require('../parsers');
    const nodes = [];
    const problems = [];

    // 方式一：粘贴节点链接（一行一个，自动识别 ss/ssr/vmess/vless/trojan/hysteria/hysteria2/tuic 等）
    const links = Array.isArray(body.links) ? body.links.join('\n') : String(body.links || '');
    if (links.trim()) {
      const { nodes: parsed } = parseSubscription(links);
      for (const n of parsed) {
        if (n && n.server && n.port) nodes.push(n);
        else problems.push(`跳过无法识别的条目: ${String(n && n.raw || '').slice(0, 60)}`);
      }
    }

    // 方式二：手动填写节点字段
    if (body.node && typeof body.node === 'object') {
      const m = body.node;
      if (!m.type || !m.server || !m.port) {
        problems.push('手动节点必须填写：协议类型(type)、服务器(server)、端口(port)');
      } else {
        nodes.push({
          name: String(m.name || `${m.server}:${m.port}`).trim(),
          type: String(m.type).toLowerCase(),
          server: String(m.server),
          port: Number(m.port),
          uuid: m.uuid || '',
          password: m.password || '',
          cipher: m.cipher || '',
          // trojan/hysteria2/hysteria/tuic 等协议默认走 TLS（除非显式关闭）
          tls: ['trojan', 'hysteria2', 'hysteria', 'tuic'].includes(String(m.type).toLowerCase())
            ? (m.tls !== false && m.tls !== 'false')
            : (m.tls === true || m.tls === 'true'),
          sni: m.sni || '',
          network: m.network || '',
          wsPath: m.wsPath || '',
          wsHost: m.wsHost || '',
          fingerprint: m.fingerprint || '',
          flow: m.flow || '',
          udp: m.udp !== false,
          raw: '',
        });
      }
    }

    if (!nodes.length) {
      return reply.code(400).send({ error: problems[0] || '请粘贴节点链接或填写节点字段' });
    }
    const { added, updated } = await ctx.nodePool.upsert(nodes, { source: body.source || '手工添加' });
    ctx.fetchLog.record({ type: 'pool', kind: 'add', url: '手工添加节点', nodes: nodes.length, error: '' });
    return { ok: true, parsed: nodes.length, added, updated, problems };
  });

  // 一键：测速并自动过滤（停用不可用节点；未测节点默认保留）
  // 判定标准：不可用 = 探测失败（alive=false）或延迟超过 pool.filter_max_latency_ms（默认 1000ms）
  app.post('/api/pool/filter', async (req, reply) => {
    const body = req.body || {};
    const keys = Array.isArray(body.keys) ? body.keys : [];
    let nodes = await ctx.nodePool.list();
    if (keys.length) nodes = nodes.filter((n) => keys.includes(`${n.type}:${n.server}:${n.port}`));
    if (!nodes.length) return { tested: 0, usable: 0, disabled: 0, disabledKeys: [] };

    const probeCfg = (ctx.config.probe || {});
    const { checkNode } = require('../probe/checker');
    const checked = await Promise.all(
      nodes.map((n) =>
        checkNode({ ...n }, {
          timeoutMs: probeCfg.timeout_ms || 3000,
          speedTest: !!probeCfg.speed_test,
          speedTestUrl: probeCfg.speed_test_url,
          speedTestBytes: probeCfg.speed_test_bytes,
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

    const { isNodeUsable } = require('../core/quality');
    const poolCfg = (ctx.config.pool || {});
    const maxMs = Number(poolCfg.filter_max_latency_ms) > 0 ? Number(poolCfg.filter_max_latency_ms) : 1000;
    const keepUnprobed = poolCfg.filter_keep_unprobed !== false;
    const toDisable = [];
    const usable = [];
    for (const n of checked) {
      const usableFlag = isNodeUsable(n, { maxLatencyMs: maxMs, keepUnprobed });
      if (usableFlag) usable.push(n);
      else if (n.enabled !== false) toDisable.push(`${n.type}:${n.server}:${n.port}`);
    }
    const disabled = toDisable.length ? await ctx.nodePool.bulkSetEnabled(toDisable.map((k) => [k, false])) : 0;

    ctx.fetchLog.record({
      type: 'probe', kind: 'filter',
      url: keys.length ? `过滤 ${keys.length} 个` : '过滤全部节点',
      nodes: checked.length, alive: usable.length, error: '',
    });

    return {
      tested: checked.length,
      usable: usable.length,
      disabled,
      disabledKeys: toDisable,
    };
  });

  // 一键：删除不可用节点（判定同 /api/pool/filter）
  app.post('/api/pool/prune', async (req, reply) => {
    const body = req.body || {};
    const keys = Array.isArray(body.keys) ? body.keys : [];
    let nodes = await ctx.nodePool.list();
    if (keys.length) nodes = nodes.filter((n) => keys.includes(`${n.type}:${n.server}:${n.port}`));
    const poolCfg = (ctx.config.pool || {});
    const maxMs = Number(poolCfg.filter_max_latency_ms) > 0 ? Number(poolCfg.filter_max_latency_ms) : 1000;
    const keepUnprobed = poolCfg.filter_keep_unprobed !== false;
    const { isNodeUsable } = require('../core/quality');
    const toRemove = nodes
      .filter((n) => !isNodeUsable(n, { maxLatencyMs: maxMs, keepUnprobed }))
      .map((n) => `${n.type}:${n.server}:${n.port}`);
    const removed = toRemove.length ? await ctx.nodePool.remove(toRemove) : 0;
    ctx.fetchLog.record({
      type: 'probe', kind: 'prune',
      url: `删除不可用节点 ${removed} 个`, nodes: removed, alive: 0, error: '',
    });
    return { removed, removedKeys: toRemove };
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
