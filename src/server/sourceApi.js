'use strict';

/**
 * 抓取来源管理 API（表格化增删改查 + 手动/自动采集）
 *
 *   GET    /api/sources          来源列表（含最近抓取状态）
 *   POST   /api/sources          新增来源 {url, note, enabled, auto}
 *   PUT    /api/sources/:id      编辑来源（url/note/enabled/auto）
 *   DELETE /api/sources/:id      删除来源
 *   POST   /api/sources/grab     抓取指定来源（缺省全部启用项），可带 probe 测速
 *   GET    /api/auto-grab        自动采集状态（间隔/上次运行/开关）
 *   POST   /api/auto-grab        立即触发一次自动采集
 */

const crypto = require('node:crypto');
const { buildConverted, buildOptions, extractUrls } = require('./convert');
const { maskNode } = require('./grabApi');
const { nodeKey } = require('../core/nodePool');

function registerSourceApi(app, ctx) {
  const sources = ctx.sources;
  // 后台抓取状态：避免同步串行抓取阻塞 API 与重启收尾（async=true 立即返回，后台逐源执行）
  let grabRunning = false;
  let grabTask = null;

  /**
   * 抓取后自动清理：删除本次入库节点中"已测且不可用"的节点。
   * 由 grab.auto_probe + grab.auto_remove_unreachable 两个配置共同控制，
   * 默认关闭（保留全部节点），开启后实现"抓取→测速→自动删除不可用"闭环。
   * @param {object[]} nodes 本次抓取入库的节点
   * @returns {Promise<number>} 删除数量
   */
  async function removeUnreachableAfterGrab(nodes) {
    const grabCfg = (ctx.config && ctx.config.grab) || {};
    if (grabCfg.auto_remove_unreachable !== true || !ctx.nodePool) return 0;
    const deadKeys = (nodes || [])
      .filter((n) => n.probe && n.probe.alive === false && n.probe.testedAt)
      .map((n) => nodeKey(n));
    if (!deadKeys.length) return 0;
    return ctx.nodePool.remove(deadKeys);
  }

  /** 抓取并入库（手动/自动共用），返回统计 */
  async function grabSources(urls, { probe = false, proxyUrl } = {}) {
    const grabCfg = (ctx.config && ctx.config.grab) || {};
    // 抓取后自动测速：手动 probe 或配置 grab.auto_probe 开启（手动/自动/定时采集共用）
    const autoProbe = probe === true || grabCfg.auto_probe === true;
    // 抓取阶段不同步测速（提速）：测速统一走后台异步（不阻塞抓取循环与 API 响应）
    const opts = buildOptions({ probe: '0' }, ctx.config);
    const result = await buildConverted(urls, opts, ctx, { proxyUrl });
    // 抓取后自动测速（后台异步）：测速写回节点池，按配置自动删除不可用节点
    if (autoProbe) scheduleAsyncProbe(result.nodes);
    // 按配置清理本次已测不可用节点（原逻辑保留）
    const removed = await removeUnreachableAfterGrab(result.nodes);
    if (removed) result.removedUnreachable = removed;
    return result;
  }

  /** 后台异步测速本次入库节点：不阻塞抓取循环；测完写回池并按配置删除不可用 */
  function scheduleAsyncProbe(nodes) {
    if (!nodes || !nodes.length) return;
    // 登记后台任务（前台「后台任务」标签页可查看）
    const task = ctx.taskManager
      ? ctx.taskManager.start({ type: 'probe', title: `抓取后节点测速 ${nodes.length} 个`, total: nodes.length })
      : null;
    setImmediate(async () => {
      try {
        const probeCfg = (ctx.config && ctx.config.probe) || {};
        const { runChecks } = require('../probe/checker');
        const checked = await runChecks(nodes, {
          concurrency: probeCfg.concurrency || 10,
          timeoutMs: probeCfg.timeout_ms || 3000,
          speedTest: !!probeCfg.speed_test,
          speedTestUrl: probeCfg.speed_test_url,
          speedTestUrls: probeCfg.speed_test_urls,
          speedTestBytes: probeCfg.speed_test_bytes,
          proxyUrl: probeCfg.upstream_proxy || (ctx.config.fetcher && ctx.config.fetcher.upstream_proxy) || '',
        });
        // 测速结果写回节点池
        const probeMap = {};
        for (const n of checked) {
          if (n.probe) probeMap[`${n.type}:${n.server}:${n.port}`] = n.probe;
        }
        await ctx.nodePool.updateProbe(probeMap);
        // 自动删除不可用（grab.auto_remove_unreachable，默认关；开启=只留可用节点）
        let removedCount = 0;
        if ((ctx.config.grab || {}).auto_remove_unreachable) {
          const deadKeys = checked
            .filter((n) => n.probe && !n.probe.alive)
            .map((n) => `${n.type}:${n.server}:${n.port}`);
          if (deadKeys.length) {
            removedCount = deadKeys.length;
            await ctx.nodePool.remove(deadKeys);
          }
        }
        const aliveCount = checked.filter((n) => n.probe && n.probe.alive).length;
        ctx.fetchLog.record({
          type: 'probe', kind: 'grab',
          url: `抓取后异步测速 ${checked.length} 个节点`,
          nodes: checked.length,
          alive: aliveCount,
          error: '',
        });
        if (task) ctx.taskManager.finish(task.id, {
          ok: aliveCount, fail: checked.length - aliveCount,
          summary: `可用 ${aliveCount} 个 / 不可用 ${checked.length - aliveCount} 个${removedCount ? `，删除 ${removedCount} 个` : ''}`,
        });
      } catch (err) {
        ctx.fetchLog.record({ type: 'probe', kind: 'grab', url: '抓取后异步测速失败', error: err.message });
        if (task) ctx.taskManager.finish(task.id, { error: err.message });
      }
    });
  }

  /** 抓取单个源并回写状态；proxyUrls 为预选代理列表（失败换下一个，全部失败可再现场重选） */
  async function grabOne(item, { probe = false, proxyUrls = [] } = {}) {
    const tries = proxyUrls.length ? proxyUrls : [undefined];
    let lastErr = null;
    for (const proxyUrl of tries) {
      try {
        const result = await grabSources([item.url], { probe, proxyUrl });
        const added = result.poolStats ? result.poolStats.added : 0;
        const updated = result.poolStats ? result.poolStats.updated : 0;
        await ctx.sources.recordResult(item.id, {
          ok: true, nodes: result.nodes.length,
          removed: result.removedUnreachable || 0,
        });
        return {
          id: item.id, url: item.url, ok: true,
          parsed: result.nodes.length, added, updated,
          removedUnreachable: result.removedUnreachable || 0,
          proxyUsed: proxyUrl || (result.proxyUsedLabel || ''),
        };
      } catch (err) {
        lastErr = err;
        await ctx.sources.recordResult(item.id, { ok: false, nodes: 0, error: err.message });
      }
    }
    return { id: item.id, url: item.url, ok: false, error: lastErr ? lastErr.message : '抓取失败' };
  }

  /** 抓取任务开始时预选抓取代理（复用，不再每源现场选）；预选数 grab.proxy_pool_size 可配置 */
  async function preSelectProxies() {
    const grabCfg = (ctx.config && ctx.config.grab) || {};
    const fetcher = (ctx.config && ctx.config.fetcher) || {};
    const want = Math.max(0, Number(grabCfg.proxy_pool_size) || 0);
    if (want < 1 || fetcher.proxy_from_pool === false || !ctx.nodePool) return [];
    // 选代理总超时保护：任何异常/挂起都在 grab.proxy_select_timeout_ms 内返回空，继续抓取
    const totalTimeout = Math.max(1000, Number(grabCfg.proxy_select_timeout_ms) || 60000);
    try {
      const { pickProxiesFromPool } = require('../core/poolProxy');
      const types = Array.isArray(fetcher.proxy_pool_types) && fetcher.proxy_pool_types.length
        ? fetcher.proxy_pool_types
        : ['http', 'socks5', 'socks4', 'ss', 'trojan', 'vless'];
      const ttlMs = Number(fetcher.proxy_bridge_ttl_seconds || 300) * 1000;
      const pick = pickProxiesFromPool(ctx.nodePool, want, {
        types,
        ttlMs,
        skipLocalnode: fetcher.pool_proxy_skip_localnode !== false,
        tcpProbe: fetcher.proxy_tcp_probe !== false,
        tcpProbeTimeoutMs: Number(fetcher.proxy_tcp_probe_timeout_ms || 3000),
        tcpProbeConcurrency: Number(fetcher.proxy_tcp_probe_concurrency || 6),
        maxLatencyMs: Number(fetcher.proxy_max_latency_ms || 0),
        maxProbeNodes: Number(fetcher.proxy_tcp_probe_max_nodes || 12),
      });
      // 与总超时赛跑：超时则放弃预选（返回空，抓取走直连/现场重选）
      const winner = await Promise.race([
        pick,
        new Promise((resolve) => setTimeout(() => resolve(null), totalTimeout)),
      ]);
      if (!winner) return [];
      return winner.map((p) => p.url);
    } catch {
      return [];
    }
  }

  // 来源列表
  app.get('/api/sources', async (req) => {
    const q = req.query || {};
    const all = sources.list();
    const total = all.length;
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 100));
    return {
      ok: true,
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      sources: all.slice((page - 1) * pageSize, page * pageSize),
    };
  });

  // 新增来源
  app.post('/api/sources', async (req, reply) => {
    const body = req.body || {};
    try {
      // 批量添加：body.urls 为数组（每项 {url, note?} 或字符串）；单个：body.url
      if (Array.isArray(body.urls) && body.urls.length) {
        const items = await sources.addMany(body.urls, { note: body.note });
        ctx.fetchLog.record({ type: 'config', kind: 'source', url: `批量新增抓取来源 ${items.length} 个`, error: '' });
        return { ok: true, count: items.length, sources: items };
      }
      const item = await sources.add(body);
      ctx.fetchLog.record({ type: 'config', kind: 'source', url: `新增抓取来源：${item.url}`, error: '' });
      return { ok: true, source: item };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // 编辑来源
  app.put('/api/sources/:id', async (req, reply) => {
    try {
      const item = await sources.update(req.params.id, req.body || {});
      ctx.fetchLog.record({ type: 'config', kind: 'source', url: `更新抓取来源：${item.url}`, error: '' });
      return { ok: true, source: item };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // 删除来源
  app.delete('/api/sources/:id', async (req, reply) => {
    try {
      await sources.remove(req.params.id);
      ctx.fetchLog.record({ type: 'config', kind: 'source', url: `删除抓取来源：${req.params.id}`, error: '' });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // 抓取（ids 缺省=全部启用项；probe=true 抓取并测速）
  // 异步执行：立即返回，后台逐源抓取（避免同步串行阻塞请求与进程收尾，无人值守场景必备）
  app.post('/api/sources/grab', async (req, reply) => {
    const body = req.body || {};
    let items = sources.list().filter((s) => s.enabled !== false);
    if (Array.isArray(body.ids) && body.ids.length) {
      const idSet = new Set(body.ids);
      items = items.filter((s) => idSet.has(s.id));
    }
    if (!items.length) return reply.code(400).send({ error: '没有可抓取的启用来源，请先在源管理中添加' });
    if (grabRunning) return reply.code(409).send({ error: '已有抓取任务运行中，请等待完成后再触发' });

    const probe = body.probe === true;
    grabRunning = true;
    // 登记后台任务（前台「后台任务」标签页实时查看进度）
    const task = ctx.taskManager
      ? ctx.taskManager.start({ type: 'grab', title: `批量抓取来源 ${items.length} 个`, total: items.length })
      : null;
    grabTask = (async () => {
      // 任务开始：并发预选抓取代理（复用，不每源重选）；预选代理全失败时现场重选
      const preProxies = await preSelectProxies();
      if (preProxies.length) {
        ctx.fetchLog.record({ type: 'grab', kind: 'proxy', url: `已预选 ${preProxies.length} 个抓取代理（复用）`, error: '' });
      }
      // 并发抓取（grab.concurrency 配置化，默认 5）：提速且可控，避免长时间串行排队
      const concurrency = Math.max(1, Number((ctx.config.grab || {}).concurrency) || 5);
      const results = new Array(items.length);
      const queue = items.map((item, i) => ({ item, i }));
      let done = 0;
      const progress = () => {
        if (!task) return;
        const ok = results.filter((r) => r && r.ok).length;
        const fail = results.filter((r) => r && !r.ok).length;
        ctx.taskManager.progress(task.id, { done, ok, fail });
      };
      // 每源代理分配：轮询预选代理；预选为空时尝试现场重选（一次）
      const reselectOnce = (() => {
        let done = false;
        return async () => {
          if (done) return [];
          done = true;
          return preSelectProxies();
        };
      })();
      const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (queue.length) {
          const { item, i } = queue.shift();
          done += 1;
          try {
            let proxies = preProxies.length ? [preProxies[i % preProxies.length]] : [];
            results[i] = await grabOne(item, { probe, proxyUrls: proxies });
            // 预选代理抓取失败：换其他预选代理重试；全失败再现场重选一次
            if (!results[i].ok && preProxies.length > 1) {
              const others = preProxies.filter((_, k) => k !== (i % preProxies.length));
              const retry = await grabOne(item, { probe, proxyUrls: others });
              if (retry.ok) results[i] = retry;
            }
            if (!results[i].ok) {
              const reselected = await reselectOnce();
              if (reselected.length) {
                const again = await grabOne(item, { probe, proxyUrls: reselected });
                if (again.ok) results[i] = again;
              }
            }
          } catch (err) {
            results[i] = { id: item.id, url: item.url, ok: false, error: err.message };
          }
          progress();
        }
      });
      await Promise.all(workers);
      const flat = results.filter(Boolean);
      const okCount = flat.filter((r) => r.ok).length;
      ctx.fetchLog.record({
        type: 'grab', kind: 'sources', url: `批量抓取来源 ${flat.length} 个（成功 ${okCount}）`,
        nodes: flat.reduce((a, r) => a + (r.parsed || 0), 0), error: '',
      });
      if (task) ctx.taskManager.finish(task.id, { ok: okCount, fail: flat.length - okCount, summary: `成功 ${okCount} 个 / 失败 ${flat.length - okCount} 个，解析节点 ${flat.reduce((a, r) => a + (r.parsed || 0), 0)}` });
      grabRunning = false;
    })();
    return { ok: true, async: true, total: items.length, message: '抓取已后台启动，可在「后台任务」标签页查看实时进度' };
  });

  // 自动采集状态
  app.get('/api/auto-grab', async () => {
    const grabCfg = (ctx.config.grab || {});
    const intervalMin = Math.max(0, Number(grabCfg.auto_interval_minutes) || 0);
    const enabledSources = sources.list().filter((s) => s.enabled !== false && s.auto !== false).length;
    return {
      ok: true,
      enabled: intervalMin > 0,
      interval_minutes: intervalMin,
      nextRunAt: ctx.autoGrab ? ctx.autoGrab.nextRunAt() : '',
      lastRunAt: ctx.autoGrab ? ctx.autoGrab.lastRunAt() : '',
      running: ctx.autoGrab ? ctx.autoGrab.running() : false,
      enabledSources,
      lastRunSummary: ctx.autoGrab ? ctx.autoGrab.lastRunSummary() : null,
    };
  });

  // 立即触发一次自动采集（手动补采）
  app.post('/api/auto-grab', async (req, reply) => {
    if (!ctx.autoGrab) return reply.code(500).send({ error: '自动采集模块未就绪' });
    try {
      const summary = await ctx.autoGrab.runNow();
      return { ok: true, summary };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });
}

module.exports = { registerSourceApi };
