'use strict';

/**
 * SQLite 存储驱动（可选，storage.driver = "sqlite" 时启用）
 *
 * 依赖 better-sqlite3（optionalDependencies）：
 *   - 已安装：按 sqlite 驱动工作，数据落库到 data/subbridge.sqlite
 *   - 未安装：构造时抛出错误，存储工厂自动回退 file 驱动并提示
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

// 惰性加载 better-sqlite3（未安装时抛错由工厂处理）
let Database = null;
function loadDriver() {
  if (Database) return Database;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    throw new Error(
      `SQLite 驱动需要依赖 better-sqlite3：请执行 npm install better-sqlite3 后重试（${err.message}）`
    );
  }
  return Database;
}

class SqliteStore {
  /**
   * @param {string} dataDir 数据目录绝对路径（sqlite 文件位于 dataDir/subbridge.sqlite）
   */
  constructor(dataDir) {
    const DB = loadDriver();
    this.root = dataDir;
    this.dbPath = path.join(dataDir, 'subbridge.sqlite');
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DB(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
    );
    // 内存缓存（与 FileStore 行为一致）
    this.cache = new Map();
  }

  /** 数据目录路径 */
  dataDir() {
    return this.root;
  }

  /* ---------- KV 基础操作 ---------- */

  /** 读取 KV；不存在返回 null */
  _get(key) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  /** 写入/更新 KV */
  _set(key, value) {
    this.db
      .prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, String(value));
  }

  /* ---------- 覆盖配置 ---------- */

  async readConfig() {
    return this._get('config');
  }

  async writeConfig(text) {
    this._set('config', text);
  }

  /* ---------- 模板 ---------- */

  async listTemplates() {
    const rows = this.db.prepare("SELECT key FROM kv WHERE key LIKE 'template:%'").all();
    return rows.map((r) => r.key.slice('template:'.length));
  }

  async readTemplate(name) {
    if (!safeName(name)) return null;
    return this._get('template:' + name);
  }

  async writeTemplate(name, content) {
    const safe = safeName(name);
    if (!safe) throw new Error(`非法模板名: ${name}`);
    this._set('template:' + safe, content);
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
    this._set('file:' + safe, content);
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
