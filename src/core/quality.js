'use strict';

/**
 * 节点质量判定与自动开关引擎
 *
 * 与"选取规则"（rules.js，决定输出哪些节点）不同，这里决定"节点是否启用"：
 * 根据质量门槛（latency / speed / alive / score 多指标）自动把不合格节点停用、
 * 合格节点启用。结果写回节点池 enabled 字段，持久生效。
 *
 * 门槛为有序数组，每条可带 enabled:false 单独停用（默认开启）：
 *   - alive   必须可用                    { type: "alive" }
 *   - latency 延迟上限（毫秒）             { type: "latency", max_ms: 300 }
 *   - speed   速度下限（字节/秒）          { type: "speed", min_bps: 1000000 }
 *   - score   质量分下限（0-100）          { type: "score", min_score: 60 }
 *   - name    名称正则排除（静态辅助）     { type: "name", exclude: "测试|过期" }
 *
 * 判定模式：
 *   - all（默认）：节点须通过全部门槛才算合格（不合格则停用）
 *   - any：节点通过任一门槛即算合格
 * 未测节点（无 probe 数据）：默认视为合格放行（defaultPass 可配置），避免刚入库就被停用。
 */

const yaml = require('js-yaml');

/** 解析门槛输入（字符串 / 数组）；无法解析返回空数组 */
function parseGates(input) {
  if (Array.isArray(input)) return input;
  if (!input) return [];
  if (typeof input === 'string' && input.trim()) {
    try {
      const v = JSON.parse(input);
      if (Array.isArray(v)) return v;
    } catch {
      /* 尝试 YAML */
    }
    try {
      const v = yaml.load(input);
      if (Array.isArray(v)) return v;
    } catch {
      /* 非法门槛文本，忽略 */
    }
  }
  return [];
}

/**
 * 节点质量分（0-100）：可用性 40 + 延迟 30 + 速度 30
 * 未测节点返回 null（表示无数据）
 */
function qualityScore(n) {
  const p = n && n.probe;
  if (!p || p.alive === undefined) return null;
  let score = 0;
  if (p.alive) score += 40;
  if (p.latencyMs != null) {
    score += p.latencyMs <= 100 ? 30 : p.latencyMs <= 300 ? 20 : p.latencyMs <= 800 ? 10 : 0;
  }
  if (p.speedBps != null) {
    score += p.speedBps >= 5 * 1024 * 1024 ? 30 : p.speedBps >= 1024 * 1024 ? 20 : p.speedBps >= 100 * 1024 ? 10 : 0;
  }
  return score;
}

/** 判断单个节点是否通过单条门槛；未测节点按 defaultPass 放行 */
function passGate(node, gate, defaultPass) {
  const p = node && node.probe;
  switch (gate.type) {
    case 'alive':
      if (!p || p.alive === undefined) return !!defaultPass;
      return !!p.alive;
    case 'latency':
      if (!p || p.latencyMs == null) return !!defaultPass;
      return p.latencyMs <= Number(gate.max_ms);
    case 'speed':
      if (!p || p.speedBps == null) return !!defaultPass;
      return p.speedBps >= Number(gate.min_bps);
    case 'score': {
      const s = qualityScore(node);
      if (s == null) return !!defaultPass;
      return s >= Number(gate.min_score);
    }
    case 'name':
      if (!gate.exclude) return true;
      try { return !new RegExp(gate.exclude, 'i').test(node.name || ''); } catch { return true; }
    default:
      return true;
  }
}

/**
 * 按门槛判定节点列表
 * @param {Array} nodes 节点列表
 * @param {Array} gates 门槛数组（parseGates 输出）
 * @param {{mode?: 'all'|'any', defaultPass?: boolean}} opts
 * @returns {{pass: Array, fail: Array}} 合格 / 不合格节点
 */
function evaluateGates(nodes, gates, { mode = 'all', defaultPass = true } = {}) {
  const active = (gates || []).filter((g) => g && typeof g === 'object' && g.enabled !== false);
  if (!active.length) return { pass: (nodes || []).slice(), fail: [] };
  const pass = [];
  const fail = [];
  for (const node of nodes || []) {
    const results = active.map((g) => passGate(node, g, defaultPass));
    const ok = mode === 'any' ? results.some(Boolean) : results.every(Boolean);
    (ok ? pass : fail).push(node);
  }
  return { pass, fail };
}

/**
 * 应用门槛并写回节点池 enabled 状态
 * @param {object} nodePool 节点池实例
 * @param {Array} gates 门槛数组
 * @param {{mode?: 'all'|'any', defaultPass?: boolean}} opts
 * @returns {Promise<{checked: number, disabled: number, enabled: number}>}
 */
async function applyGatesToPool(nodePool, gates, { mode = 'all', defaultPass = true } = {}) {
  const nodes = await nodePool.list();
  const { pass, fail } = evaluateGates(nodes, gates, { mode, defaultPass });
  const toEnable = pass.filter((n) => n.enabled === false).map((n) => `${n.type}:${n.server}:${n.port}`);
  const toDisable = fail.filter((n) => n.enabled !== false).map((n) => `${n.type}:${n.server}:${n.port}`);
  if (toEnable.length || toDisable.length) {
    await nodePool.bulkSetEnabled([...toEnable.map((k) => [k, true]), ...toDisable.map((k) => [k, false])]);
  }
  return { checked: nodes.length, disabled: toDisable.length, enabled: toEnable.length };
}

module.exports = { parseGates, evaluateGates, qualityScore, applyGatesToPool };
