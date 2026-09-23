'use strict';

/**
 * 质量门槛公共装配：从配置构造并应用门槛
 *
 * 供测速接口（/api/probe、/api/pool/probe）在写回检测结果后调用，
 * 以及手动触发接口（/api/pool/apply-quality）使用。
 */

const { parseGates, applyGatesToPool } = require('../core/quality');
const { parseCleanupRules, applyCleanup } = require('../core/cleanup');

/** 从配置读取质量门槛参数 */
function qualityOpts(config) {
  const pool = (config && config.pool) || {};
  return {
    enabled: pool.quality_enabled === true,
    gates: parseGates(pool.quality_gates),
    mode: pool.quality_mode === 'any' ? 'any' : 'all',
    defaultPass: pool.quality_default_pass !== false,
  };
}

/**
 * 应用质量门槛（若配置启用且有门槛）
 * @param {object} ctx 应用上下文（nodePool / config / fetchLog）
 * @param {{force?: boolean}} opts force=true 时忽略 quality_enabled 强制应用（手动触发）
 * @returns {Promise<null|{checked, disabled, enabled, gates}>} 未启用/无门槛返回 null
 */
async function maybeApplyQuality(ctx, { force = false } = {}) {
  const q = qualityOpts(ctx.config);
  if (!q.enabled && !force) return null;
  if (!q.gates.length) return null;
  const stats = await applyGatesToPool(ctx.nodePool, q.gates, { mode: q.mode, defaultPass: q.defaultPass });
  if (ctx.fetchLog) {
    ctx.fetchLog.record({
      type: 'pool',
      kind: 'quality',
      url: `质量门槛自动开关（${q.mode}，${q.gates.length} 条）`,
      nodes: stats.checked,
      alive: stats.enabled,
      error: '',
    });
  }
  return { ...stats, gates: q.gates.length, mode: q.mode };
}

/**
 * 应用自动清理（自定义删除逻辑；若配置启用且有规则）
 * @param {object} ctx 应用上下文
 * @param {{force?: boolean}} opts force=true 时忽略 cleanup_enabled 强制清理
 * @returns {Promise<null|{checked, removed, rules}>} 未启用/无规则返回 null
 */
async function maybeCleanup(ctx, { force = false } = {}) {
  const pool = (ctx.config && ctx.config.pool) || {};
  if (pool.cleanup_enabled !== true && !force) return null;
  const rules = parseCleanupRules(pool.cleanup_rules);
  if (!rules.length) return null;
  const stats = await applyCleanup(ctx.nodePool, rules);
  if (ctx.fetchLog) {
    ctx.fetchLog.record({
      type: 'pool',
      kind: 'cleanup',
      // 成功信息放标题（含删除数量），error 字段只放真实失败，避免前端误判为失败
      url: `自动清理（${rules.length} 条规则）${stats.removed ? `：删除 ${stats.removed} 个节点` : ''}`,
      nodes: stats.checked,
      alive: 0,
      error: '',
    });
  }
  return { ...stats, rules: rules.length };
}

module.exports = { qualityOpts, maybeApplyQuality, maybeCleanup };
