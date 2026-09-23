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

test('_tick：从未运行过时 cron 模式触发一次', async () => {
  const ag = makeAutoGrab();
  await ag._tick();
  assert.ok(ag.lastRunAt(), '首次触发后应有运行时间');
});

test('_tick：本次 cron 命中时刻已运行过则不再触发', async () => {
  const ag = makeAutoGrab();
  await ag._tick();
  const first = ag.lastRunAt();
  assert.ok(first);
  const runs = ag.lastRunAt();
  // 同一 cron 命中周期内再次 tick（lastRunAt 晚于 prev）不重复触发
  await ag._tick();
  assert.equal(ag.lastRunAt(), runs);
  assert.equal(ag._running, false);
  assert.equal(ag.lastRunAt(), first);
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
