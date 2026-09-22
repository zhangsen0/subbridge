'use strict';

/**
 * vpngate.net 站点适配器
 *
 * vpngate 没有标准订阅格式：其 /api/iphone/ 接口返回 OpenVPN 服务器批量列表
 * （每行逗号分隔，末列为 OpenVPN 配置文件 base64）。
 * 本适配器把任意 vpngate 页面地址归一化到该 API，并解析为 type=openvpn 的节点：
 *   可入库节点池、可 TCP 测速、可在节点库导出 .ovpn 直接导入 OpenVPN 客户端；
 *   OpenVPN 协议无法转换为 Clash/sing-box 节点，转换输出时会自动跳过并提示。
 */

const HOST_PATTERN = /(^|\.)vpngate\.net$/i;
const API_PATH = '/api/iphone/';

/** 判断域名是否属于 vpngate */
function matches(hostname) {
  return HOST_PATTERN.test(String(hostname || '').trim());
}

/** 把任意 vpngate 页面地址归一化为批量 API 地址（已是 API 地址则保持） */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (u.pathname.startsWith(API_PATH)) return url;
    u.pathname = API_PATH;
    u.search = '';
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * 解析 vpngate 批量列表文本
 * 字段顺序（逗号分隔 15 列）：
 *   HostName, IP, Score, Ping, Speed, CountryLong, CountryShort, NumVpnSessions,
 *   Uptime, TotalUsers, TotalTraffic, LogType, Operator, Message, OpenVPN_ConfigData_Base64
 * @param {string} content API 返回文本
 * @returns {{nodes: Array, format: string}}
 */
function parse(content) {
  const lines = String(content || '').split(/\r?\n/);
  const nodes = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('*')) continue; // 跳过注释行
    const parts = t.split(',');
    if (parts.length < 15) continue;
    const [hostname, ip, score, ping, speed, countryLong, countryShort] = parts;
    if (!ip || !/^[\d.]+$/.test(ip)) continue; // 仅保留有效 IPv4
    nodes.push({
      name: `${countryShort || '?'}-${hostname}`,
      type: 'openvpn',
      server: ip,
      port: 1194,
      hostname,
      country: countryLong || '',
      countryCode: countryShort || '',
      score: Number(score) || 0,
      ping: Number(ping) || 0,
      speed: Number(speed) || 0,
      configBase64: parts[14] || '',
      udp: false,
    });
  }
  return { nodes, format: 'vpngate' };
}

module.exports = { matches, normalizeUrl, parse };
