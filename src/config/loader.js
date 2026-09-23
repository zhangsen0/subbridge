'use strict';

/**
 * 配置加载器
 *
 * 配置优先级（低 -> 高）：
 *   1. 内置默认配置（src/config/defaults.yaml）
 *   2. 运行时覆盖配置（data/config.yaml，由 Web 前台写入）
 *   3. 环境变量（PORT / HOST / SUBBRIDGE_* 等）
 *
 * 该模块是全局配置的唯一权威来源（single source of truth），
 * 其他模块通过 getConfig() 读取，通过 updateConfig() 修改。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const yaml = require('js-yaml');
const { createStore } = require('../store');

const DEFAULT_CONFIG_PATH = path.join(__dirname, 'defaults.yaml');

// 配置状态（模块级单例）
const state = {
  config: null,          // 生效中的完整配置
  overlay: {},           // 运行时覆盖层（data/config.yaml 内容，updateConfig 累积更新）
  dataDir: 'data',       // 运行时数据目录（相对项目根目录）
  store: null,           // 存储实例（按 storage.driver 创建）
};

/**
 * 环境变量 -> 配置路径 映射表
 * 每一项：[环境变量名, 配置点路径(点号分隔), 可选值转换函数]
 */
const ENV_MAP = [
  ['PORT', 'server.port', (v) => parseInt(v, 10)],
  ['HOST', 'server.host'],
  ['SUBBRIDGE_UPSTREAM_PROXY', 'fetcher.upstream_proxy'],
  ['SUBBRIDGE_API_TOKEN', 'security.api_token'],
  ['SUBBRIDGE_USER_TOKEN', 'security.user_token'],
  ['SUBBRIDGE_ADMIN_USERNAME', 'security.admin_username'],
  ['SUBBRIDGE_ADMIN_PASSWORD', 'security.admin_password'],
  ['SUBBRIDGE_USER_USERNAME', 'security.user_username'],
  ['SUBBRIDGE_USER_PASSWORD', 'security.user_password'],
  ['SUBBRIDGE_TIMEOUT_SECONDS', 'fetcher.timeout_seconds', (v) => parseInt(v, 10)],
  ['SUBBRIDGE_USER_AGENT', 'fetcher.user_agent'],
  ['SUBBRIDGE_DEFAULT_TARGET', 'converter.default_target'],
  ['SUBBRIDGE_LOG_LEVEL', 'logging.level'],
  ['SUBBRIDGE_BLOCK_PRIVATE', 'fetcher.block_private', (v) => v === 'true' || v === '1'],
  ['SUBBRIDGE_LOCALNODE_MODE', 'localnode.mode'],
  ['SUBBRIDGE_LOCALNODE_ENABLED', 'localnode.enabled', (v) => v === 'true' || v === '1'],
  ['SUBBRIDGE_LOCALNODE_HTTP_PORT', 'localnode.http_port', (v) => parseInt(v, 10)],
  ['SUBBRIDGE_LOCALNODE_SOCKS_PORT', 'localnode.socks_port', (v) => parseInt(v, 10)],
  ['SUBBRIDGE_LOCALNODE_USERNAME', 'localnode.username'],
  ['SUBBRIDGE_LOCALNODE_PASSWORD', 'localnode.password'],
  ['SUBBRIDGE_LOCALNODE_PUBLIC_ADDRESS', 'localnode.public_address'],
  ['SUBBRIDGE_CF_TUNNEL_ENABLED', 'cf_tunnel.enabled', (v) => v === 'true' || v === '1'],
  ['SUBBRIDGE_CF_TUNNEL_TOKEN', 'cf_tunnel.token'],
  ['SUBBRIDGE_CF_TUNNEL_HOSTNAME', 'cf_tunnel.hostname'],
  ['SUBBRIDGE_CF_TUNNEL_BINARY', 'cf_tunnel.binary'],
  ['SUBBRIDGE_PROBE_ENABLED', 'probe.enabled', (v) => v === 'true' || v === '1'],
  ['SUBBRIDGE_PROBE_TIMEOUT_MS', 'probe.timeout_ms', (v) => parseInt(v, 10)],
  ['SUBBRIDGE_RELAY_LOCALNODE', 'fetcher.relay_through_localnode', (v) => v === 'true' || v === '1'],
  ['SUBBRIDGE_STORAGE_DRIVER', 'storage.driver'],
];

