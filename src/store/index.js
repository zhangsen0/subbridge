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

// 驱动注册表：驱动名 -> 构造函数
const DRIVERS = {
  file: FileStore,
};

/**
 * 创建存储实例
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
  return new Cls(dataDir);
}

module.exports = { createStore, DRIVERS };
