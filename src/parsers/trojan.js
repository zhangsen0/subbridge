'use strict';

/**
 * Trojan 分享链接解析
 *
 * 格式：trojan://password@host:port?security=tls&sni=xx&type=ws|grpc&path=xx&host=xx#name
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
  if (u.protocol !== 'trojan:' || !u.hostname) return null;

  const port = parseInt(u.port, 10) || 443;
  const q = u.searchParams;
  const name = u.hash ? safeDecodeURIComponent(u.hash.slice(1)) : '';

  return new Proxy({
    name: name || `${u.hostname}:${port}`,
    type: 'trojan',
    server: u.hostname,
    port,
    password: safeDecodeURIComponent(u.username),
    network: q.get('type') || 'tcp',
    sni: q.get('sni') || q.get('peer') || '',
    fingerprint: q.get('fp') || '',
    wsPath: q.get('path') || '',
    wsHost: q.get('host') || '',
    skipCertVerify: q.get('allowInsecure') === '1' || q.get('allowInsecure') === 'true',
    tls: true,
    raw: link,
    extras: {},
  });
}

module.exports = { parse };
