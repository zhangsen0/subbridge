'use strict';

/**
 * Clash / Mihomo 订阅（YAML）解析
 *
 * 从订阅内容中提取 proxies 列表，映射为统一的节点模型。
 * 转换后生成的节点保留 raw 字段为空（无法还原分享链接，links 目标会跳过）。
 */

const yaml = require('js-yaml');
const Proxy = require('../core/proxy');

/**
 * 解析 Clash YAML 订阅
 * @param {string} content
 * @returns {Array|null} 节点列表；不是 Clash 格式时返回 null
 */
function parse(content) {
  let doc;
  try {
    doc = yaml.load(content);
  } catch {
    return null;
  }
  if (!doc || !Array.isArray(doc.proxies)) return null;

  const nodes = [];
  for (const item of doc.proxies) {
    const node = mapClashProxy(item);
    if (node) nodes.push(node);
  }
  return nodes.length ? nodes : null;
}

/** 将单个 Clash proxy 对象映射为统一节点模型 */
function mapClashProxy(item) {
  const type = String(item.type || '').toLowerCase();
  const base = {
    name: item.name || '',
    type,
    server: item.server || '',
    port: parseInt(item.port, 10) || 0,
    udp: item.udp !== false,
    raw: '',
    extras: { clash: item }, // 保留原始对象，供转换器无损回写
  };

  switch (type) {
    case 'ss':
      return new Proxy({ ...base, cipher: item.cipher || '', password: item.password || '' });
    case 'ssr':
      return new Proxy({
        ...base,
        password: item.password || '',
        protocol: item.protocol || '',
        cipher: item.cipher || '',
        obfs: item.obfs || '',
        obfsParam: item['obfs-param'] || '',
        protocolParam: item['protocol-param'] || '',
      });
    case 'vmess':
      return new Proxy({
        ...base,
        uuid: item.uuid || '',
        alterId: item.alterId !== undefined ? parseInt(item.alterId, 10) : 0,
        cipher: item.cipher || 'auto',
        tls: !!item.tls,
        sni: item.servername || item.sni || '',
        fingerprint: item['client-fingerprint'] || '',
        network: item.network || 'tcp',
        wsPath: (item['ws-opts'] && item['ws-opts'].path) || '',
        wsHost: (item['ws-opts'] && item['ws-opts'].headers && item['ws-opts'].headers.Host) || '',
        skipCertVerify: !!item['skip-cert-verify'],
      });
    case 'vless':
      return new Proxy({
        ...base,
        uuid: item.uuid || '',
        flow: item.flow || '',
        tls: !!item.tls,
        sni: item.servername || item.sni || '',
        fingerprint: item['client-fingerprint'] || '',
        network: item.network || 'tcp',
        wsPath: (item['ws-opts'] && item['ws-opts'].path) || '',
        wsHost: (item['ws-opts'] && item['ws-opts'].headers && item['ws-opts'].headers.Host) || '',
        skipCertVerify: !!item['skip-cert-verify'],
        extras: {
          ...base.extras,
          reality: item['reality-opts'] || undefined,
        },
      });
    case 'trojan':
      return new Proxy({
        ...base,
        password: item.password || '',
        tls: true,
        sni: item.sni || item.servername || '',
        fingerprint: item['client-fingerprint'] || '',
        network: item.network || 'tcp',
        wsPath: (item['ws-opts'] && item['ws-opts'].path) || '',
        wsHost: (item['ws-opts'] && item['ws-opts'].headers && item['ws-opts'].headers.Host) || '',
        skipCertVerify: !!item['skip-cert-verify'],
      });
    case 'hysteria':
      return new Proxy({
        ...base,
        auth: item.auth || item['auth-str'] || item.password || '',
        up: item.up !== undefined ? String(item.up) : '',
        down: item.down !== undefined ? String(item.down) : '',
        obfs: item.obfs || '',
        sni: item.sni || '',
        alpn: item.alpn ? (Array.isArray(item.alpn) ? item.alpn.join(',') : String(item.alpn)) : '',
        skipCertVerify: !!item['skip-cert-verify'],
      });
    case 'hysteria2':
      return new Proxy({
        ...base,
        password: item.password || '',
        obfs: item.obfs || '',
        obfsPassword: item['obfs-password'] || '',
        sni: item.sni || '',
        alpn: item.alpn ? (Array.isArray(item.alpn) ? item.alpn.join(',') : String(item.alpn)) : '',
        skipCertVerify: !!item['skip-cert-verify'],
      });
    case 'tuic':
      return new Proxy({
        ...base,
        uuid: item.uuid || '',
        password: item.password || '',
        alpn: item.alpn ? (Array.isArray(item.alpn) ? item.alpn.join(',') : String(item.alpn)) : 'h3',
        congestionControl: item['congestion-controller'] || '',
        udpRelayMode: item['udp-relay-mode'] || '',
        sni: item.sni || '',
        skipCertVerify: !!item['skip-cert-verify'],
      });
    default:
      // http / socks5 等透传类型
      if (type === 'http' || type === 'socks5') {
        return new Proxy({
          ...base,
          username: item.username || '',
          password: item.password || '',
        });
      }
      return null;
  }
}

module.exports = { parse };
