'use strict';

/**
 * 节点可用性检测器
 *
 * 对统一节点模型做：
 *   1. TCP 连通性检测（所有协议通用）——记录延迟（毫秒）
 *   2. 真实下载测速（仅 http/socks5 节点，可通过代理隧道转发）——记录速度（字节/秒）
 *
 * 检测结果写入 node.probe：{ alive, latencyMs, speedBps, testedAt }
 * 并发数、超时、测速地址等全部可配置，禁止写死。
 */

const net = require('node:net');
const { speedTestViaTunnel, probeViaProxy, speedViaHttpProxy } = require('./tunnel');

/**
 * TCP 连通性检测
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs 超时（毫秒）
 * @returns {Promise<number|null>} 连接延迟（毫秒）；不可达返回 null
 */
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeoutMs || 3000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(Date.now() - start);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(null);
    });
  });
}

/**
 * 检测单个节点
 * @param {object} node 统一节点模型
 * @param {{timeoutMs?: number, speedTest?: boolean, speedTestUrl?: string, speedTestBytes?: number, proxyUrl?: string}} opts
 *   proxyUrl：上游代理地址（http/socks5）。配置后 TCP 探测改经代理 CONNECT 完成，
 *   适用于本机无法直连目标网络的环境（探测代理与抓取代理相互独立、均可配置）。
 * @returns {Promise<object>} 检测后的节点（node.probe 已写入）
 */
async function checkNode(node, opts) {
  const probe = {
    alive: false,
    latencyMs: null,
    speedBps: null,
    testedAt: new Date().toISOString(),
  };
  node.probe = probe;

  if (!node.server || !node.port) return node;

  // 配置了上游探测代理时经代理 CONNECT 探测，否则直连 TCP 探测
  probe.latencyMs = opts.proxyUrl
    ? await probeViaProxy(opts.proxyUrl, node.server, node.port, opts.timeoutMs || 3000)
    : await tcpProbe(node.server, node.port, opts.timeoutMs || 3000);
  if (probe.latencyMs === null) return node;
  probe.alive = true;

  // 真实下载测速（opts.speedTest 开启时）：
  // 所有支持协议统一经协议桥（http/socks5 直返、vless/trojan/ss/vmess 等建本地桥）
  // 请求测速地址并下载采样字节 —— 请求 2xx 且完成下载才算可用（TCP 通不代表协议可用）。
  if (opts.speedTest) {
    // 测速地址支持多候选轮换（speedTestUrls 数组优先，回退单地址）：首个可达的地址用于测速
    const urls = (Array.isArray(opts.speedTestUrls) && opts.speedTestUrls.length)
      ? opts.speedTestUrls.filter(Boolean)
      : (opts.speedTestUrl ? [opts.speedTestUrl] : []);
    if (urls.length) {
      try {
        // 兼容旧路径：http/socks5 直连隧道测速（无桥开销）
        if (node.type === 'http' || node.type === 'socks5') {
          for (const url of urls) {
            probe.speedBps = await speedTestViaTunnel(
              node,
              url,
              opts.speedTestBytes || 200000,
              opts.timeoutMs || 5000,
            );
            if (probe.speedBps != null) break;
          }
          if (probe.speedBps == null) probe.alive = false;
        } else {
          // 桥接协议：经协议桥转 http 上游后真实请求测速
          const { startBridge, isSupportedProxyType } = require('../core/proxyBridge');
          if (!isSupportedProxyType(node.type)) {
            probe.alive = false;
          } else {
            const bridge = await startBridge(node, { ttlMs: opts.bridgeTtlMs || 60000 });
            if (bridge && bridge.url) {
              for (const url of urls) {
                const speed = await speedViaHttpProxy(
                  bridge.url,
                  url,
                  opts.speedTestBytes || 200000,
                  opts.timeoutMs || 5000,
                );
                if (speed != null) {
                  probe.alive = true;
                  probe.speedBps = speed;
                  break;
                }
              }
              if (probe.speedBps == null) {
                // 所有测速地址均失败 → 真实代理请求失败，判定不可用（即使 TCP 通）
                probe.alive = false;
              }
            } else {
              probe.alive = false;
            }
          }
        }
      } catch {
        probe.alive = false;
      }
    }
  }
  return node;
}

/**
 * 并发检测一批节点
 * @param {Array} nodes
 * @param {{concurrency?: number, timeoutMs?: number, speedTest?: boolean, speedTestUrl?: string, speedTestBytes?: number}} opts
 * @returns {Promise<Array>} 检测后的节点列表（顺序与原列表一致）
 */
async function runChecks(nodes, opts) {
  const out = new Array(nodes.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < nodes.length) {
      const idx = cursor++;
      out[idx] = await checkNode(nodes[idx], opts);
    }
  };

  const concurrency = Math.max(1, Math.min(Number(opts.concurrency) || 10, nodes.length));
  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

module.exports = { tcpProbe, checkNode, runChecks };
