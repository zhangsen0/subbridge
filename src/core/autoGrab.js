'use strict';

/**
 * 自动采集调度：按配置间隔定时抓取全部启用来源（可配置，禁止写死）
 *
 *   grab.auto_interval_minutes  采集间隔（分钟），0=关闭
 *   grab.auto_probe             采集后是否测速（true=抓取并测速）
 *   grab.auto_max_concurrency   采集并发上限（当前按顺序执行，预留扩展）
 *
 * 状态通过 /api/auto-grab 暴露；每次运行结果记入事件日志并回写各源 lastStatus。
 */

const CHECK_INTERVAL_MS = 30 * 1000; // 每 30 秒检查一次是否到点
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

  /** 启动定时检查（幂等，可重复调用） */
  start() {
    if (this._timer) return;
    this._scheduleNext();
    this._timer = setInterval(() => { this._tick().catch(() => {}); }, CHECK_INTERVAL_MS);
    this._tick().catch(() => {});
    if (this._timer.unref) this._timer.unref();
  }

  /** 停止定时器 */
  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  /** 周期检查：到点且未运行则触发 */
  async _tick() {
    const cfg = this.ctx.config;
    const cronExpr = cfg.grab && cfg.grab.auto_cron ? String(cfg.grab.auto_cron).trim() : '';
    if (cronExpr) {
      if (this._running) return;
      const next = nextCronMs(cronExpr);
      if (next == null) return; // 非法表达式不触发
      if (Date.now() < next) return;
      await this.runNow();
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
    const items = this.ctx.sources.list().filter((s) => s.enabled !== false && s.auto !== false);
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
      summary.durationMs = Date.now() - started;
      summary.finishedAt = new Date().toISOString();
      this._lastRunAt = summary.finishedAt;
      this._lastSummary = summary;
      this._scheduleNext();
      this.ctx.fetchLog.record({
        type: 'grab', kind: 'auto', url: `自动采集完成（源 ${summary.sources} 个 / 成功 ${summary.ok} / 失败 ${summary.fail}）`,
        nodes: summary.parsed, error: summary.fail ? summary.errors.slice(0, 2).join('；') : '',
      });
      if (task) this.ctx.taskManager.finish(task.id, {
        ok: summary.ok, fail: summary.fail,
        summary: `源 ${summary.sources} 个 / 成功 ${summary.ok} / 失败 ${summary.fail} / 解析节点 ${summary.parsed}`,
      });
      return summary;
    } finally {
      this._running = false;
    }
  }
}

module.exports = { AutoGrab };