// 允许前台修改的配置顶层键（防止写入脏数据）
const ALLOWED_TOP_KEYS = new Set(['server', 'fetcher', 'converter', 'security', 'logging', 'localnode', 'cf_tunnel', 'probe', 'subscription', 'storage', 'pool', 'grab', 'fetch_log', 'ui', 'presets']);

/** 深合并：对象递归合并，数组与基本类型直接覆盖 */
function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base === 'object' && typeof override === 'object') {
    const result = { ...base };
    for (const key of Object.keys(override)) {
      result[key] = deepMerge(base[key], override[key]);
    }
    return result;
  }
  return override;
}

/** 按点号路径读取配置值 */
function getByPath(obj, dottedPath) {
  let cur = obj;
  for (const part of dottedPath.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/** 按点号路径写入配置值 */
function setByPath(obj, dottedPath, value) {
  const parts = dottedPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {};
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
}

/** 应用环境变量覆盖 */
function applyEnv(config) {
  for (const [envName, configPath, transform] of ENV_MAP) {
    const raw = process.env[envName];
    if (raw === undefined || raw === '') continue;
    const value = transform ? transform(raw) : raw;
    if (value !== undefined && !Number.isNaN(value)) {
      setByPath(config, configPath, value);
    }
  }
  return config;
}

/** 读取 YAML 文件，文件不存在时返回 null */
async function readYaml(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return yaml.load(text) || {};
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 加载配置（应用启动时调用一次）
 * 存储层引导：先用「环境变量或默认驱动 + 数据目录」创建引导存储读取覆盖配置，
 * 配置组装完成后按最终 storage.driver 重建存储实例。
 * @returns {Promise<object>} 生效中的完整配置
 */
async function loadConfig() {
  // 1. 内置默认配置
  const defaults = (await readYaml(DEFAULT_CONFIG_PATH)) || {};

  // 2. 运行时覆盖配置（经存储层读取）
  const envDataDir = process.env.SUBBRIDGE_DATA_DIR;
  state.dataDir = envDataDir || path.join(process.cwd(), 'data');
  const bootstrapDriver = process.env.SUBBRIDGE_STORAGE_DRIVER || (defaults.storage && defaults.storage.driver) || 'file';
  const bootstrapStore = createStore({ storage: { driver: bootstrapDriver } }, state.dataDir);
  const overlayText = await bootstrapStore.readConfig();
  const overlay = overlayText ? yaml.load(overlayText) || {} : {};
  state.overlay = overlay;

  // 3. 逐级合并
  let config = deepMerge(defaults, overlay);
  config = applyEnv(config);

  // 4. 按最终配置创建存储实例（驱动变更需重启后生效）
  state.store = createStore(config, state.dataDir);

  state.config = config;
  return config;
}

/** 获取存储实例（其他模块统一经它读写配置/模板/缓存） */
function getStore() {
  if (!state.store) throw new Error('存储尚未初始化，请先调用 loadConfig()');
  return state.store;
}

/** 获取当前生效配置（配置的单一权威来源） */
function getConfig() {
  if (!state.config) throw new Error('配置尚未加载，请先调用 loadConfig()');
  return state.config;
}

/** 获取运行时数据目录 */
function getDataDir() {
  return state.dataDir;
}

/**
 * 运行时更新配置（Web 前台调用）
 * 仅允许修改白名单内的顶层键；修改会持久化到 data/config.yaml，重启后依然生效。
 * @param {object} partial 需要修改的配置片段
 */
async function updateConfig(partial) {
  if (!state.config) throw new Error('配置尚未加载');
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new Error('配置片段必须是 JSON 对象');
  }

  // 校验顶层键：白名单外的键显式报错，避免"保存成功但未生效"的困惑
  const clean = {};
  const unknown = Object.keys(partial).filter((k) => !ALLOWED_TOP_KEYS.has(k));
  if (unknown.length) {
    throw new Error(`不支持的配置项: ${unknown.join(', ')}（白名单：${[...ALLOWED_TOP_KEYS].join(', ')}）`);
  }
  for (const key of Object.keys(partial)) {
    clean[key] = partial[key];
  }

  // 累积进覆盖层（增量持久化：不覆盖之前已保存的其他键）
  state.overlay = deepMerge(state.overlay, clean);

  // 基于「默认 + 累积覆盖层 + 环境变量」重建生效配置（原地写回，保持引用稳定）
  const defaults = (await readYaml(DEFAULT_CONFIG_PATH)) || {};
  let merged = deepMerge(defaults, state.overlay);
  merged = applyEnv(merged);
  for (const key of Object.keys(state.config)) {
    delete state.config[key];
  }
  Object.assign(state.config, merged);

  // 持久化完整覆盖层，重启后依然生效
  await state.store.writeConfig(yaml.dump(state.overlay, { lineWidth: -1 }));
  return state.config;
}

/**
 * 整体替换运行时覆盖配置（数据迁移/备份恢复用）
 * 与 updateConfig 的区别：以给定对象为唯一覆盖层（旧键一并清除），
 * 并基于「默认 + 覆盖 + 环境变量」重建生效配置。
 * @param {object} partial 新的覆盖配置（仅保留白名单顶层键）
 */
async function replaceConfig(partial) {
  if (!state.config) throw new Error('配置尚未加载');
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new Error('配置必须是 JSON 对象');
  }

  // 校验顶层键：白名单外的键显式报错，避免"保存成功但未生效"的困惑
  const clean = {};
  const unknown = Object.keys(partial).filter((k) => !ALLOWED_TOP_KEYS.has(k));
  if (unknown.length) {
    throw new Error(`不支持的配置项: ${unknown.join(', ')}（白名单：${[...ALLOWED_TOP_KEYS].join(', ')}）`);
  }
  for (const key of Object.keys(partial)) {
    clean[key] = partial[key];
  }
  state.overlay = clean;

  // 重建生效配置（原地写回，保持对象引用稳定）
  const defaults = (await readYaml(DEFAULT_CONFIG_PATH)) || {};
  const merged = applyEnv(deepMerge(defaults, state.overlay));
  for (const key of Object.keys(state.config)) {
    delete state.config[key];
  }
  Object.assign(state.config, merged);

  // 持久化覆盖层（经存储层整体替换）
  await state.store.writeConfig(yaml.dump(state.overlay, { lineWidth: -1 }));
  return state.config;
}

/**
 * 脱敏配置（用于 API 返回，避免泄露令牌）
 * 规则：上游代理的密码、安全令牌被掩码替换。
 */
function maskSecrets(config) {
  const masked = JSON.parse(JSON.stringify(config));

  // 掩码上游代理密码
  if (masked.fetcher && masked.fetcher.upstream_proxy) {
    try {
      const u = new URL(masked.fetcher.upstream_proxy);
      if (u.password) {
        u.password = '******';
        masked.fetcher.upstream_proxy = u.toString();
      }
    } catch { /* 非标准代理 URL 时原样保留 */ }
  }

  // 掩码安全令牌
  for (const key of ['api_token', 'user_token']) {
    if (masked.security && masked.security[key]) masked.security[key] = '******';
  }
  return masked;
}

module.exports = {
  loadConfig,
  ALLOWED_TOP_KEYS,
  getConfig,
  getDataDir,
  getStore,
  updateConfig,
  replaceConfig,
  maskSecrets,
  deepMerge,
};
