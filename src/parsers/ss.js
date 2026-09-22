'use strict';

/**
 * Shadowsocks 分享链接解析
 *
 * 兼容两种格式：
 *   1. 传统格式：ss://BASE64(method:password@host:port)#name
 *   2. SIP002 格式：ss://BASE64(method:password)@host:port?plugin=...#name
 */

const { decodeBase64, splitHostPort, safeDecodeURIComponent } = require('../core/util');
const Proxy = require('../core/proxy');

function parse(link) {
  const rest = link.replace(/^ss:\/\//, '');

  // 拆出节点名称（# 后）
  let name = '';
  let main = rest;
  const hashIdx = rest.indexOf('#');
  if (hashIdx >= 0) {
    name = safeDecodeURIComponent(rest.slice(hashIdx + 1));
    main = rest.slice(0, hashIdx);
  }

  let method = '';
  let password = '';
  let server = '';
  let port = 0;
  let plugin = '';

  // SIP002 格式：BASE64(method:password)@host:port?plugin=...
  const atIdx = main.lastIndexOf('@');
  if (atIdx > 0) {
    const head = main.slice(0, atIdx);
    const decoded = decodeBase64(head);
    if (decoded && decoded.includes(':')) {
      const colon = decoded.indexOf(':');
      method = decoded.slice(0, colon);
      password = decoded.slice(colon + 1);

      const tail = main.slice(atIdx + 1);
      const qIdx = tail.indexOf('?');
      const hostPort = qIdx >= 0 ? tail.slice(0, qIdx) : tail;
      if (qIdx >= 0) {
        const params = new URLSearchParams(tail.slice(qIdx + 1));
        plugin = params.get('plugin') || '';
      }
      const hp = splitHostPort(hostPort);
      server = hp.host;
      port = hp.port;
    }
  }

  // 传统格式：BASE64(method:password@host:port)
  if (!server) {
    const decoded = decodeBase64(main);
    if (!decoded) return null;
    const at2 = decoded.lastIndexOf('@');
    if (at2 <= 0) return null;
    const userInfo = decoded.slice(0, at2);
    const hp = splitHostPort(decoded.slice(at2 + 1));
    const colon = userInfo.indexOf(':');
    if (colon <= 0) return null;
    method = userInfo.slice(0, colon);
    password = userInfo.slice(colon + 1);
    server = hp.host;
    port = hp.port;
  }

  if (!method || !password || !server || !port) return null;

  const proxy = new Proxy({
    name: name || `${server}:${port}`,
    type: 'ss',
    server,
    port,
    cipher: method,
    password,
    raw: link,
  });
  // 插件参数（如 obfs-local / v2ray-plugin）原样透传到 extras，供转换器按需处理
  if (plugin) proxy.extras.plugin = plugin;
  return proxy;
}

module.exports = { parse };
