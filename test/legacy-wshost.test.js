"use strict";
const test = require('node:test');
const assert = require('node:assert');
const clash = require('../src/converters/clash');
const { NodePool } = require('../src/core/nodePool');

test('旧数据缺 wsHost 的 vless 节点，转换 Clash 时自动补全 ws-opts Host 头', async () => {
  const ctx = {
    config: {
      converter: { clash: { unique_names: true } },
    },
    templatesDir: require('node:path').join(__dirname, '../templates'),
    store: {
      readTemplate: async () => null,
      readDataFile: async () => null,
      writeDataFile: async () => {},
    },
  };
  const legacyNode = {
    name: '旧节点',
    type: 'vless',
    server: '1.2.3.4',
    port: 443,
    tls: true,
    sni: 'proxy.example.com',
    network: 'ws',
    wsPath: '/',
    uuid: 'u',
    raw: 'vless://u@1.2.3.4:443?security=tls&type=ws&host=proxy.example.com&path=%2F',
    // 没有 wsHost —— 模拟旧备份数据
  };
  const out = await clash.convert([legacyNode], { name: 'test' }, ctx);
  assert.match(out, /Host: proxy\.example\.com/, 'ws-opts.headers.Host 必须存在');
  assert.match(out, /proxy\.example\.com/, 'servername 应回退到 host');
});

test('NodePool.load 对缺 wsHost 的旧节点自动补全', async () => {
  const store = {
    readDataFile: async () => JSON.stringify({
      'vless:1.2.3.4:443': {
        name: 'x', type: 'vless', server: '1.2.3.4', port: 443,
        network: 'ws', raw: 'vless://u@1.2.3.4:443?type=ws&host=cdn.example.com',
      },
    }),
    writeDataFile: async () => {},
  };
  const pool = new NodePool(store);
  const data = await pool.load();
  assert.equal(data['vless:1.2.3.4:443'].wsHost, 'cdn.example.com');
});
