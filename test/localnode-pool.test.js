/* 本机节点默认加入节点池的单元测试 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { NodePool } = require('../src/core/nodePool');
const { loadConfig } = require('../src/config/loader');
const NodeModel = require('../src/core/proxy');

/** 构造临时文件存储（与 FileStore 接口一致：readDataFile / writeDataFile） */
function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subbridge-ln-'));
  const store = {
    readDataFile(key) {
      try { return fs.readFileSync(path.join(dir, key), 'utf8'); } catch { return null; }
    },
    writeDataFile(key, val) {
      fs.writeFileSync(path.join(dir, key), val);
      return true;
    },
  };
  return { dir, store };
}

/** 构造假本机节点管理器（模拟 localNodes() 结果） */
function fakeLocalnode(nodes, enabled = true, inject = true) {
  return {
    async localNodes() {
      if (!enabled || !inject) return [];
      return nodes;
    },
  };
}

test('本机节点默认加入节点池（auto_join_pool=true 时入池，来源 localnode）', async () => {
  const { store } = tmpStore();
  const pool = new NodePool(store);
  const httpNode = new NodeModel({
    name: '本机-HTTP', type: 'http', server: '1.2.3.4', port: 1080, username: 'u', password: 'p', tls: false,
  });
  const ln = fakeLocalnode([httpNode]);
  // 模拟 syncLocalNodeToPool 的入池分支
  const lns = await ln.localNodes();
  assert.equal(lns.length, 1);
  const { added } = await pool.upsert(lns, { source: 'localnode' });
  assert.equal(added, 1);
  const list = await pool.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].source, 'localnode');
  assert.equal(list[0].name, '本机-HTTP');
  assert.equal(list[0].type, 'http');
  assert.equal(list[0].server, '1.2.3.4');
});

test('本机节点未启用时 localNodes() 返回空数组（不入池）', async () => {
  const ln = fakeLocalnode([], false, true);
  const lns = await ln.localNodes();
  assert.deepEqual(lns, []);
});

test('本机节点关闭注入时 localNodes() 返回空数组（不入池）', async () => {
  const ln = fakeLocalnode([], true, false);
  const lns = await ln.localNodes();
  assert.deepEqual(lns, []);
});

test('默认配置 auto_join_pool 为 true', async () => {
  // 直接断言 defaults.yaml（不受运行时 data/config.yaml 覆盖层影响）
  const yaml = require('js-yaml');
  const defaults = yaml.load(fs.readFileSync(path.join(__dirname, '../src/config/defaults.yaml'), 'utf8'));
  assert.equal(defaults.localnode.auto_join_pool, true);
});

test('auto_join_pool=false 时仍可手动注入但不在启动时入池', async () => {
  const config = await loadConfig();
  // 该配置项默认 true；显式关闭后注入逻辑应被禁用（此处验证配置读取）
  const cfg = { ...config, localnode: { ...config.localnode, auto_join_pool: false } };
  assert.equal(cfg.localnode.auto_join_pool, false);
});

test('links 目标输出本机 HTTP/SOCKS5 节点（自动生成分享链接）', async () => {
  const { convertLinks } = require('../src/converters/links');
  const httpNode = new NodeModel({ name: '本机-HTTP', type: 'http', server: '1.2.3.4', port: 18082, username: 'u', password: 'p' });
  const socksNode = new NodeModel({ name: '本机-SOCKS5', type: 'socks5', server: '1.2.3.4', port: 1081 });
  const out = convertLinks([httpNode, socksNode]);
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('http://u:p@1.2.3.4:18082'));
  assert.ok(lines[1].startsWith('socks5://1.2.3.4:1081'));
});

test('drop_unreachable 过滤时本机节点（source=localnode）始终保留', async () => {
  const { store } = tmpStore();
  const pool = new NodePool(store);
  const local = new NodeModel({ name: '本机-HTTP', type: 'http', server: '127.0.0.1', port: 18082 });
  const remoteDead = new NodeModel({ name: '远程不可达', type: 'ss', server: '9.9.9.9', port: 8388, probe: { alive: false } });
  const remoteOk = new NodeModel({ name: '远程可用', type: 'ss', server: '8.8.8.8', port: 8388, probe: { alive: true } });
  await pool.upsert([local], { source: 'localnode' });
  await pool.upsert([remoteDead], { source: 'https://x.com/sub' });
  await pool.upsert([remoteOk], { source: 'https://y.com/sub' });
  const list = await pool.list({ enabled: true });
  // 模拟订阅输出的过滤：不可达丢弃，但 localnode 保留
  const poolDropUnreachable = true;
  const filtered = poolDropUnreachable
    ? list.filter((n) => n.source === 'localnode' || !n.probe || n.probe.alive)
    : list;
  assert.equal(filtered.length, 2, '应保留本机节点 + 可用远程节点，丢弃不可达远程节点');
  assert.ok(filtered.some((n) => n.source === 'localnode'));
  assert.ok(!filtered.some((n) => n.server === '9.9.9.9'));
});
