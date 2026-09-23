'use strict';

/**
 * 从节点池挑选抓取上游代理
 *
 * 需求："抓取外部节点时使用的代理也从节点池出；要支持所有代理类型"——
 * 未显式配置 fetcher.upstream_proxy 时，自动从节点池中挑选一个可用节点
 * 作为抓取上游（经它中转采集外部订阅）。
 *
 * 挑选策略（全部可配置）：
 *   - 仅从启用节点中选（停用节点不参与）
 *   - 类型白名单 fetcher.proxy_pool_types（默认 http / socks5 / socks4 / ss / trojan / vless）
 *   - 可用性优先（已测且 alive 排前）→ 延迟升序 → 更新时间新的优先
 *   - http/https 节点直接作为上游代理 URL；socks/ss/trojan/vless 通过协议桥
 *     （ProxyBridge）在本机生成 HTTP 上游；不支持的协议自动跳过并记录原因。
 */

const { startBridge, isSupportedProxyType, unsupportedReason } = require('./proxyBridge');
const net = require('node:net');
const dns = require('node:dns');

/**
 * 带超时的 DNS 解析：避免域名节点（如 fbi.gov）解析挂起导致选代理卡死。
 * @param {string} server 服务器地址
 * @param {number} timeoutMs 解析超时（毫秒）
 * @returns {Promise<string|null>} IP 地址；解析失败/超时返回 null
 */
function resolveHost(server, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, timeoutMs);
    dns.lookup(server, (err, addr) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(err ? null : addr);
    });
  });
}

/**
 * TCP 快速测速：测量到代理端口的建连延迟（毫秒），失败返回 null。
 * 纯 TCP 握手，不依赖具体代理协议；DNS 解析与 TCP 连接各带独立超时，
 * 任何阶段挂起都会在 timeoutMs 内返回，保证选代理流程不被卡死。
 * @param {string} server 代理服务器地址
 * @param {number} port 代理端口
 * @param {number} timeoutMs 超时（毫秒）
 * @returns {Promise<number|null>} 延迟毫秒；连接失败/超时返回 null
 */
async function tcpLatency(server, port, timeoutMs) {
  const host = /^\d+(\.\d+){3}$/.test(server) ? server : await resolveHost(server, timeoutMs);
  if (!host) return null;
  return new Promise((resolve) => {
    const start = Date.now();
    let done = false;
    const sock = net.connect({ host, port, timeout: timeoutMs });
    const finish = (val) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* 忽略 */ }
      resolve(val);
    };
    sock.once('connect', () => finish(Date.now() - start));
    sock.once('error', () => finish(null));
    sock.once('timeout', () => finish(null));
  });
}

/**
 * 从节点池挑选最优代理（先并发 TCP 预测速，过滤不可达/超延迟，取最快代理）
 * @param {object} nodePool 节点池实例
 * @param {{
 *   types?: string[], ttlMs?: number,
 *   skipLocalnode?: boolean,
 *   tcpProbe?: boolean, tcpProbeTimeoutMs?: number, tcpProbeConcurrency?: number, maxLatencyMs?: number,
 * }} opts 类型白名单、桥复用 TTL、TCP 测速参数
 * @returns {Promise<null|{url: string, node: object, skipped: string[]}>}
 *   返回上游代理 URL（http/https/socks/ss/trojan/vless 均可）、选中节点与跳过原因
 */
/**
 * 从节点池挑选多个可用抓取代理（一次并发建桥，供抓取任务复用）
 * @param {object} nodePool 节点池实例
 * @param {number} count 需要的代理数量
 * @param {object} opts 同 pickProxyFromPool 的选项
 * @returns {Promise<Array<{url: string, node: object}>>} 代理列表（可能少于 count）
 */
