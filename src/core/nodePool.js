'use strict';

/**
 * 节点池：持久化的节点资产库
 *
 * 设计要点（对应需求）：
 *   - 每次抓取把节点"补充/更新"进池，按 类型+服务器+端口 去重（upsert）
 *   - 节点不自动删除：即使可用性检测不可达，也只更新状态标记，保留在池中
 *   - 节点可手动开关（enabled）：停用节点保留在池中但不参与订阅输出
 *   - 手动删除 / 清空由用户显式操作（前台按钮）
 *   - 经存储层 readDataFile/writeDataFile 持久化，可随备份迁移
 *
 * 池文件为 JSON 对象：{ "<type>:<server>:<port>": {node字段..., firstSeen, updatedAt, source, probe} }
 */

const POOL_FILE = 'nodes.json';

/** 池内节点去重键 */
function nodeKey(node) {
  return `${node.type}:${node.server}:${node.port}`;
}

/** 兼容旧数据：ws 类型节点缺少 wsHost 时，从 raw 链接补全（早期版本未存该字段，缺了会导致
 *  Clash 转换时 ws-opts Host 头为空、节点全部无法连接） */
function backfillWsHost(n) {
  if (!n || n.wsHost || !n.raw || (n.network !== 'ws' && n.network !== 'grpc')) return n;
  try {
    if (/^[a-z]+:\/\//i.test(n.raw)) {
      const u = new URL(n.raw);
      n.wsHost = u.searchParams.get('host') || '';
    }
  } catch { /* 非标准 URL 跳过 */ }
  return n;
}

class NodePool {
  /**
   * @param {object} store 存储层实例（含 readDataFile / writeDataFile）
   */
  constructor(store) {
    this.store = store;
    this.cache = null;
  }

