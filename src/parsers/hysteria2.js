'use strict';

/**
 * Hysteria2 分享链接解析
 *
 * 格式：hysteria2://password@host:port?sni=xx&insecure=1&obfs=salamander&obfs-password=xx&alpn=h3#name
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
  if (u.protocol !== 'hysteria2:' || !u.hostname) return null;

  const port = parseInt(u.port, 10) || 443;
  const q = u.searchParams;
  const name = u.hash ? safeDecodeURIComponent(u.hash.slice(1)) : '';

  return new Proxy({
    name: name || `${u.hostname}:${port}`,
    type: 'hysteria2',
    server: u.hostname,
    port,
    password: safeDecodeURIComponent(u.username),
    sni: q.get('sni') || q.get('peer') || '',
    obfs: q.get('obfs') || '',
    obfsPassword: q.get('obfs-password') || '',
    alpn: q.get('alpn') || '',
    skipCertVerify: q.get('insecure') === '1' || q.get('insecure') === 'true',
    raw: link,
    extras: {},
  });
}

module.exports = { parse };
