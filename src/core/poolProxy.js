'use strict';

/**
 * 从节点池挑选抓取上游代理
 *
 * 需求："抓取外部节点时使用的代理也从节点池出"——
 * 未显式配置 fetcher.upstream_proxy 时，自动从节点池中挑选一个
 * 可用的 http 代理节点作为抓取上游（经它中转采集外部订阅）。
 *
 * 挑选策略（全部可配置）：
 *   - 仅从启用节点中选（停用节点不参与）
 *   - 类型白名单 fetcher.proxy_pool_types（默认 http）
 *   - 可用性优先（已测且 alive 排前）→ 延迟升序 → 更新时间新的优先
 */

/**
 * 从节点池挑选最优代理
 * @param {object} nodePool 节点池实例
 * @param {{types?: string[]}} opts 类型白名单（默认 ['http']）
 * @returns {Promise<null|{url: string, node: object}>} 上游代理 URL（含认证）与选中节点
 */
async function pickProxyFromPool(nodePool, { types = ['http'] } = {}) {
  if (!nodePool) return null;
  const typeSet = new Set((types || []).filter(Boolean));
  const nodes = await nodePool.list();
  const candidates = nodes.filter(
    (n) => typeSet.has(n.type) && n.enabled !== false && n.server && n.port,
  );
  if (!candidates.length) return null;

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

  const node = candidates[0];
  const auth =
    node.username && node.password
      ? `${encodeURIComponent(node.username)}:${encodeURIComponent(node.password)}@`
      : '';
  return { url: `${node.type}://${auth}${node.server}:${node.port}`, node };
}

module.exports = { pickProxyFromPool };
