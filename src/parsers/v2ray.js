'use strict';

/**
 * V2RayN / sing-box JSON 订阅解析
 *
 * 兼容三种结构：
 *   1. V2RayN 订阅：JSON 数组，每项是 vmess 风格对象（含 add/port/id 等字段）
 *   2. 单个 vmess 对象
 *   3. sing-box 完整配置：outbounds 数组（type/server/server_port 等字段）
 */

const Proxy = require('../core/proxy');

/**
 * 解析 JSON 订阅
 * @param {string} content
 * @returns {Array|null} 节点列表；不是 JSON 订阅时返回 null
 */
function parse(content) {
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }

  const nodes = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      const node = mapJsonEntry(item);
      if (node) nodes.push(node);
    }
  } else if (data && Array.isArray(data.outbounds)) {
    for (const item of data.outbounds) {
      const node = mapSingBoxOutbound(item);
      if (node) nodes.push(node);
    }
  } else if (data && data.add) {
    const node = mapVmessObject(data);
    if (node) nodes.push(node);
  } else {
    return null;
  }

  return nodes.length ? nodes : null;
}

/** 将 vmess 风格 JSON 对象映射为节点模型 */
function mapVmessObject(obj) {
  if (!obj || !obj.add) return null;
  const port = parseInt(obj.port, 10) || 443;
  return new Proxy({
    name: String(obj.ps || obj.remarks || '').trim() || `${obj.add}:${port}`,
    type: 'vmess',
    server: obj.add,
    port,
    uuid: obj.id || '',
    alterId: obj.aid !== undefined ? parseInt(obj.aid, 10) : 0,
    cipher: obj.scy || 'auto',
    network: obj.net || 'tcp',
    tls: obj.tls === 'tls' || obj.tls === true,
    sni: obj.sni || obj.host || '',
    fingerprint: obj.fp || '',
    wsPath: obj.path || '',
    wsHost: obj.host || '',
    raw: '',
  });
}

/** 将 sing-box outbound 映射为节点模型 */
function mapSingBoxOutbound(ob) {
  if (!ob || !ob.server) return null;
  const type = String(ob.type || '').toLowerCase();
  const tls = ob.tls || {};
  const transport = ob.transport || {};
  const base = {
    name: ob.tag || ob.name || `${ob.server}:${ob.server_port}`,
    server: ob.server,
    port: parseInt(ob.server_port, 10) || 443,
    raw: '',
    extras: { singbox: ob },
  };

  switch (type) {
    case 'shadowsocks':
      return new Proxy({ ...base, type: 'ss', cipher: ob.method || '', password: ob.password || '' });
    case 'shadowsocksr':
      return new Proxy({ ...base, type: 'ssr', cipher: ob.method || '', password: ob.password || '' });
    case 'vmess':
      return new Proxy({
        ...base,
        type: 'vmess',
        uuid: ob.uuid || '',
        alterId: ob.alter_id !== undefined ? ob.alter_id : 0,
        cipher: ob.security || 'auto',
        tls: !!tls.enabled,
        sni: tls.server_name || '',
        fingerprint: (tls.utls && tls.utls.fingerprint) || '',
        network: transport.type || 'tcp',
        wsPath: transport.path || '',
        wsHost: (transport.headers && transport.headers.Host) || '',
        skipCertVerify: !!tls.insecure,
      });
    case 'vless':
      return new Proxy({
        ...base,
        type: 'vless',
        uuid: ob.uuid || '',
        flow: ob.flow || '',
        tls: !!tls.enabled,
        sni: tls.server_name || '',
        fingerprint: (tls.utls && tls.utls.fingerprint) || '',
        network: transport.type || 'tcp',
        wsPath: transport.path || '',
        wsHost: (transport.headers && transport.headers.Host) || '',
        skipCertVerify: !!tls.insecure,
        extras: {
          ...base.extras,
          reality: tls.reality || undefined,
        },
      });
    case 'trojan':
      return new Proxy({
        ...base,
        type: 'trojan',
        password: ob.password || '',
        tls: !!tls.enabled,
        sni: tls.server_name || '',
        network: transport.type || 'tcp',
        wsPath: transport.path || '',
        wsHost: (transport.headers && transport.headers.Host) || '',
        skipCertVerify: !!tls.insecure,
      });
    case 'hysteria':
      return new Proxy({
        ...base,
        type: 'hysteria',
        auth: ob.auth_str || ob.auth || '',
        up: ob.up_mbps !== undefined ? String(ob.up_mbps) : '',
        down: ob.down_mbps !== undefined ? String(ob.down_mbps) : '',
        obfs: ob.obfs || '',
        sni: tls.server_name || '',
        alpn: Array.isArray(tls.alpn) ? tls.alpn.join(',') : '',
        skipCertVerify: !!tls.insecure,
      });
    case 'hysteria2':
      return new Proxy({
        ...base,
        type: 'hysteria2',
        password: ob.password || '',
        obfs: (ob.obfs && ob.obfs.type) || '',
        obfsPassword: (ob.obfs && ob.obfs.password) || '',
        sni: tls.server_name || '',
        alpn: Array.isArray(tls.alpn) ? tls.alpn.join(',') : '',
        skipCertVerify: !!tls.insecure,
      });
    case 'tuic':
      return new Proxy({
        ...base,
        type: 'tuic',
        uuid: ob.uuid || '',
        password: ob.password || '',
        alpn: Array.isArray(tls.alpn) ? tls.alpn.join(',') : 'h3',
        congestionControl: ob.congestion_control || '',
        udpRelayMode: ob.udp_relay_mode || '',
        sni: tls.server_name || '',
        skipCertVerify: !!tls.insecure,
      });
    default:
      return null;
  }
}

/** 通用 JSON 条目分发 */
function mapJsonEntry(item) {
  if (item && item.add) return mapVmessObject(item);
  if (item && item.type) return mapSingBoxOutbound(item);
  return null;
}

module.exports = { parse };
