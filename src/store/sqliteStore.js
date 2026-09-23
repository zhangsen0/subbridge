'use strict';

/**
 * SQLite 存储驱动（可选，storage.driver = "sqlite" 时启用）
 *
 * 基于 sql.js（纯 WASM，零原生编译），兼容任意 Node 版本与 Linux 发行版
 * （无需 gcc/python，彻底规避原生模块 glibc/ABI 兼容问题）。
 *
 * 数据落库：所有写操作先写入内存库，再防抖导出到 data/subbridge.sqlite；
 * 进程退出时同步冲刷，保证持久化。
 *
 * 与 FileStore 保持相同接口，切换驱动不影响任何业务代码：
 *   readConfig / writeConfig / listTemplates / readTemplate / writeTemplate /
 *   readDataFile / writeDataFile / cacheGet / cacheSet / cacheDelete / dataDir
 *
 * 表结构（单表 KV）：
 *   kv(key TEXT PRIMARY KEY, value TEXT)
 *     key 约定：config / template:<名> / file:<名>
 */

const fs = require('node:fs');
const path = require('node:path');

// 与 FileStore 相同的文件名安全校验
const SAFE_NAME_RE = /^[\w.-]+$/;
function safeName(name) {
  return typeof name === 'string' && SAFE_NAME_RE.test(name) && !name.startsWith('.') ? name : null;
}

// 惰性加载 sql.js（纯 JS + WASM，无原生依赖）
let SQL = null;
function loadDriver() {
  if (SQL) return SQL;
  try {
    SQL = require('sql.js');
  } catch (err) {
    throw new Error(`SQLite 驱动需要依赖 sql.js：请执行 npm install sql.js 后重试（${err.message}）`);
  }
  return SQL;
}

class SqliteStore {
  /**
   * @param {string} dataDir 数据目录绝对路径（sqlite 文件位于 dataDir/subbridge.sqlite）
   * @param {object} [SQLModule] 已初始化的 sql.js 模块（由工厂传入；缺省时异步初始化）
   */
  constructor(dataDir, SQLModule) {
    this.root = dataDir;
    this.dbPath = path.join(dataDir, 'subbridge.sqlite');
    fs.mkdirSync(dataDir, { recursive: true });
    this._flushTimer = null;
    this._dirty = false;
    // 内存缓存（与 FileStore 行为一致）
    this.cache = new Map();
    // sql.js 模块（异步初始化完成前，数据库为空对象占位，由 _ready 驱动）
    this._ready = null;
    if (SQLModule) {
      this._ready = Promise.resolve(this._init(SQLModule));
    } else {
      this._ready = loadDriver().then((m) => this._init(m));
    }
    // 进程退出时同步冲刷未落盘数据
    this._exitFlush = () => { try { this._flushSync(); } catch { /* 忽略退出期异常 */ } };
    process.on('exit', this._exitFlush);
  }

  /** 初始化内存数据库（从磁盘加载或新建） */
  _init(SQLModule) {
    this.db = fs.existsSync(this.dbPath)
      ? new SQLModule.Database(fs.readFileSync(this.dbPath))
      : new SQLModule.Database();
    this.db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    return this.db;
  }

  /* ---------- 持久化（防抖 + 退出冲刷） ---------- */

  /** 标记脏并安排一次防抖落盘 */
  _markDirty() {
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setImmediate(() => {
      this._flushTimer = null;
      this._flushSync();
    });
  }

  /** 同步导出内存库到磁盘文件 */
  _flushSync() {
    if (!this._dirty || !this.db) return;
    this._dirty = false;
    const data = Buffer.from(this.db.export());
    const tmp = this.dbPath + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.dbPath);
  }

  /** 数据目录路径 */
  dataDir() {
    return this.root;
  }

  /* ---------- KV 基础操作 ---------- */

  /** 读取 KV；不存在返回 null */
  async _get(key) {
    await this._ready;
    const stmt = this.db.prepare('SELECT value FROM kv WHERE key = ?');
    stmt.bind([key]);
    let value = null;
    if (stmt.step()) value = stmt.getAsObject().value;
    stmt.free();
    return value;
  }

  /** 写入/更新 KV */
  async _set(key, value) {
    await this._ready;
    const stmt = this.db.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    stmt.bind([key, String(value)]);
    stmt.step();
    stmt.free();
    this._markDirty();
  }

  /* ---------- 覆盖配置 ---------- */

  async readConfig() {
    return this._get('config');
  }

  async writeConfig(text) {
    await this._set('config', text);
  }

  /* ---------- 模板 ---------- */

  async listTemplates() {
    await this._ready;
    const stmt = this.db.prepare("SELECT key FROM kv WHERE key LIKE 'template:%'");
    const names = [];
    while (stmt.step()) names.push(stmt.getAsObject().key.slice('template:'.length));
    stmt.free();
    return names;
  }

  async readTemplate(name) {
    if (!safeName(name)) return null;
    return this._get('template:' + name);
  }

  async writeTemplate(name, content) {
    const safe = safeName(name);
    if (!safe) throw new Error(`非法模板名: ${name}`);
    await this._set('template:' + safe, content);
  }

  /* ---------- 生成文件 ---------- */

  async readDataFile(name) {
    const safe = safeName(name);
    if (!safe) return null;
    return this._get('file:' + safe);
  }

  async writeDataFile(name, content) {
    const safe = safeName(name);
    if (!safe) throw new Error(`非法文件名: ${name}`);
    await this._set('file:' + safe, content);
  }

  /* ---------- 缓存（进程内存实现） ---------- */

  cacheGet(key) {
    const item = this.cache.get(String(key));
    if (!item) return undefined;
    if (item.expireAt !== 0 && Date.now() > item.expireAt) {
      this.cache.delete(String(key));
      return undefined;
    }
    return item.value;
  }

  cacheSet(key, value, ttlSeconds) {
    const expireAt = Number(ttlSeconds) > 0 ? Date.now() + Number(ttlSeconds) * 1000 : 0;
    this.cache.set(String(key), { value, expireAt });
  }

  cacheDelete(key) {
    this.cache.delete(String(key));
  }
}

module.exports = { SqliteStore, safeName };
