'use strict';

/**
 * 通用工具函数：base64 变体解码、host:port 拆分、安全解码等。
 * 所有解析器共用，保持单一职责、避免重复代码。
 */

/**
 * base64 文本解码，兼容：
 *   - 标准 base64 与 URL-safe base64
 *   - 带/不带 padding
 * 解码结果必须是合法 UTF-8 文本（不含替换符），否则返回 null。
 * @param {string} input
 * @returns {string|null}
 */
function decodeBase64(input) {
  if (typeof input !== 'string') return null;
  const s = input.replace(/\s+/g, '');
  if (!s) return null;

  // 收集可能的编码变体
  const variants = [];
  const push = (t) => { if (t && !variants.includes(t)) variants.push(t); };
  push(s);
  push(s.replace(/-/g, '+').replace(/_/g, '/'));   // url-safe -> 标准
  push(s.replace(/\+/g, '-').replace(/\//g, '_')); // 标准 -> url-safe

  for (const v of variants) {
    // 补齐 padding
    let padded = v;
    const rem = v.length % 4;
    if (rem === 1) continue; // 长度非法
    if (rem === 2) padded = v + '==';
    else if (rem === 3) padded = v + '=';

    try {
      const buf = Buffer.from(padded, 'base64');
      if (buf.length === 0) continue;
      const text = buf.toString('utf8');
      // 含替换符说明不是有效文本，尝试下一种变体
      if (text.includes('\uFFFD')) continue;
      return text;
    } catch { /* 尝试下一种变体 */ }
  }
  return null;
}

/**
 * 将文本编码为 URL-safe base64（无 padding），用于 V2RayN 等订阅格式
 * @param {string} input
 * @returns {string}
 */
function encodeBase64UrlSafe(input) {
  return Buffer.from(String(input), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * 拆分 host:port 字符串，兼容 IPv6 方括号写法（[::1]:443）
 * @param {string} hostPort
 * @param {number} defaultPort 未显式指定端口时的默认端口
 * @returns {{host: string, port: number}}
 */
function splitHostPort(hostPort, defaultPort = 443) {
  const s = String(hostPort || '').trim();
  if (!s) return { host: '', port: defaultPort };

  // IPv6：[::1]:443 或 [::1]
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end > 0) {
      const host = s.slice(1, end);
      const rest = s.slice(end + 1);
      const port = rest.startsWith(':') ? parseInt(rest.slice(1), 10) : defaultPort;
      return { host, port: Number.isFinite(port) ? port : defaultPort };
    }
  }

  // 普通 host:port
  const idx = s.lastIndexOf(':');
  if (idx > 0) {
    const host = s.slice(0, idx);
    const port = parseInt(s.slice(idx + 1), 10);
    if (host && Number.isFinite(port)) return { host, port };
  }
  return { host: s, port: defaultPort };
}

/** 安全解码 URI 组件，解码失败时原样返回 */
function safeDecodeURIComponent(s) {
  try {
    return decodeURIComponent(String(s));
  } catch {
    return String(s);
  }
}

/**
 * 判断字符串是否为合法的 http/https 链接
 * @param {string} s
 * @returns {boolean}
 */
function isValidHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 浅层清理：去掉对象中值为 undefined 的键（用于 yaml.dump 前预处理） */
function cleanUndefined(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * HTTP 响应头值安全化：Node 仅允许可打印 ASCII（0x20-0x7E），
 * 中文与换行会抛 ERR_INVALID_CHAR。这里统一转为 URL 编码，保证无损且合规。
 * @param {string} value 原始文本
 * @returns {string} 可安全放入响应头的值
 */
function safeHeaderValue(value) {
  return encodeURIComponent(String(value ?? ''))
    .replace(/[()<>@,;:\\"/[\]?={}]/g, (ch) => encodeURIComponent(ch))
    .replace(/%20/g, ' ');
}

module.exports = {
  decodeBase64,
  encodeBase64UrlSafe,
  splitHostPort,
  safeDecodeURIComponent,
  isValidHttpUrl,
  cleanUndefined,
  safeHeaderValue,
};
