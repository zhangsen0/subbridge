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
