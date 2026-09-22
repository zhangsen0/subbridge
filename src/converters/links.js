'use strict';

/**
 * 分享链接列表 / V2RayN 订阅转换器
 *
 *   - links：输出明文分享链接（每行一条，仅保留解析时携带原始链接的节点）
 *   - v2ray：输出 URL-safe base64 编码的分享链接列表（V2RayN 订阅格式）
 */

const { encodeBase64UrlSafe } = require('../core/util');

/**
 * 为无原始分享链接的代理型节点生成标准链接（本机 HTTP / SOCKS5 节点入池后
 * links 目标也能输出）。返回空串表示无法生成，调用方跳过。
 * @param {object} n 统一节点模型
 * @returns {string}
 */
function shareLinkFor(n) {
  if (!n || !n.server) return '';
  const auth = n.username
    ? `${encodeURIComponent(n.username)}:${encodeURIComponent(n.password || '')}@`
    : '';
  if (n.type === 'http') return `http://${auth}${n.server}:${n.port}`;
  if (n.type === 'socks5') return `socks5://${auth}${n.server}:${n.port}`;
  return '';
}

/**
 * 生成明文分享链接列表
 * @param {Array} nodes
 * @returns {string}
 */
function convertLinks(nodes) {
  return nodes
    .map((n) => n.raw || shareLinkFor(n))
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
