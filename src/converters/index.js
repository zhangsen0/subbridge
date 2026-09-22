'use strict';

/**
 * 转换器注册与分发
 *
 * 新增目标格式：在 src/converters/ 新增文件，导出 convert(nodes, opts, ctx)，
 * 并在下方 TARGETS 中注册目标名即可。
 */

const clash = require('./clash');
const singbox = require('./singbox');
const links = require('./links');

// 目标格式注册表：名称 -> 转换器模块
const TARGETS = {
  clash,
  singbox,
  links,
  v2ray: links, // v2ray 目标复用 links 模块的 base64 输出
};

/** 支持的目标格式列表 */
const TARGET_NAMES = Object.keys(TARGETS);

/**
 * 按目标格式转换节点列表
 * @param {string} target 目标格式（clash/singbox/links/v2ray）
 * @param {Array} nodes 节点列表
 * @param {object} opts 转换选项
 * @param {object} ctx 上下文（config/templatesDir/dataDir）
 * @returns {Promise<string>}
 */
async function convert(target, nodes, opts, ctx) {
  const module = TARGETS[target];
  if (!module) throw new Error(`不支持的目标格式: ${target}`);
  if (target === 'v2ray') return links.convertV2Ray(nodes);
  return module.convert(nodes, opts, ctx);
}

/** 目标格式对应的 Content-Type */
function contentTypeFor(target) {
  switch (target) {
    case 'clash':
      return 'text/yaml; charset=utf-8';
    case 'singbox':
      return 'application/json; charset=utf-8';
    case 'links':
      return 'text/plain; charset=utf-8';
    case 'v2ray':
      return 'text/plain; charset=utf-8';
    default:
      return 'text/plain; charset=utf-8';
  }
}

module.exports = { convert, contentTypeFor, TARGETS, TARGET_NAMES };
