'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { AutoGrab, nextCronMs, previousCronMs } = require('../src/core/autoGrab');

/** 等待挂起的微任务/IO（_persistState 为异步 fire-and-forget） */
const flush = () => new Promise((r) => setImmediate(r));

test('previousCronMs：返回最近一次命中时刻（严格早于当前）', () => {
  // 00:00:30 → 最近一次命中是当天 00:00（UTC 16:00 = 北京时间次日 00:00）
  const prev = previousCronMs('0 0 * * *', new Date('2026-09-24T00:00:30Z'));
  assert.equal(prev, new Date('2026-09-23T16:00:00Z').getTime());
});

test('nextCronMs：严格大于当前时间（用于展示，不用于触发判定）', () => {
  const next = nextCronMs('0 0 * * *', new Date('2026-09-24T00:00:30Z'));
  assert.equal(next, new Date('2026-09-24T16:00:00Z').getTime());
});

/** 内存版存储（模拟 fileStore.readDataFile / writeDataFile） */
function makeStore() {
  const files = new Map();
  return {
    files,
    async readDataFile(name) { return files.has(name) ? files.get(name) : null; },
    async writeDataFile(name, content) { files.set(name, content); },
  };
}

function makeAutoGrab(opts = {}) {
  const ctx = {
    config: {
      grab: {
        auto_cron: opts.cron !== undefined ? opts.cron : '0 0 * * *',
        auto_probe: true,
        auto_catch_up_on_startup: !!opts.catchUp,
        auto_state_file: opts.stateFile || '',
      },
    },
    sources: { list: () => [] },
    grabOne: async () => ({ ok: true, parsed: 0, added: 0, updated: 0 }),
    fetchLog: { record: () => {} },
    taskManager: { start: () => ({ id: 't' }), progress: () => {}, finish: () => {} },
  };
  if (opts.store) ctx.store = opts.store;
  const ag = new AutoGrab(ctx);
  if (opts.lastRunAt) ag._lastRunAt = opts.lastRunAt;
  if (opts.bootAt !== undefined) ag._bootAt = opts.bootAt;
  return ag;
}

test('_tick：cron 命中时刻早于进程启动（历史槽位）不补跑，且只登记一次', async () => {
  const ag = makeAutoGrab({ bootAt: Date.now() + 60 * 1000 }); // 进程在最近命中之后才启动
  await ag._tick();
  assert.equal(ag.lastRunAt(), '', '历史槽位不应触发');
  assert.equal(ag._running, false);
  const slot = ag._lastSlotAt;
  assert.ok(slot > 0, '历史槽位应被登记，避免后续重复判定');
  await ag._tick();
  assert.equal(ag.lastRunAt(), '', '同一命中时刻不重复触发');
  assert.equal(ag._lastSlotAt, slot);
});

test('_tick：cron 到点后（进程已运行）必定触发一次——修复"从未运行过就永不执行"', async () => {
  const ag = makeAutoGrab({ bootAt: 0 }); // 进程在该 cron 命中之前已启动
  await ag._tick();
  assert.ok(ag.lastRunAt(), '到点后应触发（即使从未运行过）');
  assert.equal(ag._running, false);
});

test('_tick：同一 cron 命中时刻触发后不重复执行', async () => {
  const ag = makeAutoGrab({ bootAt: 0 });
  await ag._tick();
  const first = ag.lastRunAt();
  assert.ok(first);
  await ag._tick();
  assert.equal(ag.lastRunAt(), first, '同一命中时刻不应再次执行');
});

test('_tick：同一命中时刻已手动执行过则不再自动重复', async () => {
  const ag = makeAutoGrab({ bootAt: 0 });
  await ag.runNow(); // 模拟前台手动立即执行
  const manual = ag.lastRunAt();
  await ag._tick();
  assert.equal(ag.lastRunAt(), manual);
});

test('_tick：非法 cron 表达式不触发也不报错', async () => {
  const ag = makeAutoGrab({ cron: 'not-a-cron' });
  await ag._tick();
  assert.equal(ag.lastRunAt(), '');
  assert.equal(ag._running, false);
});

test('_tick：cron 关闭（空表达式）时按间隔判定——未配置间隔不触发', async () => {
  const ag = makeAutoGrab({ cron: '' });
  await ag._tick();
  assert.equal(ag.lastRunAt(), '');
});

test('auto_catch_up_on_startup：开启后历史槽位补跑一次', async () => {
  const ag = makeAutoGrab({ bootAt: Date.now() + 60 * 1000, catchUp: true });
  await ag._tick();
  assert.ok(ag.lastRunAt(), '允许补跑时应立即执行一次');
});

test('上次运行时间持久化到存储并可跨重启恢复', async () => {
  const store = makeStore();
  const ag = makeAutoGrab({ store, bootAt: 0 });
  await ag._tick();
  await flush();
  const runAt = ag.lastRunAt();
  assert.ok(runAt, '应已执行一次');
  assert.ok(store.files.has('auto-grab-state.json'), '默认文件名写入状态');
  assert.equal(JSON.parse(store.files.get('auto-grab-state.json')).lastRunAt, runAt);

  // 模拟进程重启：新实例应恢复上次执行时间（页面"上一次执行时间"不再丢失）
  const ag2 = makeAutoGrab({ store });
  await ag2._restoreState();
  assert.equal(ag2.lastRunAt(), runAt);
});

test('auto_state_file：可自定义持久化文件名', async () => {
  const store = makeStore();
  const ag = makeAutoGrab({ store, bootAt: 0, stateFile: 'my-state.json' });
  await ag._tick();
  await flush();
  assert.ok(store.files.has('my-state.json'));
  assert.ok(!store.files.has('auto-grab-state.json'));
});

test('_restoreState：状态损坏或时间为未来时不污染运行状态', async () => {
  const store = makeStore();
  await store.writeDataFile('auto-grab-state.json', '{ broken json');
  const ag = makeAutoGrab({ store });
  await ag._restoreState();
  assert.equal(ag.lastRunAt(), '');

  const store2 = makeStore();
  await store2.writeDataFile('auto-grab-state.json', JSON.stringify({ lastRunAt: new Date(Date.now() + 86400000).toISOString() }));
  const ag2 = makeAutoGrab({ store: store2 });
  await ag2._restoreState();
  assert.equal(ag2.lastRunAt(), '');
});
