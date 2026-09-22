'use strict';

/**
 * 文件存储驱动（默认实现）
 *
 * 所有运行时数据以文件形式保存在数据目录（默认 data/）下：
 *   config.yaml          覆盖配置
 *   templates/           运行时模板（用户自定义，优先于内置模板）
 *   cf-tunnel.yml        生成文件（CF 隧道命名模式凭据等）
 *
 * 缓存为进程内实现（TTL 过期，单实例共享）。
 * 该驱动是 store 接口的参考实现，后续可新增 postgres/mysql 等驱动。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

// 文件名白名单：仅允许安全字符，防止路径穿越
const SAFE_NAME_RE = /^[\w.-]+$/;

/** 校验文件名是否安全，不安全返回 null */
function safeName(name) {
  return typeof name === 'string' && SAFE_NAME_RE.test(name) && !name.startsWith('.') ? name : null;
}

class FileStore {
  /**
   * @param {string} dataDir 数据目录绝对路径
   */
  constructor(dataDir) {
    this.root = dataDir;
    // 内存缓存：key -> { value, expireAt }
    this.cache = new Map();
  }

  /** 数据目录路径（供需要真实路径的模块使用，如 cloudflared 配置） */
  dataDir() {
    return this.root;
  }

  /* ============ 覆盖配置 ============ */

  /** 读取覆盖配置原文；不存在返回 null */
  async readConfig() {
    return readText(this.root, 'config.yaml');
  }

  /** 写入覆盖配置（整体替换） */
  async writeConfig(text) {
    await writeText(this.root, 'config.yaml', text);
  }

  /* ============ 模板 ============ */

  /** 列出运行时模板文件名 */
  async listTemplates() {
    const dir = path.join(this.root, 'templates');
    try {
      const entries = await fs.readdir(dir);
      const names = [];
      for (const e of entries) {
        if (!SAFE_NAME_RE.test(e)) continue;
        const stat = await fs.stat(path.join(dir, e));
        if (stat.isFile()) names.push(e);
      }
      return names;
    } catch {
      return [];
    }
  }

  /** 读取模板内容；不存在返回 null */
  async readTemplate(name) {
    if (!safeName(name)) return null;
    return readText(path.join(this.root, 'templates'), name);
  }

  /** 写入模板 */
  async writeTemplate(name, content) {
    const safe = safeName(name);
    if (!safe) throw new Error(`非法模板名: ${name}`);
    await writeText(path.join(this.root, 'templates'), safe, content);
  }

  /* ============ 生成文件 ============ */

  /** 读取生成文件（如 cf-tunnel.yml）；不存在返回 null */
  async readDataFile(name) {
    const safe = safeName(name);
    if (!safe) return null;
    return readText(this.root, safe);
  }

  /** 写入生成文件 */
  async writeDataFile(name, content) {
    const safe = safeName(name);
    if (!safe) throw new Error(`非法文件名: ${name}`);
    await writeText(this.root, safe, content);
  }

  /* ============ 缓存（进程内存实现） ============ */

  /** 读取缓存；不存在或已过期返回 undefined */
  cacheGet(key) {
    const item = this.cache.get(String(key));
    if (!item) return undefined;
    if (item.expireAt !== 0 && Date.now() > item.expireAt) {
      this.cache.delete(String(key));
      return undefined;
    }
    return item.value;
  }

  /** 写入缓存；ttlSeconds <= 0 表示不过期 */
  cacheSet(key, value, ttlSeconds) {
    const expireAt = Number(ttlSeconds) > 0 ? Date.now() + Number(ttlSeconds) * 1000 : 0;
    this.cache.set(String(key), { value, expireAt });
  }

  /** 删除缓存 */
  cacheDelete(key) {
    this.cache.delete(String(key));
  }
}

/** 读取目录下文件；不存在返回 null */
async function readText(dir, name) {
  try {
    return await fs.readFile(path.join(dir, name), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** 写入目录下文件（自动建目录） */
async function writeText(dir, name, content) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), content, 'utf8');
}

module.exports = { FileStore, safeName };
