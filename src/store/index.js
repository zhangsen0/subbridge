'use strict';

/**
 * 存储层工厂
 *
 * 按 storage.driver 选择驱动实例，当前内置：
 *   - file：文件存储（默认，零依赖）
 * 后续新增驱动（postgres/mysql 等）只需在 DRIVERS 注册并实现相同接口：
 *   readConfig / writeConfig / listTemplates / readTemplate / writeTemplate /
 *   readDataFile / writeDataFile / cacheGet / cacheSet / cacheDelete / dataDir
 */

const { FileStore } = require('./fileStore');
const { SqliteStore } = require('./sqliteStore');

// 驱动注册表：驱动名 -> 构造函数（file 零依赖默认；sqlite 可选）
const DRIVERS = {
  file: FileStore,
  sqlite: SqliteStore,
};

/**
 * 创建存储实例（同步版，仅用于 file 驱动）
 * @param {object} config 完整配置（读取 storage.driver）
 * @param {string} dataDir 数据目录（file 驱动使用）
 * @returns {object} 存储实例
 */
function createStore(config, dataDir) {
  const driver = (config.storage && config.storage.driver) || 'file';
  const Cls = DRIVERS[driver];
  if (!Cls) {
    throw new Error(`不支持的存储驱动: ${driver}（当前可用: ${Object.keys(DRIVERS).join(' / ')}）`);
  }
  if (driver !== 'file') {
    throw new Error(`驱动 ${driver} 需要异步初始化，请使用 createStoreAsync()`);
  }
  return new Cls(dataDir);
}

/**
 * 创建存储实例（异步版，sqlite 等需要异步初始化 WASM 的驱动使用）
 * @param {object} config 完整配置（读取 storage.driver）
 * @param {string} dataDir 数据目录
 * @returns {Promise<object>} 存储实例
 */
async function createStoreAsync(config, dataDir) {
  const driver = (config.storage && config.storage.driver) || 'file';
  const Cls = DRIVERS[driver];
  if (!Cls) {
    throw new Error(`不支持的存储驱动: ${driver}（当前可用: ${Object.keys(DRIVERS).join(' / ')}）`);
  }
  if (driver === 'file') return new Cls(dataDir);
  // sqlite（sql.js WASM）异步初始化
  const initSqlJs = require('sql.js');
  const SQLModule = await initSqlJs();
  return new Cls(dataDir, SQLModule);
}

module.exports = { createStore, createStoreAsync, DRIVERS };
