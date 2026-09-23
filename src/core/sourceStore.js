'use strict';

/**
 * 抓取来源管理（表格化增删改查 + 自动采集元数据）
 *
 * 数据文件：data/sources.json（版本化，结构可迁移）
 *   sources[]: {
 *     id, url, note, enabled, auto,          // auto=参与自动采集
 *     lastAt, lastStatus(ok|fail|''), lastNodes, lastError, order
 *   }
 *
 * 与配置的同步：
 *   - 加载时：config.subscription.extra_sources 中不在表格的链接自动并入表格（默认启用+参与采集）
 *   - 保存时：config.subscription.extra_sources 实时同步为"启用的源链接列表"（不破坏原有抓取/订阅逻辑）
 */

const crypto = require('node:crypto');

class SourceStore {
  /**
   * @param {object} store 数据存储（readDataFile / writeDataFile）
   * @param {object} config 生效配置（读 extra_sources；保存时经 updateConfig 写回）
   * @param {Function} [onUpdateConfig] 写回配置的钩子（避免循环依赖）
   */
  constructor(store, config, onUpdateConfig) {
    this.store = store;
    this.config = config;
    this.onUpdateConfig = onUpdateConfig || (async () => {});
    this.state = { version: 1, sources: [] };
    this._load();
  }

  /** 读取数据文件并合并配置中的 extra_sources */
  _load() {
    let disk = null;
    try {
      const raw = this.store.readDataFile('sources.json');
      if (raw) disk = JSON.parse(raw);
    } catch {
      disk = null;
    }
    if (disk && Array.isArray(disk.sources)) {
      this.state = { version: 1, sources: disk.sources };
    }
    // 兼容旧配置：把 extra_sources 里缺失的链接补进表格
    const extra = Array.isArray(this.config.subscription && this.config.subscription.extra_sources)
      ? this.config.subscription.extra_sources : [];
    const have = new Set(this.state.sources.map((s) => s.url));
    for (const url of extra) {
      if (url && !have.has(url)) {
        this.state.sources.push({
          id: crypto.randomUUID(),
          url,
          note: '',
          enabled: true,
          auto: true,
          lastAt: '', lastStatus: '', lastNodes: 0, lastError: '',
        });
        have.add(url);
      }
    }
  }

  /** 持久化到数据文件，并同步写回配置 extra_sources */
  async _save() {
    try {
      this.store.writeDataFile('sources.json', JSON.stringify(this.state, null, 2));
    } catch (err) {
      // 写盘失败不阻断内存操作（下次保存再试）
      console.error('[sourceStore] 写盘失败:', err.message);
    }
    const enabledUrls = this.state.sources.filter((s) => s.enabled !== false).map((s) => s.url);
    try {
      await this.onUpdateConfig({ subscription: { extra_sources: enabledUrls } });
    } catch (err) {
      console.error('[sourceStore] 同步配置失败:', err.message);
    }
  }

  /** 列表（按 order 排序） */
  list() {
    return this.state.sources
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.url).localeCompare(String(b.url)));
  }

  /** 新增来源（url 去重） */
  async add({ url, note = '', enabled = true, auto = true }) {
    const u = String(url || '').trim();
    if (!u) throw new Error('来源链接不能为空');
    if (this.state.sources.some((s) => s.url === u)) throw new Error('该来源已存在');
    const item = {
      id: crypto.randomUUID(),
      url: u,
      note: String(note || '').trim(),
      enabled: enabled !== false,
      auto: auto !== false,
      lastAt: '', lastStatus: '', lastNodes: 0, lastError: '',
    };
    this.state.sources.push(item);
    await this._save();
    return item;
  }

  /** 批量添加（urls 数组：字符串或 {url, note?}；重复自动跳过） */
  async addMany(urls, opts = {}) {
    const note = String(opts.note || '').trim();
    const added = [];
    const seen = new Set(this.state.sources.map((s) => s.url));
    for (const raw of urls) {
      const url = typeof raw === 'string' ? raw.trim() : String((raw && raw.url) || '').trim();
      const itemNote = raw && typeof raw === 'object' && raw.note ? String(raw.note).trim() : note;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const item = {
        id: crypto.randomUUID(),
        url,
        note: itemNote,
        enabled: true,
        auto: true,
        lastAt: '', lastStatus: '', lastNodes: 0, lastError: '',
      };
      this.state.sources.push(item);
      added.push(item);
    }
    if (added.length) await this._save();
    return added;
  }

  /** 更新来源字段（id 必填；url 重复校验） */
  async update(id, patch) {
    const item = this.state.sources.find((s) => s.id === id);
    if (!item) throw new Error('来源不存在');
    if (patch.url !== undefined) {
      const u = String(patch.url).trim();
      if (!u) throw new Error('来源链接不能为空');
      if (this.state.sources.some((s) => s.url === u && s.id !== id)) throw new Error('该来源已存在');
      item.url = u;
    }
    if (patch.note !== undefined) item.note = String(patch.note).trim();
    if (patch.enabled !== undefined) item.enabled = patch.enabled !== false;
    if (patch.auto !== undefined) item.auto = patch.auto !== false;
    await this._save();
    return item;
  }

  /** 删除来源 */
  async remove(id) {
    const idx = this.state.sources.findIndex((s) => s.id === id);
    if (idx < 0) throw new Error('来源不存在');
    this.state.sources.splice(idx, 1);
    await this._save();
    return { ok: true };
  }

  /** 记录一次抓取结果（供手动/自动采集回写） */
  async recordResult(id, { ok, nodes, error }) {
    const item = this.state.sources.find((s) => s.id === id);
    if (!item) return;
    item.lastAt = new Date().toISOString();
    item.lastStatus = ok ? 'ok' : 'fail';
    item.lastNodes = Number(nodes) || 0;
    item.lastError = error ? String(error).slice(0, 300) : '';
    await this._save();
    return item;
  }
}

module.exports = { SourceStore };
