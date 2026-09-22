'use strict';

/**
 * TUIC 分享链接解析
 *
 * 格式：tuic://uuid:password@host:port?sni=xx&alpn=h3&congestion_control=bbr&udp_relay_mode=native&allow_insecure=1#name
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
  if (u.protocol !== 'tuic:' || !u.hostname) return null;

  const port = parseInt(u.port, 10) || 443;
  const q = u.searchParams;
  const name = u.hash ? safeDecodeURIComponent(u.hash.slice(1)) : '';

  // WHATWG URL 会将 userinfo 按第一个冒号拆分为 username/password
  // tuic 链接中 username 为 uuid，password 为密码
  const uuid = safeDecodeURIComponent(u.username);
  const password = safeDecodeURIComponent(u.password);

  return new Proxy({
    name: name || `${u.hostname}:${port}`,
    type: 'tuic',
    server: u.hostname,
    port,
    uuid,
    password,
    sni: q.get('sni') || q.get('peer') || '',
    alpn: q.get('alpn') || 'h3',
    congestionControl: q.get('congestion_control') || '',
    udpRelayMode: q.get('udp_relay_mode') || '',
    skipCertVerify: q.get('allow_insecure') === '1' || q.get('allow_insecure') === 'true',
    raw: link,
    extras: {},
  });
}

module.exports = { parse };
