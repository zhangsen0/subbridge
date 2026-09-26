'use strict';

/**
 * 自动采集调度：按配置间隔定时抓取全部启用来源（可配置，禁止写死）
 *
 *   grab.auto_cron                 采集 cron 表达式（优先于间隔）
 *   grab.auto_state_file           上次运行时间持久化文件（留空则用默认文件名）
 *   grab.auto_catch_up_on_startup  启动时是否补跑"服务停止期间错过"的 cron 命中（默认 false）
 *   grab.auto_interval_minutes     采集间隔（分钟），0=关闭
 *   grab.auto_probe                采集后是否测速（true=抓取并测速）
 *   grab.auto_max_concurrency      采集并发上限（当前按顺序执行，预留扩展）
 *
 * 状态通过 /api/auto-pilot 与 /api/auto-grab 暴露；每次运行结果记入事件日志并回写各源 lastStatus。
 * 触发判定以 cron 命中时刻（槽位）为粒度：每个命中时刻最多执行一次，进程重启后由持久化状态恢复
 * "上次执行时间"，页面不再因重启丢失"上一次执行时间"。
 */

const CHECK_INTERVAL_MS = 30 * 1000; // 每 30 秒检查一次是否到点
const DEFAULT_STATE_FILE = 'auto-grab-state.json'; // 上次运行时间持久化文件（grab.auto_state_file 可覆盖）
const cronParser = require('cron-parser');

/**
 * 解析 cron 表达式为下一次触发时间（毫秒时间戳）。
 * 支持标准 5 段 cron（分 时 日 月 周），如 "0 0 * * *"=每天 00:00。
 * @param {string} expr cron 表达式
 * @param {Date} [from] 起始时间
 * @returns {number|null} 下次触发毫秒时间戳；非法表达式返回 null
 */
function nextCronMs(expr, from) {
  try {
    const interval = cronParser.parseExpression(String(expr).trim(), { currentDate: from || new Date() });
    const next = interval.next().toDate();
    return next.getTime();
  } catch {
    return null;
  }
}

/**
 * 解析 cron 表达式为最近一次触发时间（毫秒时间戳）。
 * 触发判定以"上一次命中时刻"为准：next() 严格大于当前时间，若用 next 判定
 * 会永远满足 now < next 导致定时永不触发；改用 prev() 且与上次运行时间比较。
 * @param {string} expr cron 表达式
 * @param {Date} [from] 起始时间
 * @returns {number|null} 最近一次触发毫秒时间戳；非法表达式返回 null
 */
function previousCronMs(expr, from) {
  try {
    const interval = cronParser.parseExpression(String(expr).trim(), { currentDate: from || new Date() });
    const prev = interval.prev().toDate();
    return prev.getTime();
  } catch {
    return null;
  }
}

class AutoGrab {
  /**
   * @param {object} ctx 运行上下文（config / sources / fetchLog / grabOne）
   */
  constructor(ctx) {
    this.ctx = ctx;
    this._timer = null;
    this._running = false;
    this._lastRunAt = '';
    this._lastSummary = null;
    this._nextAt = '';
    // 当前进程启动时刻：用于区分"启动后到点的 cron 命中"与"启动前的历史命中"
    this._bootAt = Date.now();
    // 已处理过的 cron 命中时刻（毫秒），同一命中时刻只触发一次，避免重复执行
    this._lastSlotAt = 0;
  }

  /** 当前是否运行中 */
  running() { return this._running; }
  lastRunAt() { return this._lastRunAt; }
  lastRunSummary() { return this._lastSummary; }
  nextRunAt() { return this._nextAt; }

  /** 计算下次运行时间（字符串），未开启返回空；grab.auto_cron（cron 表达式）优先于间隔 */
  _scheduleNext() {
    const cfg = this.ctx.config;
    const cronExpr = cfg.grab && cfg.grab.auto_cron ? String(cfg.grab.auto_cron).trim() : '';
    if (cronExpr) {
      const next = nextCronMs(cronExpr);
      this._nextAt = next ? new Date(next).toISOString() : '';
      return;
    }
    const intervalMin = Math.max(0, Number(cfg.grab && cfg.grab.auto_interval_minutes) || 0);
    if (!intervalMin) { this._nextAt = ''; return; }
    const base = this._lastRunAt ? new Date(this._lastRunAt).getTime() : Date.now();
    const next = base + intervalMin * 60 * 1000;
    this._nextAt = new Date(next).toISOString();
  }

  /** 上次运行时间持久化文件名（grab.auto_state_file 可配置；留空用默认文件名） */
  _stateFileName() {
    const grab = this.ctx.config && this.ctx.config.grab ? this.ctx.config.grab : {};
    const raw = grab.auto_state_file != null ? String(grab.auto_state_file).trim() : '';
    return raw || DEFAULT_STATE_FILE;
  }

