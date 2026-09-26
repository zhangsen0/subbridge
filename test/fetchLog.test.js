'use strict';

/** 事件日志（全站可检测数据记录）测试 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FetchLog } = require('../src/server/fetchLog');

test('record 默认类型为 fetch，且带 id/ts', () => {
  const log = new FetchLog(100);
  const item = log.record({ url: 'https://a.example.com', nodes: 3 });
  assert.equal(item.type, 'fetch');
  assert.ok(item.id > 0);
  assert.ok(item.ts);
  assert.equal(item.url, 'https://a.example.com');
});

test('list 最新在前，支持 limit', () => {
  const log = new FetchLog(100);
  log.record({ url: '1' });
  log.record({ url: '2' });
  log.record({ url: '3' });
  const list = log.list({ limit: 2 });
  assert.equal(list.length, 2);
  assert.equal(list[0].url, '3');
});

test('list 支持 ok 过滤（成功/失败）', () => {
  const log = new FetchLog(100);
  log.record({ url: 'ok1', error: '' });
  log.record({ url: 'bad1', error: '超时' });
  assert.equal(log.list({ ok: true }).length, 1);
  assert.equal(log.list({ ok: false })[0].url, 'bad1');
});

test('list 支持 type 过滤（抓取/测速/配置/系统）', () => {
  const log = new FetchLog(100);
  log.record({ url: '抓取A' });
  log.record({ type: 'probe', url: '测速B', nodes: 10, alive: 8 });
  log.record({ type: 'config', url: '更新配置' });
  assert.equal(log.list({ type: 'probe' }).length, 1);
  assert.equal(log.list({ type: 'probe' })[0].nodes, 10);
  assert.equal(log.list({ type: 'config' })[0].url, '更新配置');
  assert.equal(log.list({ type: 'system' }).length, 0);
});

test('环形缓冲：超出容量自动丢弃最旧', () => {
  const log = new FetchLog(3);
  log.record({ url: '1' });
  log.record({ url: '2' });
  log.record({ url: '3' });
  log.record({ url: '4' });
  const list = log.list();
  assert.equal(list.length, 3);
  assert.equal(list[2].url, '2'); // '1' 已被丢弃
});

test('clear 清空全部', () => {
  const log = new FetchLog(10);
  log.record({ url: '1' });
  log.clear();
  assert.equal(log.list().length, 0);
});

/** 内存版存储（模拟 fileStore / sqliteStore 的 readDataFile / writeDataFile） */
function makeStore() {
  const files = new Map();
  return {
    files,
    async readDataFile(name) { return files.has(name) ? files.get(name) : null; },
    async writeDataFile(name, content) { files.set(name, content); },
  };
}

test('持久化：flush 后可从存储恢复历史日志，id 连续不冲突', async () => {
  const store = makeStore();
  const log = new FetchLog(100, { store });
  await log.ready();
  log.record({ url: '第一次' });
  log.record({ type: 'grab', url: '自动采集完成' });
  await log.flush();
  assert.ok(store.files.has('fetch-log.json'));

  // 模拟重启
  const reboot = new FetchLog(100, { store });
  await reboot.ready();
  const list = reboot.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].url, '自动采集完成'); // 最新在前
  assert.ok(list[0].id > list[1].id, 'id 递增不重复');

  // 重启后继续写入，id 应在恢复的序号上继续增长
  const next = reboot.record({ url: '重启后' });
  assert.ok(next.id > list[0].id);
});

test('持久化：close=false 时不写存储', async () => {
  const store = makeStore();
  const log = new FetchLog(10, { store, persist: false });
  await log.ready();
  log.record({ url: 'x' });
  await log.flush();
  assert.ok(!store.files.has('fetch-log.json'));
});

test('持久化：加载期间写入的条目不被历史覆盖', async () => {
  const store = makeStore();
  await store.writeDataFile('fetch-log.json', JSON.stringify({ items: [{ id: 1, url: '历史1' }] }));
  const log = new FetchLog(100, { store });
  log.record({ url: '启动期写入' }); // 未 await ready 就写入
  await log.ready();
  const urls = log.list().map((i) => i.url);
  assert.deepEqual(urls, ['启动期写入', '历史1'], '新写入排在历史之后且都保留');
});

test('持久化：容量裁剪后只保留最近若干条', async () => {
  const store = makeStore();
  const log = new FetchLog(3, { store });
  await log.ready();
  for (let i = 1; i <= 5; i += 1) log.record({ url: `n${i}` });
  await log.flush();
  const reboot = new FetchLog(3, { store });
  await reboot.ready();
  assert.deepEqual(reboot.list().map((i) => i.url), ['n5', 'n4', 'n3']);
});

test('持久化：损坏的日志内容不影响启动', async () => {
  const store = makeStore();
  await store.writeDataFile('fetch-log.json', '{ not json');
  const log = new FetchLog(10, { store });
  await log.ready();
  assert.equal(log.list().length, 0);
  log.record({ url: '恢复后第一条' });
  assert.equal(log.list().length, 1);
});

test('clear 同时清空持久化内容', async () => {
  const store = makeStore();
  const log = new FetchLog(10, { store });
  await log.ready();
  log.record({ url: '1' });
  await log.flush();
  log.clear();
  await log.flush();
  const reboot = new FetchLog(10, { store });
  await reboot.ready();
  assert.equal(reboot.list().length, 0);
});
