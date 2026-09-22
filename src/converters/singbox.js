'use strict';

/**
 * sing-box JSON 转换器
 *
 * 将统一节点模型输出为 sing-box outbounds 数组（JSON）。
 * 支持：shadowsocks / vmess / vless / trojan / hysteria / hysteria2 / tuic
 */

const { cleanUndefined } = require('../core/util');

/** 构建 transport 对象（ws/grpc/http） */
function buildTransport(n) {
  if (n.network === 'ws') {
    return cleanUndefined({
      type: 'ws',
      path: n.wsPath || undefined,
      headers: n.wsHost ? { Host: n.wsHost } : undefined,
    });
  }
  if (n.network === 'grpc') {
    return cleanUndefined({
      type: 'grpc',
      service_name: (n.wsPath || '').replace(/^\//, '') || undefined,
    });
  }
  if (n.network === 'http') {
    return cleanUndefined({
      type: 'http',
      host: n.wsHost ? [n.wsHost] : undefined,
      path: n.wsPath || undefined,
    });
  }
  return undefined;
}

/** 构建 tls 对象 */
function buildTls(n, { withUtls = true, withReality = false } = {}) {
  const tls = {
    enabled: !!n.tls,
    server_name: n.sni || undefined,
    insecure: n.skipCertVerify || undefined,
  };
  if (withUtls && n.fingerprint) {
    tls.utls = cleanUndefined({ enabled: true, fingerprint: n.fingerprint });
  }
  if (withReality && n.extras && n.extras.reality) {
    const r = n.extras.reality;
    tls.reality = cleanUndefined({
      enabled: true,
      public_key: r.publicKey || undefined,
      short_id: r.shortId || undefined,
    });
  }
  return cleanUndefined(tls);
}

/** 将统一节点模型转换为 sing-box outbound */
function toSingBoxOutbound(n) {
  const tag = n.name;
  switch (n.type) {
    case 'ss':
      return cleanUndefined({
        type: 'shadowsocks',
        tag,
        server: n.server,
        server_port: n.port,
        method: n.cipher || 'aes-256-gcm',
        password: n.password || '',
      });
    case 'vmess':
      return cleanUndefined({
        type: 'vmess',
        tag,
        server: n.server,
        server_port: n.port,
        uuid: n.uuid || '',
        security: n.cipher || 'auto',
        alter_id: n.alterId ?? 0,
        tls: buildTls(n),
        transport: buildTransport(n),
      });
    case 'vless':
      return cleanUndefined({
        type: 'vless',
        tag,
        server: n.server,
        server_port: n.port,
        uuid: n.uuid || '',
        flow: n.flow || undefined,
        tls: buildTls(n, { withReality: true }),
        transport: buildTransport(n),
      });
    case 'trojan':
      return cleanUndefined({
        type: 'trojan',
        tag,
        server: n.server,
        server_port: n.port,
        password: n.password || '',
        tls: buildTls(n),
        transport: buildTransport(n),
      });
    case 'hysteria':
      return cleanUndefined({
        type: 'hysteria',
        tag,
        server: n.server,
        server_port: n.port,
        up_mbps: parseFloat(n.up) || 10,
        down_mbps: parseFloat(n.down) || 50,
        auth_str: n.auth || n.password || '',
        obfs: n.obfs || undefined,
        tls: cleanUndefined({
          enabled: true,
          server_name: n.sni || undefined,
          insecure: n.skipCertVerify || undefined,
          alpn: n.alpn ? n.alpn.split(',') : undefined,
        }),
      });
    case 'hysteria2':
      return cleanUndefined({
        type: 'hysteria2',
        tag,
        server: n.server,
        server_port: n.port,
        password: n.password || '',
        obfs: n.obfs
          ? cleanUndefined({ type: 'salamander', password: n.obfsPassword || '' })
          : undefined,
        tls: cleanUndefined({
          enabled: true,
          server_name: n.sni || undefined,
          insecure: n.skipCertVerify || undefined,
          alpn: n.alpn ? n.alpn.split(',') : undefined,
        }),
      });
    case 'tuic':
      return cleanUndefined({
        type: 'tuic',
        tag,
        server: n.server,
        server_port: n.port,
        uuid: n.uuid || '',
        password: n.password || undefined,
        congestion_control: n.congestionControl || 'bbr',
        udp_relay_mode: n.udpRelayMode || 'native',
        tls: cleanUndefined({
          enabled: true,
          server_name: n.sni || undefined,
          insecure: n.skipCertVerify || undefined,
          alpn: n.alpn ? n.alpn.split(',') : ['h3'],
        }),
      });
    default:
      return null;
  }
}

/**
 * 生成 sing-box 配置 JSON
 * @param {Array} nodes
 * @param {{name?: string}} opts
 * @returns {string} JSON 文本
 */
function convert(nodes, opts) {
  const outbounds = nodes.map(toSingBoxOutbound).filter(Boolean);
  const doc = cleanUndefined({
    log: { level: 'info' },
    outbounds,
  });
  return JSON.stringify(doc, null, 2);
}

module.exports = { convert, toSingBoxOutbound };
