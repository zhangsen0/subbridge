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
const { speedTestViaTunnel } = require('./tunnel');

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
 * @param {{timeoutMs?: number, speedTest?: boolean, speedTestUrl?: string, speedTestBytes?: number}} opts
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

  probe.latencyMs = await tcpProbe(node.server, node.port, opts.timeoutMs || 3000);
  if (probe.latencyMs === null) return node;
  probe.alive = true;

  // 真实下载测速：仅 http/socks5 节点可经代理隧道完成
  if (opts.speedTest && (node.type === 'http' || node.type === 'socks5') && opts.speedTestUrl) {
    try {
      probe.speedBps = await speedTestViaTunnel(
        node,
        opts.speedTestUrl,
        opts.speedTestBytes || 200000,
        opts.timeoutMs || 5000,
      );
    } catch {
      probe.speedBps = null;
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
