'use strict';

/**
 * 存储层单元测试
 * 覆盖：file 驱动的配置/模板/生成文件读写、缓存 TTL、文件名安全校验、驱动工厂。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileStore } = require('../src/store/fileStore');
const { createStore } = require('../src/store');

/** 创建临时数据目录并返回 FileStore */
async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subbridge-store-'));
  return { store: new FileStore(dir), dir };
}

test('FileStore 配置读写', async () => {
  const { store, dir } = await makeStore();
  assert.equal(await store.readConfig(), null, '初始无覆盖配置');

  await store.writeConfig('server:\n  port: 9090\n');
  assert.equal(await store.readConfig(), 'server:\n  port: 9090\n');

  // 文件确实落在数据目录
  const onDisk = await fs.readFile(path.join(dir, 'config.yaml'), 'utf8');
  assert.equal(onDisk, 'server:\n  port: 9090\n');
});

test('FileStore 模板读写与列表', async () => {
  const { store } = await makeStore();
  assert.deepEqual(await store.listTemplates(), []);

  await store.writeTemplate('clash.tmpl.yaml', 'proxies: {{proxies}}');
  assert.equal(await store.readTemplate('clash.tmpl.yaml'), 'proxies: {{proxies}}');
  assert.deepEqual(await store.listTemplates(), ['clash.tmpl.yaml']);
  assert.equal(await store.readTemplate('not-exist.yaml'), null);
});

test('FileStore 生成文件读写', async () => {
  const { store } = await makeStore();
  assert.equal(await store.readDataFile('cf-tunnel.yml'), null);
  await store.writeDataFile('cf-tunnel.yml', 'tunnel: uuid-123\n');
  assert.equal(await store.readDataFile('cf-tunnel.yml'), 'tunnel: uuid-123\n');
});

test('FileStore 文件名安全校验（防路径穿越）', async () => {
  const { store } = await makeStore();
  for (const bad of ['../evil.yaml', 'a/b.yaml', '.hidden', '..']) {
    await assert.rejects(() => store.writeTemplate(bad, 'x'), `应拒绝非法模板名: ${bad}`);
    assert.equal(await store.readTemplate(bad), null, `应拒绝读取非法模板名: ${bad}`);
  }
  await assert.rejects(() => store.writeDataFile('../evil.yml', 'x'));
});

test('FileStore 缓存 TTL', async () => {
  const { store } = await makeStore();
  assert.equal(store.cacheGet('k1'), undefined);

  store.cacheSet('k1', { a: 1 }, 1);
  assert.deepEqual(store.cacheGet('k1'), { a: 1 });

  // 已过期
  store.cacheSet('k1', { a: 1 }, 0);
  assert.deepEqual(store.cacheGet('k1'), { a: 1 }, 'ttl=0 表示不过期');
  store.cacheSet('k2', { b: 2 }, -1);
  assert.deepEqual(store.cacheGet('k2'), { b: 2 }, '负 ttl 按不过期处理');

  store.cacheDelete('k1');
  assert.equal(store.cacheGet('k1'), undefined);
});

test('createStore 按驱动选择实现', () => {
  const store = createStore({ storage: { driver: 'file' } }, '/tmp/subbridge-x');
  assert.ok(store instanceof FileStore);
  assert.equal(store.dataDir(), '/tmp/subbridge-x');

  // 未配置驱动时默认 file
  assert.ok(createStore({}, '/tmp/subbridge-x') instanceof FileStore);

  // 不支持的驱动必须报错（避免静默降级）
  assert.throws(
    () => createStore({ storage: { driver: 'postgres' } }, '/tmp/subbridge-x'),
    /不支持的存储驱动/,
  );
});
