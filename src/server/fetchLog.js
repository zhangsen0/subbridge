'use strict';

/**
 * 事件日志（内存环形缓冲）
 *
 * 记录全站所有"可检测数据"的操作轨迹，按类型分类：
 *   fetch   抓取（含网页递归发现的子链接）：来源、状态、字节、节点数、耗时、错误
 *   probe   测速/可用性检测：检测节点数、存活数、平均延迟
 *   pool    节点池变更：入库/更新/删除/清空
 *   config  配置与数据变更：更新配置、备份、恢复
 *   system  系统操作：本机节点/隧道重启等
 *
 * 容量可配置（fetch_log.capacity），超限自动丢弃最旧记录。
 */

class FetchLog {
  /**
   * @param {number} capacity 最大保留条数
   */
  constructor(capacity = 500) {
    this.capacity = Math.max(1, Number(capacity) || 500);
    this.items = [];
    this.seq = 0;
  }

  /**
   * 写入一条事件日志
   * @param {object} entry 日志字段（type/url/kind/httpStatus/bytes/nodes/durationMs/error/via 等）
   * @returns {object} 带 id 与 ts 的完整记录
   */
  record(entry) {
    const item = {
      id: ++this.seq,
      ts: new Date().toISOString(),
      type: 'fetch',
      url: '',
      kind: '',
      httpStatus: null,
      bytes: null,
      nodes: 0,
      durationMs: 0,
      error: '',
      via: '',
      ...entry,
    };
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
    return item;
  }

  /**
   * 按条件过滤日志（不分页，最新在前；供分页查询使用）
   * @param {{ok?: boolean, type?: string}} opts
   * @returns {Array}
   */
  query({ ok, type } = {}) {
    let arr = this.items.slice().reverse();
    if (ok === true) arr = arr.filter((i) => !i.error);
    if (ok === false) arr = arr.filter((i) => !!i.error);
    if (type) arr = arr.filter((i) => i.type === type);
    return arr;
  }

  /**
   * 读取日志（最新在前）
   * @param {{limit?: number, ok?: boolean, type?: string}} opts
   *   limit 条数上限；ok=true 仅成功、ok=false 仅失败；type 按事件类型过滤
   * @returns {Array}
   */
  list({ limit = 100, ok, type } = {}) {
    let arr = this.items.slice().reverse();
    if (ok === true) arr = arr.filter((i) => !i.error);
    if (ok === false) arr = arr.filter((i) => !!i.error);
    if (type) arr = arr.filter((i) => i.type === type);
    return arr.slice(0, Math.max(1, Number(limit) || 100));
  }

  /** 清空全部日志 */
  clear() {
    this.items = [];
  }
}

module.exports = { FetchLog };
