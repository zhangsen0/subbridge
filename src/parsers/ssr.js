'use strict';

/**
 * ShadowsocksR 分享链接解析
 *
 * 格式：ssr://BASE64(server:port:protocol:method:obfs:obfsparam?protoparam=xx&remarks=xx&group=xx)
 * 注意：SSR 链接通常使用 URL-safe base64 且无 padding，decodeBase64 已兼容。
 */

const { decodeBase64 } = require('../core/util');
const Proxy = require('../core/proxy');

function parse(link) {
  const raw = link.replace(/^ssr:\/\//, '');
  const text = decodeBase64(raw);
  if (!text) return null;

  const [mainPart, queryPart] = text.split('?');
  if (!mainPart) return null;

  const parts = mainPart.split(':');
  if (parts.length < 6) return null;

  const server = parts[0];
  const port = parseInt(parts[1], 10);
  const protocol = parts[2];
  const method = parts[3];
  const obfs = parts[4];
  const obfsParam = parts[5] ? decodeBase64(parts[5]) || parts[5] : '';

  let protocolParam = parts.length > 6 ? decodeBase64(parts[6]) || parts[6] : '';
  let name = '';
  let group = '';

  if (queryPart) {
    const params = new URLSearchParams(queryPart);
    if (params.get('protoparam')) {
      protocolParam = decodeBase64(params.get('protoparam')) || protocolParam;
    }
    if (params.get('remarks')) {
      name = decodeBase64(params.get('remarks')) || params.get('remarks');
    }
    if (params.get('group')) {
      group = decodeBase64(params.get('group')) || params.get('group');
    }
  }

  if (!server || !port || !method) return null;

  return new Proxy({
    name: name || `${server}:${port}`,
    type: 'ssr',
    server,
    port,
    protocol,
    cipher: method,
    obfs,
    obfsParam,
    protocolParam,
    group,
    raw: link,
  });
}

module.exports = { parse };
