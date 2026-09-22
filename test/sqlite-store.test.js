'use strict';

/* SQLite 存储驱动单元测试（可选依赖 better-sqlite3，未安装时跳过） */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { createStore } = require('../src/store');

let hasSqlite = false;
try {
  require('better-sqlite3');
  hasSqlite = true;
} catch {
  /* 未安装则跳过 */
}

const skip = hasSqlite ? false : 'better-sqlite3 未安装，跳过 SQLite 驱动测试';

test('SQLite 驱动：读写配置 / 模板 / 数据文件 / 缓存', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sqlite-'));
  const store = createStore({ storage: { driver: 'sqlite' } }, dir);

  // 配置
  await store.writeConfig('server:\n  port: 9999\n');
  const cfg = await store.readConfig();
  assert.ok(cfg.includes('port: 9999'), '配置应可写回并读取');

  // 模板
  await store.writeTemplate('my-template', 'hello');
  const names = await store.listTemplates();
  assert.ok(names.includes('my-template'), '模板列表应包含新模板');
  assert.equal(await store.readTemplate('my-template'), 'hello');
  assert.equal(await store.readTemplate('../evil'), null, '非法模板名应拒绝');

  // 数据文件
  await store.writeDataFile('nodes.json', '[1,2,3]');
  assert.equal(await store.readDataFile('nodes.json'), '[1,2,3]');
  assert.equal(await store.readDataFile('../x'), null, '非法文件名应拒绝');

  // 缓存
  store.cacheSet('k', 7, 100);
  assert.equal(store.cacheGet('k'), 7);
  store.cacheDelete('k');
  assert.equal(store.cacheGet('k'), undefined);

  // 数据目录
  assert.ok(store.dataDir(), '应返回数据目录');
  assert.ok(fs.existsSync(path.join(dir, 'subbridge.sqlite')), 'sqlite 数据文件应存在');
});

test('SQLite 驱动：数据落库可跨实例读取（持久化）', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sqlite-persist-'));
  const s1 = createStore({ storage: { driver: 'sqlite' } }, dir);
  await s1.writeDataFile('persist.txt', 'persisted-value');

  // 新实例（模拟重启）读取同一数据库文件
  const s2 = createStore({ storage: { driver: 'sqlite' } }, dir);
  assert.equal(await s2.readDataFile('persist.txt'), 'persisted-value', '重启后数据应保留');
});