async function pickProxiesFromPool(nodePool, count = 1, {
  types, ttlMs, skipLocalnode = false,
  tcpProbe = true, tcpProbeTimeoutMs = 3000, tcpProbeConcurrency = 6, maxLatencyMs = 0,
  maxProbeNodes = 12,
} = {}) {
  if (!nodePool || !(Number(count) > 0)) return [];
  const wanted = Array.isArray(types) && types.length
    ? types.map((t) => String(t).toLowerCase()).filter(Boolean)
    : ['http', 'socks5', 'socks4', 'ss', 'trojan', 'vless'];
  const typeSet = new Set(wanted);
  const nodes = await nodePool.list();
  const candidates = nodes.filter(
    (n) =>
      typeSet.has(String(n.type || '').toLowerCase()) &&
      n.enabled !== false && n.server && n.port &&
      // 默认排除本机节点：本机节点出口=本机网络，抓境外源用它中转依然连不通
      !(skipLocalnode && n.source === 'localnode'),
  );
  if (!candidates.length) return [];

  // 先按已有探测数据排序：可用优先 → 延迟升序 → 更新时间新的优先（保证测速/建桥从最可能的节点开始）
  const probeOrder = (a, b) => {
    const pa = a.probe;
    const pb = b.probe;
    const aa = pa && pa.alive ? 1 : 0;
    const ab = pb && pb.alive ? 1 : 0;
    if (aa !== ab) return ab - aa;
    const la = pa && pa.latencyMs != null ? pa.latencyMs : Number.POSITIVE_INFINITY;
    const lb = pb && pb.latencyMs != null ? pb.latencyMs : Number.POSITIVE_INFINITY;
    if (la !== lb) return la - lb;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  };
  candidates.sort(probeOrder);

  // 第一层：TCP 快速测速（保证抓取代理的网速）——只测排序后前 N 个候选（池可能上万，全量测速会卡死）
  if (tcpProbe) {
    const concurrency = Math.max(1, Math.min(Number(tcpProbeConcurrency) || 6, 20));
    const timeoutMs = Math.max(500, Number(tcpProbeTimeoutMs) || 3000);
    const maxLatency = Number(maxLatencyMs) > 0 ? Number(maxLatencyMs) : 0;
    const probeSet = candidates.slice(0, Math.max(1, Math.min(Number(maxProbeNodes) || 12, candidates.length)));
    const measured = new Map();
    let idx = 0;
    async function worker() {
      while (idx < probeSet.length) {
        const node = probeSet[idx++];
        const lat = await tcpLatency(node.server, node.port, timeoutMs);
        measured.set(node, lat);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, probeSet.length) }, () => worker()));
    const alive = probeSet.filter((n) => {
      const lat = measured.get(n);
      return lat != null && (maxLatency === 0 || lat <= maxLatency);
    });
    if (alive.length) {
      alive.sort((a, b) => measured.get(a) - measured.get(b));
      candidates.length = 0;
      candidates.push(...alive);
    }
    // 前 N 个全不通时保留原排序继续建桥尝试（不再全池测速，避免卡死）
  }

  // 直连代理类型优先（http/https/socks5/socks4 无需协议桥，建桥零成本）；桥接类型（ss/trojan/vless/hysteria 等）靠后
  const directFirst = (a, b) => {
    const rank = (t) => (['http', 'https', 'socks5', 'socks4'].includes(String(t).toLowerCase()) ? 0 : 1);
    return rank(a.type) - rank(b.type);
  };
  const ordered = candidates.slice().sort(directFirst);
  const wantCount = Math.max(1, Math.min(Number(count) || 1, ordered.length));
  const results = [];
  const skipped = [];
  // 并发建桥前 wantCount 个：一次选出多个可用代理，避免串行建桥卡死
  await Promise.all(ordered.slice(0, wantCount).map(async (node) => {
    if (!isSupportedProxyType(node.type)) {
      skipped.push(`${node.type}://${node.server}:${node.port}（${unsupportedReason(node)}）`);
      return;
    }
    try {
      const bridge = await startBridge(node, { ttlMs });
      if (bridge && bridge.url) results.push({ url: bridge.url, node });
      else skipped.push(`${node.type}://${node.server}:${node.port}（${unsupportedReason(node)}）`);
    } catch (err) {
      skipped.push(`${node.type}://${node.server}:${node.port}（桥创建失败: ${err.message}）`);
    }
  }));
  // 失败不足时，继续并发尝试更多候选（直连类型优先顺序），最多两轮，避免串行建桥卡死
  if (results.length < wantCount && ordered.length > wantCount) {
    const rest = ordered.slice(wantCount).filter((n) => isSupportedProxyType(n.type));
    const batch = rest.slice(0, wantCount * 2);
    await Promise.all(batch.map(async (node) => {
      if (results.length >= wantCount) return;
      try {
        const bridge = await startBridge(node, { ttlMs });
        if (bridge && bridge.url) results.push({ url: bridge.url, node });
      } catch { /* 单个桥失败继续下一个 */ }
    }));
  }
  return results;
}

async function pickProxyFromPool(nodePool, {
  types, ttlMs, skipLocalnode = false,
  tcpProbe = true, tcpProbeTimeoutMs = 3000, tcpProbeConcurrency = 6, maxLatencyMs = 0,
  maxBridgeTry = 3, maxProbeNodes = 12,
} = {}) {
  // 兼容旧接口：最多试前 maxBridgeTry 个候选，返回第一个可用
  const picked = await pickProxiesFromPool(nodePool, maxBridgeTry, {
    types, ttlMs, skipLocalnode, tcpProbe, tcpProbeTimeoutMs, tcpProbeConcurrency, maxLatencyMs, maxProbeNodes,
  });
  if (picked.length) return { url: picked[0].url, node: picked[0].node, skipped: [] };
  return { url: null, node: null, skipped: [] };
}

module.exports = { pickProxyFromPool, pickProxiesFromPool, tcpLatency };
