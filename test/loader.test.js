'use strict';

/**
 * 配置加载器单元测试
 * 覆盖：默认配置合并、运行时覆盖持久化（updateConfig）、整体替换（replaceConfig）、
 *      存储层读取、环境变量覆盖、脱敏。
 * 注意：本文件在独立进程中运行（node --test 文件级隔离），可安全修改环境变量。
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

// 使用临时数据目录，避免污染项目 data/
const TMP_DIR = path.join(os.tmpdir(), `subbridge-loader-${process.pid}`);

before(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
  await fs.mkdir(TMP_DIR, { recursive: true });
  process.env.SUBBRIDGE_DATA_DIR = TMP_DIR;
});

test('loadConfig 合并默认配置与运行时覆盖', async () => {
  const { loadConfig } = require('../src/config/loader');

  // 写入运行时覆盖
  await fs.writeFile(
    path.join(TMP_DIR, 'config.yaml'),
    yaml.dump({ server: { port: 18081 } }),
    'utf8',
  );

  const config = await loadConfig();
  assert.equal(config.server.port, 18081, '运行时覆盖应生效');
  assert.equal(config.fetcher.block_private, true, '默认配置应保留');
  assert.equal(config.storage.driver, 'file', '存储驱动默认 file');
  assert.equal(config.localnode.http_port, 1080);
});

test('updateConfig 持久化并立即生效', async () => {
  const { loadConfig, updateConfig, getConfig, getStore } = require('../src/config/loader');
  await loadConfig();

  await updateConfig({ converter: { default_target: 'singbox' }, probe: { enabled: true } });
  assert.equal(getConfig().converter.default_target, 'singbox');
  assert.equal(getConfig().probe.enabled, true);

  // 持久化到存储层（data/config.yaml）
  const onDisk = await getStore().readConfig();
  const parsed = yaml.load(onDisk);
  assert.equal(parsed.converter.default_target, 'singbox');
  assert.equal(parsed.probe.enabled, true);
});

test('updateConfig 拒绝白名单外的顶层键', async () => {
  const { loadConfig, updateConfig, getConfig } = require('../src/config/loader');
  await loadConfig();

  await updateConfig({ evil_key: 1, server: { port: 18082 } });
  assert.equal(getConfig().evil_key, undefined, '非法顶层键不应写入');
  assert.equal(getConfig().server.port, 18082, '合法键正常生效');
});

test('replaceConfig 整体替换覆盖层（迁移语义）', async () => {
  const { loadConfig, updateConfig, replaceConfig, getConfig, getStore } = require('../src/config/loader');
  await loadConfig();

  await updateConfig({ probe: { enabled: true }, server: { port: 18083 } });
  // 整体替换：以新对象为唯一覆盖层，旧键清空后回到默认值
  await replaceConfig({ subscription: { cache_seconds: 120 } });

  assert.equal(getConfig().probe.enabled, false, '旧覆盖键应被清除（回到默认）');
  assert.equal(getConfig().server.port, 8080, '旧覆盖键被清除后应回到默认端口');
  assert.equal(getConfig().subscription.cache_seconds, 120, '新覆盖层生效');

  const parsed = yaml.load(await getStore().readConfig());
  assert.deepEqual(Object.keys(parsed), ['subscription'], '覆盖文件仅含新覆盖层');
});

test('maskSecrets 掩码令牌与代理密码', async () => {
  const { maskSecrets } = require('../src/config/loader');
  const masked = maskSecrets({
    security: { api_token: 'secret-a', user_token: 'secret-b' },
    fetcher: { upstream_proxy: 'http://u:p@host:8080' },
  });
  assert.equal(masked.security.api_token, '******');
  assert.equal(masked.security.user_token, '******');
  assert.match(masked.fetcher.upstream_proxy, /u:\*\*\*\*\*\*@host:8080/);
});
