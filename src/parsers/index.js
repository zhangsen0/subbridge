'use strict';

/**
 * 订阅内容格式探测与解析入口
 *
 * 支持格式（自动探测）：
 *   1. V2RayN / sing-box JSON
 *   2. Clash / Mihomo YAML
 *   3. base64 编码的行式分享链接订阅
 *   4. 明文行式分享链接（每行一条 ss/ssr/vmess/vless/trojan/hysteria/hysteria2/tuic）
 */

const share = require('./share');
const clash = require('./clash');
const v2ray = require('./v2ray');
const { decodeBase64 } = require('../core/util');

// 近似判断整体是否为 base64 文本（只含 base64 字符集且足够长）
const BASE64_LIKE_RE = /^[A-Za-z0-9+/=_\-]{30,}$/;

/**
 * 解析订阅内容
 * @param {string} content 订阅文本
 * @returns {{nodes: Array, format: string}}
 */
function parseSubscription(content) {
  const trimmed = String(content || '').trim();
  if (!trimmed) return { nodes: [], format: 'empty' };

  // 1. JSON（V2RayN / sing-box）
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const nodes = v2ray.parse(trimmed);
    if (nodes) return { nodes, format: 'v2ray' };
  }

  // 2. Clash YAML（含 proxies: 顶层键）
  if (/^\s*proxies\s*:/m.test(trimmed)) {
    const nodes = clash.parse(trimmed);
    if (nodes) return { nodes, format: 'clash' };
  }

  // 3. 整体 base64 订阅
  const compact = trimmed.replace(/\s+/g, '');
  if (BASE64_LIKE_RE.test(compact)) {
    const decoded = decodeBase64(compact);
    if (decoded) {
      // 解码后可能是 Clash YAML
      if (/^\s*proxies\s*:/m.test(decoded)) {
        const nodes = clash.parse(decoded);
        if (nodes) return { nodes, format: 'clash' };
      }
      // 解码后可能是 JSON
      if (decoded.trim().startsWith('{') || decoded.trim().startsWith('[')) {
        const nodes = v2ray.parse(decoded.trim());
        if (nodes) return { nodes, format: 'v2ray' };
      }
      // 解码后是行式分享链接
      const nodes = parseLines(decoded);
      if (nodes.length) return { nodes, format: 'base64-links' };
    }
  }

  // 4. 明文行式分享链接
  const nodes = parseLines(trimmed);
  if (nodes.length) return { nodes, format: 'links' };

  return { nodes: [], format: 'unknown' };
}

/** 按行解析分享链接 */
function parseLines(text) {
  const nodes = [];
  const seen = new Set();
  for (const rawLine of String(text).split(/[\r\n]+/)) {
    const line = rawLine.trim();
    if (!line || seen.has(line)) continue;

    // 只处理已知协议的分享链接；http(s) 嵌套订阅链接忽略（避免递归抓取）
    if (!share.SUPPORTED_PREFIXES.some((p) => line.startsWith(p))) continue;

    seen.add(line);
    const node = share.parseShareLink(line);
    if (node) nodes.push(node);
  }
  return nodes;
}

module.exports = { parseSubscription };
