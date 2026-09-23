'use strict';

/**
 * 无人值守全自动模式 API
 *
 * 全自动运营闭环：定时抓取 → 自动测速 → 自动删除不可用 → 定期清理，
 * 支持分步开启（按步骤逐步启用）与一键退出。所有动作与状态均可配置、可查询、可留痕。
 *
 *   GET  /api/auto-pilot          查询无人值守状态（各步骤是否已应用 + 下次运行时间）
 *   POST /api/auto-pilot/start    开启：body { steps?: string[], cron?: string }
 *                                 steps 缺省为全部（all）；cron 默认 "0 0 * * *"（每天 00:00）
 *   POST /api/auto-pilot/stop     退出无人值守（关闭定时/自动测速/自动删除/定期清理）
 *
 * 步骤定义：
 *   1. cron     定时自动抓取（grab.auto_cron）
 *   2. probe    抓取后自动测速（grab.auto_probe）
 *   3. remove   自动删除不可用节点（grab.auto_remove_unreachable）
 *   4. cleanup  定期清理与质量门槛（pool.cleanup_enabled + pool.drop_unreachable）
 */

const { updateConfig, getConfig } = require('../config/loader');

const STEPS = [
  { id: 'cron', label: '定时自动抓取', desc: '按 cron 表达式定时抓取全部启用来源（默认每天 00:00）。' },
  { id: 'probe', label: '抓取后自动测速', desc: '每次抓取完成后自动对本次入库节点测速，保证拉取节点可用。' },
  { id: 'remove', label: '自动删除不可用', desc: '测速为不可达的节点自动停用并删除，节点库只留可用节点。' },
  { id: 'cleanup', label: '定期清理与质量门槛', desc: '开启清理规则与质量门槛，长期维护节点库健康。' },
];

const DEFAULT_CRON = '0 0 * * *';

/** 读取当前配置中各步骤是否已应用 */
function stepState(cfg) {
  const grab = cfg.grab || {};
  const pool = cfg.pool || {};
  return STEPS.map((s) => {
    let applied = false;
    if (s.id === 'cron') applied = !!(grab.auto_cron && String(grab.auto_cron).trim());
    if (s.id === 'probe') applied = !!grab.auto_probe;
    if (s.id === 'remove') applied = !!grab.auto_remove_unreachable;
    if (s.id === 'cleanup') applied = !!(pool.cleanup_enabled && pool.drop_unreachable !== false && Array.isArray(pool.cleanup_rules) && pool.cleanup_rules.length);
    return Object.assign({}, s, { applied });
  });
}

/** 查询无人值守状态（含 autoGrab 运行信息） */
function queryState(ctx) {
  const cfg = getConfig();
  const steps = stepState(cfg);
  const enabled = steps.some((s) => s.applied);
  return {
    ok: true,
    enabled,
    steps,
    cron: (cfg.grab && cfg.grab.auto_cron) || '',
    interval_minutes: (cfg.grab && cfg.grab.auto_interval_minutes) || 0,
    auto_probe: !!(cfg.grab && cfg.grab.auto_probe),
    auto_remove_unreachable: !!(cfg.grab && cfg.grab.auto_remove_unreachable),
    cleanup_enabled: !!(cfg.pool && cfg.pool.cleanup_enabled),
    last_run_at: ctx.autoGrab ? ctx.autoGrab.lastRunAt() : '',
    next_run_at: ctx.autoGrab ? ctx.autoGrab.nextRunAt() : '',
    last_summary: ctx.autoGrab ? ctx.autoGrab.lastRunSummary() : null,
  };
}

/**
 * 注册无人值守 API
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx 运行上下文（含 autoGrab / fetchLog / nodePool）
 */
function registerAutoPilotApi(app, ctx) {
  // 查询状态
  app.get('/api/auto-pilot', async (req, reply) => {
    if (req.role !== 'admin') return reply.code(403).send({ error: '仅管理员可操作无人值守' });
    return queryState(ctx);
  });

  // 开启无人值守（分步或全部）
  app.post('/api/auto-pilot/start', async (req, reply) => {
    if (req.role !== 'admin') return reply.code(403).send({ error: '仅管理员可操作无人值守' });
    const body = req.body || {};
    const wanted = Array.isArray(body.steps) && body.steps.length ? body.steps.map(String) : STEPS.map((s) => s.id);
    const cronExpr = typeof body.cron === 'string' && body.cron.trim() ? body.cron.trim() : DEFAULT_CRON;
    const patch = {};
    const applied = [];

    if (wanted.includes('cron')) {
      patch.grab = Object.assign({}, patch.grab, { auto_cron: cronExpr });
      applied.push('cron');
    }
    if (wanted.includes('probe')) {
      patch.grab = Object.assign({}, patch.grab, { auto_probe: true });
      applied.push('probe');
    }
    if (wanted.includes('remove')) {
      patch.grab = Object.assign({}, patch.grab, { auto_remove_unreachable: true });
      applied.push('remove');
    }
    if (wanted.includes('cleanup')) {
      patch.pool = Object.assign({}, patch.pool, {
        cleanup_enabled: true,
        drop_unreachable: true,
        cleanup_rules: (body.cleanup_rules && Array.isArray(body.cleanup_rules) && body.cleanup_rules.length)
          ? body.cleanup_rules
          : [{ type: 'unreachable' }, { type: 'no_probe', days: 7 }],
      });
      applied.push('cleanup');
    }

    try {
      await updateConfig(patch);
      ctx.fetchLog.record({
        type: 'config',
        kind: 'auto-pilot',
        url: `无人值守开启（步骤：${applied.join(' / ')}，cron：${cronExpr}）`,
        error: '',
      });
      return Object.assign({ ok: true, enabled: true, applied }, queryState(ctx));
    } catch (err) {
      return reply.code(500).send({ error: `开启失败：${err.message}` });
    }
  });

  // 退出无人值守
  app.post('/api/auto-pilot/stop', async (req, reply) => {
    if (req.role !== 'admin') return reply.code(403).send({ error: '仅管理员可操作无人值守' });
    try {
      await updateConfig({
        grab: { auto_cron: '', auto_probe: false, auto_remove_unreachable: false },
        pool: { cleanup_enabled: false, drop_unreachable: false },
      });
      ctx.fetchLog.record({
        type: 'config',
        kind: 'auto-pilot',
        url: '无人值守已退出（定时/自动测速/自动删除/定期清理全部关闭）',
        error: '',
      });
      return Object.assign({ ok: true, enabled: false, applied: [] }, queryState(ctx));
    } catch (err) {
      return reply.code(500).send({ error: `退出失败：${err.message}` });
    }
  });
}

module.exports = { registerAutoPilotApi, STEPS };
