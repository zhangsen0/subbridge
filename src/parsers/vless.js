'use strict';

/**
 * VLESS 分享链接解析
 *
 * 格式：vless://uuid@host:port?encryption=none&security=tls|reality&sni=xx&fp=xx&type=ws|grpc|http&path=xx&host=xx#name
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
  if (u.protocol !== 'vless:' || !u.hostname) return null;

  const port = parseInt(u.port, 10) || 443;
  const q = u.searchParams;
  const name = u.hash ? safeDecodeURIComponent(u.hash.slice(1)) : '';

  const security = q.get('security') || '';
  const proxy = new Proxy({
    name: name || `${u.hostname}:${port}`,
    type: 'vless',
    server: u.hostname,
    port,
    uuid: safeDecodeURIComponent(u.username),
    flow: q.get('flow') || '',
    tls: security === 'tls' || security === 'reality',
    sni: q.get('sni') || q.get('peer') || '',
    fingerprint: q.get('fp') || '',
    network: q.get('type') || 'tcp',
    wsPath: q.get('path') || '',
    wsHost: q.get('host') || '',
    skipCertVerify: q.get('allowInsecure') === '1' || q.get('allowInsecure') === 'true',
    raw: link,
    extras: {},
  });

  // reality 参数（公钥/短 ID/伪装 spiderX）放入扩展字段，供 Clash reality-opts 使用
  if (security === 'reality') {
    proxy.extras.reality = {
      publicKey: q.get('pbk') || '',
      shortId: q.get('sid') || '',
      spiderX: q.get('spx') || '',
    };
  }
  if (q.get('alpn')) proxy.alpn = q.get('alpn');
  return proxy;
}

module.exports = { parse };
