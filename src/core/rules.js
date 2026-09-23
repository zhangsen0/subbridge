'use strict';

/**
 * 节点选取规则引擎：从节点池（或任意节点列表）按规则挑选节点
 *
 * 规则为有序数组，逐条作用于节点列表：
 *   - include   名称正则包含            { type:"include", pattern:"香港|HK" }
 *   - exclude   名称正则排除            { type:"exclude", pattern:"测试|过期" }
 *   - type      节点类型白名单           { type:"type", value:["ss","vmess","trojan"] }
 *   - country   国家/地区白名单（大写）  { type:"country", value:["JP","HK","US"] }
 *   - source    来源域名包含             { type:"source", pattern:"example.com" }
 *   - latency   延迟上限（毫秒，必须有真实数据且 ≤ 上限） { type:"latency", max_ms:200 }
 *   - speed     速度下限（字节/秒，必须有真实数据且 ≥ 下限） { type:"speed", min_bps:1000000 }
 *   - sort      排序（latency/speed/name） { type:"sort", key:"latency", order:"asc" }
 *   - limit     数量上限                 { type:"limit", count:20 }
 *
 * 规则文本支持 JSON 或 YAML 数组，可直接来自配置 / 请求参数。
 */

const yaml = require('js-yaml');

/** 解析规则输入（字符串 / 数组）为规则数组；无法解析返回空数组 */
function parseRules(input) {
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

/** 节点探测字段辅助读取 */
function probeOf(n) {
  return n && n.probe ? n.probe : null;
}

/** 按规则排序节点（latency / speed / name） */
function sortByKey(nodes, key, desc) {
  const collator = new Intl.Collator('zh-Hans-CN');
  const dir = desc ? -1 : 1;
  return nodes.slice().sort((a, b) => {
    if (key === 'name') return dir * collator.compare(a.name || '', b.name || '');
    const va = probeOf(a) && probeOf(a)[key === 'speed' ? 'speedBps' : 'latencyMs'];
    const vb = probeOf(b) && probeOf(b)[key === 'speed' ? 'speedBps' : 'latencyMs'];
    // 未测节点（无数据）无论升/降序都排最后，避免订阅输出把未知质量的节点排在前
    const na = va == null ? (desc ? -Infinity : Infinity) : va;
    const nb = vb == null ? (desc ? -Infinity : Infinity) : vb;
    return dir * (na - nb);
  });
}

/**
 * 应用规则列表
 * 规则默认开启：enabled 字段未设置或为 true 时生效；显式 enabled: false 停用该条规则。
 * @param {Array} nodes 节点列表
 * @param {Array} rules 规则数组（parseRules 输出）
 * @returns {Array} 按规则选取后的节点
 */
function applyRules(nodes, rules) {
  let out = Array.isArray(nodes) ? nodes.slice() : [];
  for (const rule of rules || []) {
    if (!rule || typeof rule !== 'object') continue;
    // 规则开关：默认开启，可显式停用（enabled: false）
    if (rule.enabled === false) continue;
    switch (rule.type) {
      case 'include':
        try { out = out.filter((n) => new RegExp(rule.pattern, 'i').test(n.name || '')); } catch { /* 忽略非法正则 */ }
        break;
      case 'exclude':
        try { out = out.filter((n) => !new RegExp(rule.pattern, 'i').test(n.name || '')); } catch { /* 忽略非法正则 */ }
        break;
      case 'type':
        out = out.filter((n) => (rule.value || []).includes(n.type));
        break;
      case 'country':
        out = out.filter((n) => (rule.value || []).map((c) => String(c).toUpperCase()).includes(String(n.countryCode || n.country || '').toUpperCase()));
        break;
      case 'source':
        out = out.filter((n) => String(n.source || '').includes(String(rule.pattern || '')));
        break;
      case 'latency':
        // 严格判定：必须有真实延迟数据且 ≤ 上限（无数据不算满足，避免虚构指标）
        out = out.filter((n) => {
          const l = probeOf(n) && probeOf(n).latencyMs;
          return l != null && l <= Number(rule.max_ms);
        });
        break;
      case 'speed':
        // 严格判定：必须有真实测速数据且 ≥ 下限（无数据不算满足，避免虚构指标）
        out = out.filter((n) => {
          const s = probeOf(n) && probeOf(n).speedBps;
          return s != null && s >= Number(rule.min_bps);
        });
        break;
      case 'sort':
        out = sortByKey(out, rule.key || 'latency', rule.order === 'desc');
        break;
      case 'limit':
        out = out.slice(0, Math.max(0, Number(rule.count) || 0));
        break;
      default:
        break;
    }
  }
  return out;
}

module.exports = { parseRules, applyRules, sortByKey };
