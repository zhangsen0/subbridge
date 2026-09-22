'use strict';

/**
 * V2Ray vmess 分享链接解析
 *
 * 格式：vmess://BASE64(JSON) 或 vmess://JSON（少数客户端直接明文）
 * JSON 字段（v2rayN 风格）：v/ps/add/port/id/aid/net/type/host/path/tls/sni/alpn/fp/scy
 */

const { decodeBase64, safeDecodeURIComponent } = require('../core/util');
const Proxy = require('../core/proxy');

function parse(link) {
  const rest = link.replace(/^vmess:\/\//, '').split('#')[0];

  let obj = null;
  // 优先尝试 base64 解码
  const decoded = decodeBase64(rest);
  if (decoded) {
    try {
      obj = JSON.parse(decoded);
    } catch { /* 继续尝试明文 JSON */ }
  }
  if (!obj) {
    try {
      obj = JSON.parse(rest);
    } catch {
      return null;
    }
  }
  if (!obj || !obj.add) return null;

  const port = parseInt(obj.port, 10) || 443;
  const name = String(obj.ps || obj.remarks || '').trim();

  return new Proxy({
    name: name || `${obj.add}:${port}`,
    type: 'vmess',
    server: obj.add,
    port,
    uuid: obj.id || '',
    alterId: obj.aid !== undefined ? parseInt(obj.aid, 10) : 0,
    cipher: obj.scy || 'auto',
    network: obj.net || 'tcp',
    tls: obj.tls === 'tls' || obj.tls === true,
    sni: obj.sni || obj.host || '',
    fingerprint: obj.fp || '',
    wsPath: obj.path || '',
    wsHost: obj.host || '',
    raw: link,
    extras: {},
  });
}

module.exports = { parse };
