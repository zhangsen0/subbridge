'use strict';

/**
 * 节点处理管道（纯函数，便于单元测试）
 *
 * 处理顺序：过滤（include/exclude）-> 去重 -> 排序 -> 重命名（prefix/suffix）
 * 所有规则均来自配置与请求参数，禁止写死。
 */

/**
 * 按名称正则过滤节点
 * @param {Array} nodes
 * @param {{include?: string, exclude?: string}} opts
 * @returns {Array}
 */
function filterNodes(nodes, opts) {
  let out = nodes;
  if (opts.include) {
    const re = toRegExp(opts.include);
    out = out.filter((n) => re.test(n.name));
  }
  if (opts.exclude) {
    const re = toRegExp(opts.exclude);
    out = out.filter((n) => !re.test(n.name));
  }
  return out;
}

/**
 * 按 类型+服务器+端口 去重（保留首个出现的节点）
 * @param {Array} nodes
 * @returns {Array}
 */
function dedupeNodes(nodes) {
  const seen = new Set();
  const out = [];
  for (const n of nodes) {
    const key = `${n.type}:${n.server}:${n.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/**
 * 节点排序
 * @param {Array} nodes
 * @param {string} sort 排序规则：name / name_desc / 空（保持原序）
 * @returns {Array}
 */
function sortNodes(nodes, sort) {
  if (sort === 'name' || sort === 'name_desc') {
    const collator = new Intl.Collator('zh-Hans-CN');
    const sorted = [...nodes].sort((a, b) => collator.compare(a.name, b.name));
    return sort === 'name_desc' ? sorted.reverse() : sorted;
  }
  return nodes;
}

/**
 * 节点重命名（加前后缀）
 * @param {Array} nodes
 * @param {{prefix?: string, suffix?: string}} opts
 * @returns {Array}
 */
function renameNodes(nodes, opts) {
  const prefix = opts.prefix || '';
  const suffix = opts.suffix || '';
  if (!prefix && !suffix) return nodes;
  return nodes.map((n) => {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(n)), n);
    clone.name = prefix + n.name + suffix;
    return clone;
  });
}

/**
 * 编译正则，非法时抛出带原始文本的错误
 * @param {string} source
 * @returns {RegExp}
 */
function toRegExp(source) {
  try {
    return new RegExp(source);
  } catch {
    throw new Error(`无效的正则表达式: ${source}`);
  }
}

/** 完整管道 */
function applyPipeline(nodes, opts) {
  let out = nodes;
  out = filterNodes(out, opts);
  if (opts.dedupe !== false) out = dedupeNodes(out);
  out = sortNodes(out, opts.sort || '');
  out = renameNodes(out, opts);
  return out;
}

module.exports = {
  filterNodes,
  dedupeNodes,
  sortNodes,
  renameNodes,
  applyPipeline,
};
