'use strict';

/**
 * Hysteria（v1）分享链接解析
 *
 * 格式：hysteria://auth@host:port?protocol=udp&up=20&down=100&sni=xx&insecure=1&alpn=h3&obfs=xx#name
 * 兼容 auth 放在用户名或 query 参数的两种写法。
 */

const { safeDecodeURIComponent } = require('../core/util');
const Proxy = require('../core/proxy');

function parse(link) {
  let u;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== 'hysteria:' || !u.hostname) return null;

  const port = parseInt(u.port, 10) || 443;
  const q = u.searchParams;
  const name = u.hash ? safeDecodeURIComponent(u.hash.slice(1)) : '';
  const auth = u.username ? safeDecodeURIComponent(u.username) : q.get('auth') || '';

  return new Proxy({
    name: name || `${u.hostname}:${port}`,
    type: 'hysteria',
    server: u.hostname,
    port,
    auth,
    up: q.get('up') || '',
    down: q.get('down') || '',
    obfs: q.get('obfs') || '',
    sni: q.get('peer') || q.get('sni') || '',
    alpn: q.get('alpn') || '',
    skipCertVerify: q.get('insecure') === '1' || q.get('insecure') === 'true',
    raw: link,
    extras: {},
  });
}

module.exports = { parse };