  /**
   * 从存储恢复上次运行时间：解决"服务重启后上一次执行时间丢失"的问题，
   * 恢复值同时用于 cron 补跑判定（避免服务停机期间错过的周期在重启后被重复补跑）。
   */
  async _restoreState() {
    const store = this.ctx.store;
    if (!store || typeof store.readDataFile !== 'function') return;
    try {
      const raw = await store.readDataFile(this._stateFileName());
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const last = parsed && parsed.lastRunAt ? new Date(parsed.lastRunAt).getTime() : 0;
      // 忽略非法/未来时间（异常时钟或手工改写）
      if (last > 0 && last <= Date.now()) this._lastRunAt = new Date(last).toISOString();
    } catch {
      // 状态文件缺失或损坏不影响运行
    }
  }

  /** 持久化上次运行时间（异步写入，失败不影响主流程） */
  _persistState() {
    const store = this.ctx.store;
    if (!store || typeof store.writeDataFile !== 'function') return;
    const payload = JSON.stringify({ lastRunAt: this._lastRunAt, updatedAt: new Date().toISOString() });
    Promise.resolve(store.writeDataFile(this._stateFileName(), payload)).catch(() => {});
  }

  /** 启动定时检查（幂等，可重复调用） */
  start() {
    if (this._timer) return;
    // 先恢复上次运行时间再注册周期检查：避免恢复前被误判为"从未运行"而错过/误导补跑判定
    this._restoreState()
      .catch(() => {})
      .then(() => {
        this._scheduleNext();
        return this._tick();
      })
      .catch(() => {});
    this._timer = setInterval(() => { this._tick().catch(() => {}); }, CHECK_INTERVAL_MS);
    if (this._timer.unref) this._timer.unref();
  }

  /** 停止定时器 */
  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  /**
   * 周期检查：到点且未运行则触发
   *
   * cron 判定以"命中时刻（槽位）"为粒度：
   *   1. 每个 cron 命中时刻最多执行一次（_lastSlotAt 去重）
   *   2. 进程启动前到点的历史槽位只登记、不执行（避免重启瞬间补跑 / 源尚未加载完成）
   *   3. 同一命中时刻已运行过（自动或手动）不再重复执行
   * 注意：原实现要求 _lastRunAt 非空才可能触发（"从未运行就不补跑"），导致从未手动执行过
   * 以及每次重启后的服务再也不会自动采集——本次修复保留"不补跑历史槽位"的语义，
   * 但不再依赖 _lastRunAt 作为触发前提，到点的槽位必定执行。
   */
  async _tick() {
    const cfg = this.ctx.config;
    // 先刷新"下次运行时间"展示值：任务运行中也要保持最新（避免 cron 改了、页面还显示旧时间）
    this._scheduleNext();
    const cronExpr = cfg.grab && cfg.grab.auto_cron ? String(cfg.grab.auto_cron).trim() : '';
    if (cronExpr) {
      if (this._running) return;
      const prev = previousCronMs(cronExpr);
      if (prev == null) return; // 非法表达式不触发
      // 同一命中时刻已处理过（含历史槽位登记）：直接返回
      if (this._lastSlotAt === prev) return;
      // 历史槽位（到点时刻早于本进程启动）：默认只登记不执行，等下一个真正到点的槽位；
      // 配置 grab.auto_catch_up_on_startup=true 时，若上次运行早于该槽位则补跑一次
      const catchUp = !!(cfg.grab && cfg.grab.auto_catch_up_on_startup);
      if (prev < this._bootAt && !catchUp) { this._lastSlotAt = prev; return; }
      // 已运行过且运行时间不早于该命中时刻：本次命中已满足，不重复执行
      if (this._lastRunAt && new Date(this._lastRunAt).getTime() >= prev) { this._lastSlotAt = prev; return; }
      await this.runNow();
      this._lastSlotAt = prev;
      return;
    }
    const intervalMin = Math.max(0, Number(cfg.grab && cfg.grab.auto_interval_minutes) || 0);
    if (!intervalMin || this._running) return;
    if (this._lastRunAt && Date.now() - new Date(this._lastRunAt).getTime() < intervalMin * 60 * 1000) return;
    await this.runNow();
  }

