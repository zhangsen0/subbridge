'use strict';

/**
 * 节点池自动清理引擎（自定义删除逻辑）
 *
 * 默认"不自动删除"（资产保留原则）；开启 pool.cleanup_enabled 后，
 * 按 pool.cleanup_rules 规则在检测/刷新节点后自动删除不满足条件的节点。
 *
 * 删除规则为 JSON/YAML 数组，**满足任一规则即删除**，每条可加 enabled:false 停用：
 *   - unreachable  检测不可达（probe.alive=false）     { type: "unreachable" }
 *   - stale        超过 N 天未更新                      { type: "stale", days: 7 }
 *   - no_probe     入库超过 N 天仍未测速                 { type: "no_probe", days: 3 }
 *   - latency      延迟超过上限（毫秒）                  { type: "latency", max_ms: 800 }
 *   - speed        速度低于下限（字节/秒）               { type: "speed", min_bps: 100000 }
 *   - score        质量分低于下限                        { type: "score", max_score: 30 }
 *   - name         名称正则匹配                          { type: "name", match: "测试|过期" }
 *   - source       来源包含                              { type: "source", match: "example.com" }
 *
 * 未测节点：latency/speed/score 等依赖探测数据的规则对未测节点不生效（视为不匹配）。
 */

const yaml = require('js-yaml');
const { qualityScore } = require('./quality');

/** 解析清理规则输入（字符串 / 数组）；无法解析返回空数组 */
function parseCleanupRules(input) {
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
      /* 非法规则文本，忽略 */
    }
  }
  return [];
}

/** 判断单条删除规则是否命中节点 */
function matchRule(node, rule) {
  const p = node && node.probe;
  switch (rule.type) {
    case 'unreachable':
      return p && p.alive !== undefined ? !p.alive : false;
    case 'stale': {
      if (!node.updatedAt) return false;
      const days = Number(rule.days) || 7;
      return Date.now() - new Date(node.updatedAt).getTime() > days * 24 * 3600 * 1000;
    }
    case 'no_probe': {
      if (p && (p.alive !== undefined || p.latencyMs != null || p.speedBps != null)) return false;
      if (!node.firstSeen) return false;
      const days = Number(rule.days) || 3;
      return Date.now() - new Date(node.firstSeen).getTime() > days * 24 * 3600 * 1000;
    }
    case 'latency':
      return p && p.latencyMs != null && p.latencyMs > Number(rule.max_ms);
    case 'speed':
      return p && p.speedBps != null && p.speedBps < Number(rule.min_bps);
    case 'score': {
      const s = qualityScore(node);
      return s != null && s < Number(rule.max_score);
    }
    case 'name':
      try { return new RegExp(rule.match, 'i').test(node.name || ''); } catch { return false; }
    case 'source':
      return String(node.source || '').includes(String(rule.match || ''));
    default:
      return false;
  }
}

/**
 * 评估清理规则，返回应删除的节点键
 * @param {Array} nodes 节点列表
 * @param {Array} rules 清理规则（parseCleanupRules 输出）
 * @returns {string[]} 匹配任一规则即删除的键
 */
function evaluateCleanup(nodes, rules) {
  const active = (rules || []).filter((r) => r && typeof r === 'object' && r.enabled !== false);
  if (!active.length) return [];
  const keys = [];
  for (const node of nodes || []) {
    if (active.some((r) => matchRule(node, r))) {
      keys.push(`${node.type}:${node.server}:${node.port}`);
    }
  }
  return keys;
}

/**
 * 执行清理（写回节点池）
 * @param {object} nodePool 节点池实例
 * @param {Array} rules 清理规则
 * @returns {Promise<{checked: number, removed: number}>}
 */
async function applyCleanup(nodePool, rules) {
  const nodes = await nodePool.list();
  const keys = evaluateCleanup(nodes, rules);
  if (!keys.length) return { checked: nodes.length, removed: 0 };
  const removed = await nodePool.remove(keys);
  return { checked: nodes.length, removed };
}

module.exports = { parseCleanupRules, evaluateCleanup, applyCleanup };
