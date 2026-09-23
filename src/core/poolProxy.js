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

/**
 * 从节点池挑选最优代理（逐候选尝试建立桥，取第一个可用）
 * @param {object} nodePool 节点池实例
 * @param {{types?: string[], ttlMs?: number}} opts 类型白名单与桥复用 TTL
 * @returns {Promise<null|{url: string, node: object, skipped: string[]}>}
 *   返回上游代理 URL（http/https/socks/ss/trojan/vless 均可）、选中节点与跳过原因
 */
async function pickProxyFromPool(nodePool, { types, ttlMs } = {}) {
  if (!nodePool) return { url: null, node: null, skipped: [] };
  const wanted = Array.isArray(types) && types.length
    ? types.map((t) => String(t).toLowerCase()).filter(Boolean)
    : ['http', 'socks5', 'socks4', 'ss', 'trojan', 'vless'];
  const typeSet = new Set(wanted);
  const nodes = await nodePool.list();
  const candidates = nodes.filter(
    (n) => typeSet.has(String(n.type || '').toLowerCase()) && n.enabled !== false && n.server && n.port,
  );
  if (!candidates.length) return { url: null, node: null, skipped: [] };

  candidates.sort((a, b) => {
    const pa = a.probe;
    const pb = b.probe;
    const aa = pa && pa.alive ? 1 : 0;
    const ab = pb && pb.alive ? 1 : 0;
    if (aa !== ab) return ab - aa;
    const la = pa && pa.latencyMs != null ? pa.latencyMs : Number.POSITIVE_INFINITY;
    const lb = pb && pb.latencyMs != null ? pb.latencyMs : Number.POSITIVE_INFINITY;
    if (la !== lb) return la - lb;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });

  const skipped = [];
  for (const node of candidates) {
    if (!isSupportedProxyType(node.type)) {
      skipped.push(`${node.type}://${node.server}:${node.port}（${unsupportedReason(node)}）`);
      continue;
    }
    try {
      const bridge = await startBridge(node, { ttlMs });
      if (bridge && bridge.url) {
        return { url: bridge.url, node, skipped };
      }
      skipped.push(`${node.type}://${node.server}:${node.port}（${unsupportedReason(node)}）`);
    } catch (err) {
      skipped.push(`${node.type}://${node.server}:${node.port}（桥创建失败: ${err.message}）`);
    }
  }
  return { url: null, node: null, skipped };
}

module.exports = { pickProxyFromPool };
