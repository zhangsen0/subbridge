'use strict';

/**
 * 分享链接列表 / V2RayN 订阅转换器
 *
 *   - links：输出明文分享链接（每行一条）
 *   - v2ray：输出 URL-safe base64 编码的分享链接列表（V2RayN 订阅格式）
 *
 * 节点池累积的节点可能不带原始分享链接（raw），因此为常见协议按统一节点模型
 * 重新生成标准分享链接；无法生成的标准协议（如 hysteria1 老格式）输出空串被跳过。
 */

const { encodeBase64UrlSafe } = require('../core/util');

/** 节点名称转为链接 # 后缀（安全编码，去掉名称中的 # 防止截断） */
function nameFragment(name) {
  const clean = String(name || '').replace(/#.*$/g, '').trim();
  return clean ? '#' + encodeURIComponent(clean) : '';
}

/** vless 标准分享链接（按统一节点模型重新生成，不依赖 raw） */
function vlessLink(n) {
  const params = new URLSearchParams();
  params.set('encryption', 'none');
  if (n.tls) params.set('security', 'tls');
  if (n.network && n.network !== 'tcp') params.set('type', n.network);
  if (n.wsPath) params.set('path', n.wsPath);
  if (n.wsHost) params.set('host', n.wsHost);
  if (n.sni) params.set('sni', n.sni);
  if (n.fingerprint) params.set('fp', n.fingerprint);
  if (n.flow) params.set('flow', n.flow);
  if (n.skipCertVerify) params.set('allowInsecure', '1');
  // reality 扩展参数（vless parser 写入 extras）
  if (n.extras) {
    if (n.extras.pbk) params.set('pbk', n.extras.pbk);
    if (n.extras.sid) params.set('sid', n.extras.sid);
    if (n.extras.spx) params.set('spx', n.extras.spx);
  }
  return `vless://${encodeURIComponent(n.uuid || '')}@${n.server}:${n.port}?${params.toString()}${nameFragment(n.name)}`;
}

/** trojan 标准分享链接 */
function trojanLink(n) {
  const params = new URLSearchParams();
  if (n.network && n.network !== 'tcp') params.set('type', n.network);
  if (n.wsPath) params.set('path', n.wsPath);
  if (n.wsHost) params.set('host', n.wsHost);
  if (n.sni) params.set('sni', n.sni);
  if (n.fingerprint) params.set('fp', n.fingerprint);
  if (n.skipCertVerify) params.set('allowInsecure', '1');
  const qs = params.toString();
  return `trojan://${encodeURIComponent(n.password || '')}@${n.server}:${n.port}${qs ? '?' + qs : ''}${nameFragment(n.name)}`;
}

/** vmess 标准分享链接（base64 JSON，V2RayN / Clash 通用） */
function vmessLink(n) {
  const payload = {
    v: '2',
    ps: n.name || `${n.server}:${n.port}`,
    add: n.server,
    port: n.port,
    id: n.uuid || '',
    aid: n.alterId || 0,
    scy: n.cipher || 'auto',
    net: n.network || 'tcp',
    type: 'none',
    host: n.wsHost || '',
    path: n.wsPath || '',
    tls: n.tls ? 'tls' : '',
    sni: n.sni || '',
  };
  return 'vmess://' + Buffer.from(JSON.stringify(payload)).toString('base64');
}

/** ss 标准分享链接（base64(userinfo@host:port)，兼容插件参数） */
function ssLink(n) {
  const payload = Buffer.from(`${n.cipher || ''}:${n.password || ''}@${n.server}:${n.port}`).toString('base64');
  const plugin = n.extras && n.extras.plugin ? `?plugin=${encodeURIComponent(n.extras.plugin)}` : '';
  return `ss://${payload}${plugin}${nameFragment(n.name)}`;
}

/** ssr 标准分享链接（URL-safe base64 无 padding） */
function ssrLink(n) {
  const core = `${n.server}:${n.port}:${n.protocol || 'origin'}:${n.cipher || ''}:${n.obfs || 'plain'}:${encodeBase64UrlSafe(n.password || '')}`;
  const query = new URLSearchParams();
  if (n.obfsParam) query.set('obfsparam', encodeBase64UrlSafe(n.obfsParam));
  if (n.protocolParam) query.set('protoparam', encodeBase64UrlSafe(n.protocolParam));
  if (n.name) query.set('remarks', encodeBase64UrlSafe(n.name));
  if (n.group) query.set('group', encodeBase64UrlSafe(n.group));
  const qs = query.toString();
  return `ssr://${encodeBase64UrlSafe(core)}${qs ? '?' + qs : ''}`;
}

/** hysteria2 标准分享链接 */
function hy2Link(n) {
  const params = new URLSearchParams();
  if (n.sni) params.set('sni', n.sni);
  if (n.skipCertVerify) params.set('insecure', '1');
  if (n.obfsPassword) params.set('obfs-password', n.obfsPassword);
  const qs = params.toString();
  return `hysteria2://${encodeURIComponent(n.password || '')}@${n.server}:${n.port}${qs ? '?' + qs : ''}${nameFragment(n.name)}`;
}

/**
 * 为无原始分享链接的节点生成标准链接。返回空串表示无法生成，调用方跳过。
 * @param {object} n 统一节点模型
 * @returns {string}
 */
function shareLinkFor(n) {
  if (!n || !n.server) return '';
  const auth = n.username
    ? `${encodeURIComponent(n.username)}:${encodeURIComponent(n.password || '')}@`
    : '';
  switch (n.type) {
    case 'http': return `http://${auth}${n.server}:${n.port}`;
    case 'socks5': return `socks5://${auth}${n.server}:${n.port}`;
    case 'vless': return vlessLink(n);
    case 'trojan': return trojanLink(n);
    case 'vmess': return vmessLink(n);
    case 'ss': return ssLink(n);
    case 'ssr': return ssrLink(n);
    case 'hysteria2': return hy2Link(n);
    default: return '';
  }
}

/**
 * 生成明文分享链接列表（优先原始 raw，否则按模型重新生成）
 * @param {Array} nodes
 * @returns {string}
 */
function convertLinks(nodes) {
  return nodes
    .map((n) => n.raw || shareLinkFor(n))
    .filter((raw) => raw)
    .join('\n');
}

/**
 * 生成 V2RayN 订阅（base64）
 * @param {Array} nodes
 * @returns {string}
 */
function convertV2Ray(nodes) {
  return encodeBase64UrlSafe(convertLinks(nodes));
}

/** 统一转换入口（供转换器分发器调用） */
async function convert(nodes) {
  return convertLinks(nodes);
}

module.exports = { convert, convertLinks, convertV2Ray };