  /** 加载池（内存缓存，避免每次读盘） */
  async load() {
    if (this.cache) return this.cache;
    let raw = null;
    try {
      raw = await this.store.readDataFile(POOL_FILE);
    } catch {
      raw = null;
    }
    let data = {};
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = {};
      }
    }
    // 旧数据字段补全（wsHost 等），修复历史节点无法连接
    for (const key of Object.keys(data)) backfillWsHost(data[key]);
    this.cache = data;
    return data;
  }

  /** 写盘并更新内存缓存 */
  async save(data) {
    this.cache = data;
    await this.store.writeDataFile(POOL_FILE, JSON.stringify(data));
  }

  /** 重新从磁盘加载（数据被外部写入后调用，如备份导入） */
  async reload() {
    this.cache = null;
    return this.load();
  }

  /**
   * 批量补充/更新节点（upsert，不删除任何既有节点）
   * @param {Array} nodes 统一节点模型数组
   * @param {{source?: string, defaultEnabled?: boolean}} opts
   *   source 来源描述（订阅地址 / 文本 / 网页）
   *   defaultEnabled 新节点默认启用状态（未传时按节点自身 enabled，再缺省为 true）
   * @returns {Promise<{added: number, updated: number}>}
   */
  async upsert(nodes, { source = '', defaultEnabled = true } = {}) {
    const pool = await this.load();
    const now = new Date().toISOString();
    let added = 0;
    let updated = 0;
    for (const n of nodes || []) {
      if (!n || !n.server) continue;
      const key = nodeKey(n);
      const existing = pool[key];
      // 提取可展示/可重建的字段（不存内部方法）
      const entry = {
        name: n.name,
        type: n.type,
        server: n.server,
        port: n.port,
        username: n.username || '',
        password: n.password || '',
        tls: !!n.tls,
        sni: n.sni || '',
        udp: !!n.udp,
        ...(n.path ? { path: n.path } : {}),
        ...(n.cipher ? { cipher: n.cipher } : {}),
        ...(n.uuid ? { uuid: n.uuid } : {}),
        ...(n.alterId != null ? { alterId: n.alterId } : {}),
        ...(n.flow ? { flow: n.flow } : {}),
        ...(n.auth ? { auth: n.auth } : {}),
        ...(n.insecure ? { insecure: n.insecure } : {}),
        ...(n.alpn ? { alpn: n.alpn } : {}),
        ...(n.fingerprint ? { fingerprint: n.fingerprint } : {}),
        ...(n.network ? { network: n.network } : {}),
        ...(n.wsPath ? { wsPath: n.wsPath } : {}),
        ...(n.wsHeaders ? { wsHeaders: n.wsHeaders } : {}),
        ...(n.realityPublicKey ? { realityPublicKey: n.realityPublicKey } : {}),
        ...(n.realityShortId ? { realityShortId: n.realityShortId } : {}),
        ...(n.hops ? { hops: n.hops } : {}),
        ...(n.password2 ? { password2: n.password2 } : {}),
        ...(n.obfs ? { obfs: n.obfs } : {}),
        ...(n.obfsParam ? { obfsParam: n.obfsParam } : {}),
        ...(n.protocol ? { protocol: n.protocol } : {}),
        ...(n.protocolParam ? { protocolParam: n.protocolParam } : {}),
        ...(n.group ? { group: n.group } : {}),
        ...(n.probe ? { probe: n.probe } : {}),
        // 原始分享链接（links / v2ray 目标输出依赖；解析时可重建则保留）
        ...(n.raw ? { raw: n.raw } : {}),
        // 启用开关：新节点默认启用（可配置 pool.default_enabled），停用节点不参与订阅输出
        enabled: existing ? !!existing.enabled : n.enabled !== undefined ? !!n.enabled : !!defaultEnabled,
        source: n.source || source || existing?.source || '',
        firstSeen: existing?.firstSeen || now,
        updatedAt: now,
      };
      if (!existing) added += 1;
      else updated += 1;
      pool[key] = entry;
    }
    await this.save(pool);
    return { added, updated };
  }

  /** 更新指定节点的检测结果（写入 probe 字段） */
  async updateProbe(probeMap) {
    const pool = await this.load();
    for (const [key, probe] of Object.entries(probeMap || {})) {
      if (pool[key]) {
        pool[key].probe = probe;
        pool[key].updatedAt = new Date().toISOString();
      }
    }
    await this.save(pool);
  }

  /**
   * 开关节点（启用/停用）。停用节点保留在池中，但不参与订阅输出。
   * @param {string} key 节点键（type:server:port）
   * @param {boolean} enabled 目标状态
   * @returns {Promise<boolean>} 是否找到并更新
   */
  async toggle(key, enabled) {
    const pool = await this.load();
    if (!pool[key]) return false;
    pool[key].enabled = !!enabled;
    pool[key].updatedAt = new Date().toISOString();
    await this.save(pool);
    return true;
  }

  /**
   * 批量设置启用状态（质量门槛自动开关用）
   * @param {Array<[string, boolean]>} entries [[key, enabled], ...]
   * @returns {Promise<number>} 实际更新的节点数
   */
  async bulkSetEnabled(entries) {
    const pool = await this.load();
    const now = new Date().toISOString();
    let changed = 0;
    for (const [key, enabled] of entries || []) {
      if (!pool[key]) continue;
      if (!!pool[key].enabled !== !!enabled) {
        pool[key].enabled = !!enabled;
        pool[key].updatedAt = now;
        changed += 1;
      }
    }
    if (changed) await this.save(pool);
    return changed;
  }

  /** 全部节点（按最近更新时间倒序；enabled 过滤可选） */
  async list({ enabled } = {}) {
    const pool = await this.load();
    let arr = Object.values(pool);
    if (enabled === true) arr = arr.filter((n) => n.enabled !== false);
    if (enabled === false) arr = arr.filter((n) => n.enabled === false);
    return arr.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  /**
   * 手动删除指定节点（仅删除用户点名的键，不做自动清理）
   * @param {string[]} keys 节点键列表
   * @returns {number} 实际删除数量
   */
  async remove(keys) {
    const pool = await this.load();
    let removed = 0;
    for (const k of keys || []) {
      if (pool[k]) {
        delete pool[k];
        removed += 1;
      }
    }
    if (removed) await this.save(pool);
    return removed;
  }

  /** 清空整个节点池（显式操作，谨慎使用） */
  async clear() {
    await this.save({});
  }
}

module.exports = { NodePool, nodeKey };
