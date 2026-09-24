'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { AutoGrab, nextCronMs, previousCronMs } = require('../src/core/autoGrab');

test('previousCronMs：返回最近一次命中时刻（严格早于当前）', () => {
  // 00:00:30 → 最近一次命中是当天 00:00（UTC 16:00 = 北京时间次日 00:00）
  const prev = previousCronMs('0 0 * * *', new Date('2026-09-24T00:00:30Z'));
  assert.equal(prev, new Date('2026-09-23T16:00:00Z').getTime());
});

test('nextCronMs：严格大于当前时间（用于展示，不用于触发判定）', () => {
  const next = nextCronMs('0 0 * * *', new Date('2026-09-24T00:00:30Z'));
  assert.equal(next, new Date('2026-09-24T16:00:00Z').getTime());
});

function makeAutoGrab(lastRunAt = '') {
  const ctx = {
    config: { grab: { auto_cron: '0 0 * * *', auto_probe: true } },
    sources: { list: () => [] },
    grabOne: async () => ({ ok: true, parsed: 0, added: 0, updated: 0 }),
    fetchLog: { record: () => {} },
    taskManager: { start: () => ({ id: 't' }), progress: () => {}, finish: () => {} },
  };
  const ag = new AutoGrab(ctx);
  if (lastRunAt) ag._lastRunAt = lastRunAt;
  return ag;
}

test('_tick：从未运行过时 cron 模式不立即触发（等首次到点，避免启动早期源未加载）', async () => {
  const ag = makeAutoGrab();
  await ag._tick();
  assert.equal(ag.lastRunAt(), '', '从未运行不应立即触发');
  assert.equal(ag._running, false);
});

test('_tick：本次 cron 命中时刻已运行过则不再触发；到点后触发一次', async () => {
  const ag = makeAutoGrab();
  // 模拟已运行：把 lastRunAt 设为上一个命中周期之前（早于 prev），tick 应触发
  const cfg = ag.ctx.config;
  const prev = previousCronMs(cfg.grab.auto_cron, new Date());
  ag._lastRunAt = new Date(prev - 60 * 1000).toISOString();
  await ag._tick();
  assert.ok(ag.lastRunAt(), '到点后应触发');
  const first = ag.lastRunAt();
  // 同一 cron 命中周期内再次 tick（lastRunAt 晚于 prev）不重复触发
  await ag._tick();
  assert.equal(ag.lastRunAt(), first);
  assert.equal(ag._running, false);
});

test('_tick：非法 cron 表达式不触发也不报错', async () => {
  const ctx = {
    config: { grab: { auto_cron: 'not-a-cron' } },
    sources: { list: () => [] },
    grabOne: async () => ({ ok: true, parsed: 0 }),
    fetchLog: { record: () => {} },
    taskManager: { start: () => ({ id: 't' }), progress: () => {}, finish: () => {} },
  };
  const ag = new AutoGrab(ctx);
  await ag._tick();
  assert.equal(ag.lastRunAt(), '');
  assert.equal(ag._running, false);
});
