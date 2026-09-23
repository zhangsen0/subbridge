'use strict';

/**
 * 后台任务管理器：统一登记与跟踪抓取、测速、自动采集等异步任务的实时进度。
 *
 * 前台「后台任务」标签页轮询 GET /api/tasks，展示进行中的任务（含进度条）与最近完成记录；
 * 与事件日志互补：日志是历史流水，任务是当前/近期异步工作的实时视图。
 * 参数全部配置化：保留历史条数 tasks.max_history（默认 20）。
 */

class TaskManager {
  /**
   * @param {{maxHistory?: number}} opts maxHistory=保留最近完成任务条数
   */
  constructor(opts = {}) {
    this.maxHistory = Math.max(1, Number(opts.maxHistory) || 20);
    /** @type {Map<string, object>} id -> 任务对象 */
    this.tasks = new Map();
    this.seq = 0;
  }

  /** 生成任务 ID（进程内自增） */
  _newId() {
    this.seq += 1;
    return 'task-' + this.seq;
  }

  /**
   * 登记一个新任务并开始跟踪
   * @param {{type: string, title: string, total?: number}} spec
   * @returns {object} 任务对象（status=running）
   */
  start({ type, title, total = 0 }) {
    const task = {
      id: this._newId(),
      type: type || 'task',
      title: title || '',
      status: 'running',          // running | completed | failed
      total: Math.max(0, Number(total) || 0),
      done: 0,
      ok: 0,
      fail: 0,
      summary: '',
      error: '',
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  /**
   * 更新任务进度（任一字段缺省则不变）
   * @param {string} id 任务 ID
   * @param {{done?: number, ok?: number, fail?: number, total?: number, summary?: string}} patch
   */
  progress(id, patch = {}) {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return;
    if (patch.done != null) task.done = Math.max(0, Number(patch.done) || 0);
    if (patch.ok != null) task.ok = Math.max(0, Number(patch.ok) || 0);
    if (patch.fail != null) task.fail = Math.max(0, Number(patch.fail) || 0);
    if (patch.total != null) task.total = Math.max(0, Number(patch.total) || 0);
    if (patch.summary != null) task.summary = String(patch.summary).slice(0, 300);
  }

  /**
   * 完成任务（error 非空则标记 failed）
   * @param {string} id 任务 ID
   * @param {{ok?: number, fail?: number, summary?: string, error?: string}} patch
   */
  finish(id, patch = {}) {
    const task = this.tasks.get(id);
    if (!task) return;
    if (patch.ok != null) task.ok = Math.max(0, Number(patch.ok) || 0);
    if (patch.fail != null) task.fail = Math.max(0, Number(patch.fail) || 0);
    if (patch.summary != null) task.summary = String(patch.summary).slice(0, 300);
    if (patch.error) {
      task.error = String(patch.error).slice(0, 300);
      task.status = 'failed';
    } else {
      task.status = 'completed';
    }
    task.done = task.total || task.ok + task.fail;
    task.finishedAt = new Date().toISOString();
  }

  /**
   * 任务列表：进行中在前，其余按开始时间倒序保留最近 maxHistory 条
   * @returns {object[]}
   */
  list() {
    const all = [...this.tasks.values()];
    const running = all.filter((t) => t.status === 'running');
    const finished = all
      .filter((t) => t.status !== 'running')
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
      .slice(0, this.maxHistory);
    return [...running, ...finished];
  }

  /** 进行中任务数量 */
  runningCount() {
    return [...this.tasks.values()].filter((t) => t.status === 'running').length;
  }
}

module.exports = { TaskManager };
