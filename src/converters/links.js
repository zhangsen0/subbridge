'use strict';

/**
 * 分享链接列表 / V2RayN 订阅转换器
 *
 *   - links：输出明文分享链接（每行一条，仅保留解析时携带原始链接的节点）
 *   - v2ray：输出 URL-safe base64 编码的分享链接列表（V2RayN 订阅格式）
 */

const { encodeBase64UrlSafe } = require('../core/util');

/**
 * 生成明文分享链接列表
 * @param {Array} nodes
 * @returns {string}
 */
function convertLinks(nodes) {
  return nodes
    .map((n) => n.raw || '')
    .filter((raw) => raw)
    .join('\n');
}

/**
 * 生成 V2RayN 订阅（base64）
 * @param {Array} nodes
 * @returns {string}
 */
function convertV2Ray(nodes) {
  return encodeBase64UrlSafe(convertLinks(nodes));
}

/** 统一转换入口（供转换器分发器调用） */
async function convert(nodes) {
  return convertLinks(nodes);
}

module.exports = { convert, convertLinks, convertV2Ray };
