'use strict';

/**
 * 分享链接解析入口
 *
 * 按前缀分发到各协议解析器。
 * 新增协议时：在 src/parsers/ 新增文件，导出 parse(link)，并在下方 registry 注册前缀即可。
 */

const ss = require('./ss');
const ssr = require('./ssr');
const vmess = require('./vmess');
const vless = require('./vless');
const trojan = require('./trojan');
const hysteria = require('./hysteria');
const hysteria2 = require('./hysteria2');
const tuic = require('./tuic');

// 协议前缀注册表（顺序无关，前缀互不相同）
const REGISTRY = [
  { prefix: 'ssr://', parser: ssr },
  { prefix: 'vmess://', parser: vmess },
  { prefix: 'vless://', parser: vless },
  { prefix: 'hysteria2://', parser: hysteria2 },
  { prefix: 'hysteria://', parser: hysteria },
  { prefix: 'trojan://', parser: trojan },
  { prefix: 'tuic://', parser: tuic },
  { prefix: 'ss://', parser: ss },
];

/** 支持的分享链接前缀（用于订阅内容探测） */
const SUPPORTED_PREFIXES = REGISTRY.map((r) => r.prefix);

/**
 * 解析单条分享链接
 * @param {string} link
 * @returns {import('../core/proxy').Proxy|null} 解析失败返回 null
 */
function parseShareLink(link) {
  const trimmed = String(link || '').trim();
  if (!trimmed) return null;
  for (const { prefix, parser } of REGISTRY) {
    if (trimmed.startsWith(prefix)) {
      try {
        return parser.parse(trimmed);
      } catch {
        return null;
      }
    }
  }
  return null;
}

module.exports = { parseShareLink, SUPPORTED_PREFIXES };
