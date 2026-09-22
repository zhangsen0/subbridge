'use strict';

/**
 * 节点池单元测试
 * 覆盖：补充/更新（upsert）、不自动删除、手动删除、清空、测速结果写回、持久化。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileStore } = require('../src/store/fileStore');
const { NodePool, nodeKey } = require('../src/core/nodePool');

/** 创建临时存储与节点池 */
async function makePool() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subbridge-pool-'));
  return { pool: new NodePool(new FileStore(dir)), dir };
}

test('NodePool upsert：新增节点与来源标注', async () => {
  const { pool } = await makePool();
  const nodes = [
    { name: 'A', type: 'ss', server: '1.1.1.1', port: 8388, source: 'https://sub.a.com/x' },
    { name: 'B', type: 'vmess', server: '2.2.2.2', port: 443, source: '文本输入' },
  ];
  const { added, updated } = await pool.upsert(nodes);
  assert.equal(added, 2);
  assert.equal(updated, 0);
  const list = await pool.list();
  assert.equal(list.length, 2);
  assert.equal(list.find((n) => n.server === '1.1.1.1').source, 'https://sub.a.com/x');
});

test('NodePool upsert：同名节点更新而非新增（不自动删除）', async () => {
  const { pool } = await makePool();
  await pool.upsert([{ name: 'A', type: 'ss', server: '1.1.1.1', port: 8388, source: 's1' }]);
  await pool.upsert([{ name: 'A2', type: 'ss', server: '1.1.1.1', port: 8388, source: 's2' }]);
  const list = await pool.list();
  assert.equal(list.length, 1, '同键节点应更新而非新增');
  assert.equal(list[0].name, 'A2');
  assert.equal(list[0].source, 's2', '来源应更新为最新抓取来源');
  assert.ok(list[0].firstSeen <= list[0].updatedAt, 'firstSeen 不应晚于 updatedAt');
});

test('NodePool 持久化：写入后可重新加载', async () => {
  const { pool, dir } = await makePool();
  await pool.upsert([{ name: 'A', type: 'ss', server: '1.1.1.1', port: 8388 }]);
  const pool2 = new NodePool(new FileStore(dir));
  const list = await pool2.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'A');
});

test('NodePool 保留 raw（links/v2ray 目标输出依赖）与 enabled 默认值', async () => {
  const { pool } = await makePool();
  await pool.upsert([{ name: 'A', type: 'ss', server: '1.1.1.1', port: 8388, raw: 'ss://xxx' }]);
  const list = await pool.list();
  assert.equal(list[0].raw, 'ss://xxx', 'raw 原始链接应入库保留');
  assert.equal(list[0].enabled, true, '新节点默认启用');
  await pool.upsert([{ name: 'A', type: 'ss', server: '1.1.1.1', port: 8388, defaultEnabled: false }]);
  assert.equal((await pool.list())[0].enabled, true, '更新不改变既有启用状态');
});

test('NodePool 开关与批量设置（质量门槛自动开关）', async () => {
  const { pool } = await makePool();
  await pool.upsert([{ name: 'A', type: 'ss', server: '1.1.1.1', port: 8388 }]);
  await pool.toggle('ss:1.1.1.1:8388', false);
  assert.equal((await pool.list({ enabled: false })).length, 1, '停用节点可被过滤查出');
  assert.equal((await pool.list({ enabled: true })).length, 0);
  await pool.bulkSetEnabled([['ss:1.1.1.1:8388', true]]);
  assert.equal((await pool.list({ enabled: true })).length, 1);
});

test('NodePool updateProbe：检测结果写回', async () => {
  const { pool } = await makePool();
  await pool.upsert([{ name: 'A', type: 'ss', server: '1.1.1.1', port: 8388 }]);
  const key = nodeKey({ type: 'ss', server: '1.1.1.1', port: 8388 });
  await pool.updateProbe({ [key]: { alive: true, latencyMs: 88, speedBps: 1024, testedAt: '2026-01-01T00:00:00Z' } });
  const list = await pool.list();
  assert.equal(list[0].probe.alive, true);
  assert.equal(list[0].probe.latencyMs, 88);
});

test('NodePool remove / clear：仅显式删除', async () => {
  const { pool } = await makePool();
  await pool.upsert([
    { name: 'A', type: 'ss', server: '1.1.1.1', port: 8388 },
    { name: 'B', type: 'vmess', server: '2.2.2.2', port: 443 },
  ]);
  const removed = await pool.remove([nodeKey({ type: 'ss', server: '1.1.1.1', port: 8388 })]);
  assert.equal(removed, 1);
  assert.equal((await pool.list()).length, 1);
  await pool.clear();
  assert.equal((await pool.list()).length, 0);
});