  /** 立即执行一次自动采集（手动触发也走这里） */
  async runNow() {
    if (this._running) return { skipped: true, message: '采集进行中，已跳过本次' };
    this._running = true;
    const cfg = this.ctx.config;
    const probe = !!(cfg.grab && cfg.grab.auto_probe);
    // 等待订阅源加载完成（启动早期 sources 异步加载，避免只采集到部分源）
    if (this.ctx.sources && typeof this.ctx.sources.ready === 'function') {
      await this.ctx.sources.ready();
    }
    const items = this.ctx.sources.list().filter((s) => s.enabled !== false && s.auto !== false);
    // 主订阅地址一并纳入自动采集（grab.include_main_urls 默认开）：主订阅节点也入池，
    // 与"输出不合并主订阅（merge_main_urls=false）"是两回事——入池后可被池规则选中输出
    const includeMain = (cfg.grab && cfg.grab.include_main_urls) !== false;
    if (includeMain) {
      const mains = (cfg.subscription && cfg.subscription.main_urls || []).filter(Boolean);
      for (const m of mains) {
        items.push({ url: String(m), name: '主订阅', auto: true, enabled: true });
      }
    }
    // 登记后台任务（前台「后台任务」标签页实时查看进度）
    const task = this.ctx.taskManager
      ? this.ctx.taskManager.start({ type: 'auto-grab', title: `自动采集来源 ${items.length} 个`, total: items.length })
      : null;
    const started = Date.now();
    const summary = { sources: items.length, ok: 0, fail: 0, parsed: 0, added: 0, updated: 0, startedAt: new Date().toISOString(), errors: [] };
    try {
      if (items.length) {
        let done = 0;
        for (const item of items) {
          done += 1;
          try {
            const result = await this.ctx.grabOne(item, { probe });
            summary.parsed += result.parsed || 0;
            summary.added += result.added || 0;
            summary.updated += result.updated || 0;
            if (result.ok) summary.ok += 1;
            else { summary.fail += 1; summary.errors.push(result.error); }
          } catch (err) {
            summary.fail += 1;
            summary.errors.push(String(err.message || err).slice(0, 120));
          }
          if (task) this.ctx.taskManager.progress(task.id, { done, ok: summary.ok, fail: summary.fail });
        }
      }
      // 抓取后维护步骤（与无人值守步骤一一对应，全部可配置）：
      // 1) remove：测速不可达节点自动删除（grab.auto_remove_unreachable）
      // 2) cleanup：定期清理与质量门槛（pool.cleanup_enabled + pool.cleanup_rules）
      let removed = 0, cleaned = 0;
      if (cfg.grab && cfg.grab.auto_remove_unreachable && this.ctx.nodePool) {
        try {
          const { isNodeUsable } = require('./quality');
          const poolCfg = cfg.pool || {};
          const maxMs = Number(poolCfg.filter_max_latency_ms) > 0 ? Number(poolCfg.filter_max_latency_ms) : 1000;
          const keepUnprobed = poolCfg.filter_keep_unprobed !== false;
          const all = await this.ctx.nodePool.list();
          const keys = all.filter((n) => !isNodeUsable(n, { maxLatencyMs: maxMs, keepUnprobed })).map((n) => `${n.type}:${n.server}:${n.port}`);
          if (keys.length) removed = await this.ctx.nodePool.remove(keys);
          if (removed > 0) {
            this.ctx.fetchLog.record({ type: 'pool', kind: 'auto-remove', url: `无人值守自动删除不可用节点 ${removed} 个（检查 ${all.length}）`, error: '' });
          }
        } catch (err) {
          summary.errors.push(`自动删除不可用失败：${String(err.message || err).slice(0, 120)}`);
        }
      }
      if (cfg.pool && cfg.pool.cleanup_enabled && this.ctx.nodePool) {
        try {
          const { applyCleanup } = require('./cleanup');
          const rules = Array.isArray(cfg.pool.cleanup_rules) ? cfg.pool.cleanup_rules : [];
          const c = await applyCleanup(this.ctx.nodePool, rules);
          cleaned = c.removed;
          if (cleaned > 0) {
            this.ctx.fetchLog.record({ type: 'pool', kind: 'auto-cleanup', url: `无人值守定期清理删除 ${cleaned} 个（检查 ${c.checked}）`, error: '' });
          }
        } catch (err) {
          summary.errors.push(`定期清理失败：${String(err.message || err).slice(0, 120)}`);
        }
      }
      summary.removed = removed;
      summary.cleaned = cleaned;
      summary.durationMs = Date.now() - started;
      summary.finishedAt = new Date().toISOString();
      this._lastRunAt = summary.finishedAt;
      this._lastSummary = summary;
      this._persistState();
      this._scheduleNext();
      this.ctx.fetchLog.record({
        type: 'grab', kind: 'auto', url: `自动采集完成（源 ${summary.sources} 个 / 成功 ${summary.ok} / 失败 ${summary.fail} / 删除 ${removed} / 清理 ${cleaned}）`,
        nodes: summary.parsed, error: summary.fail ? summary.errors.slice(0, 2).join('；') : '',
      });
      if (task) this.ctx.taskManager.finish(task.id, {
        ok: summary.ok, fail: summary.fail,
        summary: `源 ${summary.sources} 个 / 成功 ${summary.ok} / 失败 ${summary.fail} / 解析节点 ${summary.parsed} / 删除不可用 ${removed} / 清理 ${cleaned}`,
      });
      return summary;
    } finally {
      this._running = false;
    }
  }
}

module.exports = { AutoGrab, nextCronMs, previousCronMs };
