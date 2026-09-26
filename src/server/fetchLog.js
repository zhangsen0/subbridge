'use strict';

/**
 * 事件日志（内存环形缓冲 + 可选持久化）
 *
 * 记录全站所有"可检测数据"的操作轨迹，按类型分类：
 *   fetch   抓取（含网页递归发现的子链接）：来源、状态、字节、节点数、耗时、错误
 *   probe   测速/可用性检测：检测节点数、存活数、平均延迟
 *   pool    节点池变更：入库/更新/删除/清空
 *   config  配置与数据变更：更新配置、备份、恢复
 *   system  系统操作：本机节点/隧道重启等
 *
 * 容量可配置（fetch_log.capacity），超限自动丢弃最旧记录。
 *
 * 持久化（fetch_log.persist 默认开启）：经存储层落盘，重启后仍可查到历史轨迹；
 * 写入按 fetch_log.flush_interval_ms 节流合并，避免高频写拖慢抓取主流程。
 * 注意：存储驱动为 sqlite 时落在 data/subbridge.sqlite 的 kv 表，不会生成独立文件。
 */

const DEFAULT_LOG_FILE = 'fetch-log.json';
const DEFAULT_FLUSH_MS = 2000;

class FetchLog {
  /**
   * @param {number} capacity 最大保留条数
   * @param {object} [opts] 持久化选项
   *   {object} [store] 存储实例（提供 readDataFile / writeDataFile）
   *   {string} [file] 持久化文件名
   *   {boolean} [persist] false 关闭持久化（退化为纯内存）
   *   {number} [flushIntervalMs] 写入节流间隔（毫秒）
   */
  constructor(capacity = 500, opts = {}) {
    this.capacity = Math.max(1, Number(capacity) || 500);
    this.items = [];
    this.seq = 0;
    this._store = opts.store || null;
    this._file = String(opts.file || DEFAULT_LOG_FILE).trim() || DEFAULT_LOG_FILE;
    this._persist = opts.persist !== false;
    this._flushMs = Math.max(0, Number(opts.flushIntervalMs) || DEFAULT_FLUSH_MS);
    this._flushTimer = null;
    // 启动即异步恢复历史日志；恢复期间新写入的条目会排在其后，不会被覆盖
    this._ready = this._canPersist() ? this._load().catch(() => {}) : Promise.resolve();
  }

  /** 是否可以落盘（开启持久化且存储可用） */
  _canPersist() {
    return this._persist && !!this._store && typeof this._store.readDataFile === 'function';
  }

  /** 等待历史日志恢复完成（测试 / 启动收尾使用） */
  ready() {
    return this._ready;
  }

  /** 从存储恢复历史日志（保留当前进程已写入的条目，并重新编号避免 id 冲突） */
  async _load() {
    const raw = await this._store.readDataFile(this._file);
    if (!raw) return;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // 内容损坏不阻塞启动
    }
    const saved = Array.isArray(parsed && parsed.items) ? parsed.items.filter((i) => i && typeof i === 'object') : [];
    const pending = this.items.slice();
    this.items = [];
    this.seq = 0;
    for (const item of saved) {
      this.items.push(Object.assign(this._defaults(), item));
      this.seq = Math.max(this.seq, Number(item.id) || 0);
    }
    for (const item of pending) {
      item.id = ++this.seq;
      this.items.push(item);
    }
    this._trim();
  }

  /** 日志默认字段（恢复旧数据时补全缺失字段，保证前台渲染不报错） */
  _defaults() {
    return {
      id: 0,
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
    };
  }

  /** 按容量裁剪（丢弃最旧） */
  _trim() {
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  /**
   * 写入一条事件日志
   * @param {object} entry 日志字段（type/url/kind/httpStatus/bytes/nodes/durationMs/error/via 等）
   * @returns {object} 带 id 与 ts 的完整记录
   */
  record(entry) {
    const item = Object.assign(this._defaults(), { id: ++this.seq }, entry);
    this.items.push(item);
    this._trim();
    this._scheduleFlush();
    return item;
  }

  /** 排程一次落盘（多条合并，节流可配） */
  _scheduleFlush() {
    if (!this._canPersist()) return;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flush().catch(() => {});
    }, this._flushMs);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  /** 立即落盘（服务关闭 / 备份前调用，确保数据不丢） */
  async flush() {
    if (!this._canPersist()) return;
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    await this._flush();
  }

  /** 落盘实现：整体覆盖写入（容量有限，避免增量合并的复杂度） */
  async _flush() {
    const payload = JSON.stringify({ updatedAt: new Date().toISOString(), capacity: this.capacity, items: this.items });
    await this._store.writeDataFile(this._file, payload);
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

  /** 清空全部日志（同时清空持久化内容） */
  clear() {
    this.items = [];
    this.seq = 0;
    this._scheduleFlush();
  }
}

module.exports = { FetchLog, DEFAULT_LOG_FILE };
