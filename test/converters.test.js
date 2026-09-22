'use strict';

/**
 * 转换器与管道单元测试
 * 覆盖：Clash YAML 生成、sing-box JSON 生成、links/v2ray 输出、过滤/去重/排序/重命名。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const Proxy = require('../src/core/proxy');
const pipeline = require('../src/core/pipeline');
const clashConverter = require('../src/converters/clash');
const singboxConverter = require('../src/converters/singbox');
const linksConverter = require('../src/converters/links');
const { FileStore } = require('../src/store/fileStore');

// 最小化上下文（模板目录指向内置 templates/，存储用临时目录）
const ctx = {
  config: {
    converter: {
      clash: {
        select_group_name: 'PROXY',
        auto_group_name: 'AUTO',
        url_test_url: 'http://www.gstatic.com/generate_204',
        url_test_interval: 300,
      },
      rules_file: 'rules.tmpl.txt',
    },
  },
  templatesDir: `${__dirname}/../templates`,
  store: new FileStore(`${__dirname}/../.tmp-test-store`),
};

// 构造测试节点
function makeNodes() {
  return [
    new Proxy({ name: 'B-ss', type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-256-gcm', password: 'p1' }),
    new Proxy({ name: 'A-vmess', type: 'vmess', server: '5.6.7.8', port: 443, uuid: '11111111-2222-3333-4444-555555555555', alterId: 0, cipher: 'auto', network: 'ws', wsPath: '/ws', wsHost: 'cdn.x.com', tls: true, sni: 'cdn.x.com' }),
    new Proxy({ name: 'A-vmess', type: 'vmess', server: '5.6.7.8', port: 443, uuid: '11111111-2222-3333-4444-555555555555', raw: '' }), // 重复节点
    new Proxy({ name: 'C-trojan', type: 'trojan', server: '9.9.9.9', port: 443, password: 'pw', sni: 't.com', raw: 'trojan://pw@9.9.9.9:443#C-trojan' }),
    new Proxy({ name: 'D-hy2', type: 'hysteria2', server: '8.8.8.8', port: 443, password: 'h', sni: 'h.com' }),
  ];
}

test('Clash 转换输出合法 YAML 且包含节点与策略组', async () => {
  const nodes = pipeline.applyPipeline(makeNodes(), {});
  const out = await clashConverter.convert(nodes, { name: 'test-sub' }, ctx);
  const doc = yaml.load(out);
  assert.ok(Array.isArray(doc.proxies), 'proxies 应为数组');
  assert.equal(doc.proxies.length, 4, '重复节点应被去重');
  assert.ok(Array.isArray(doc['proxy-groups']), 'proxy-groups 应为数组');
  assert.equal(doc['proxy-groups'].length, 2, '应包含 AUTO 与 PROXY 两个策略组');
  assert.ok(doc.rules.some((r) => r.includes('MATCH,PROXY')), '规则应引用手动选择组');
  // 验证 vmess 字段映射
  const vmess = doc.proxies.find((p) => p.type === 'vmess');
  assert.equal(vmess.uuid, '11111111-2222-3333-4444-555555555555');
  assert.equal(vmess.tls, true);
  assert.equal(vmess['ws-opts'].path, '/ws');
  assert.equal(vmess['ws-opts'].headers.Host, 'cdn.x.com');
});

test('Clash 转换支持策略组名覆盖', async () => {
  const nodes = pipeline.applyPipeline(makeNodes(), {});
  const out = await clashConverter.convert(nodes, { selectGroupName: '选择', autoGroupName: '自动' }, ctx);
  const doc = yaml.load(out);
  assert.ok(doc['proxy-groups'].some((g) => g.name === '选择'));
  assert.ok(doc['proxy-groups'].some((g) => g.name === '自动'));
});

test('sing-box 转换输出合法 JSON', async () => {
  const nodes = pipeline.applyPipeline(makeNodes(), {});
  const out = singboxConverter.convert(nodes, {});
  const doc = JSON.parse(out);
  assert.ok(Array.isArray(doc.outbounds));
  assert.equal(doc.outbounds.length, 4);
  const types = new Set(doc.outbounds.map((o) => o.type));
  assert.ok(types.has('shadowsocks'));
  assert.ok(types.has('vmess'));
  assert.ok(types.has('trojan'));
  assert.ok(types.has('hysteria2'));
});

test('links / v2ray 输出', () => {
  const nodes = makeNodes();
  const plain = linksConverter.convertLinks(nodes);
  assert.ok(plain.includes('trojan://pw@9.9.9.9:443#C-trojan'));
  assert.ok(!plain.includes('1.2.3.4'), '无原始链接的节点应被跳过');
  const encoded = linksConverter.convertV2Ray(nodes);
  const decoded = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/') + '==', 'base64').toString('utf8');
  assert.ok(decoded.includes('trojan://'));
});

test('管道：过滤', () => {
  const nodes = makeNodes();
  // include=vmess|trojan 命中 A-vmess×2（含重复）与 C-trojan；exclude=trojan 排除 C-trojan
  const filtered = pipeline.filterNodes(nodes, { include: 'vmess|trojan', exclude: 'trojan' });
  assert.equal(filtered.length, 2);
  assert.ok(filtered.every((n) => n.type === 'vmess'));
});

test('管道：去重', () => {
  const nodes = makeNodes();
  const deduped = pipeline.dedupeNodes(nodes);
  assert.equal(deduped.length, 4);
});

test('管道：排序', () => {
  const nodes = makeNodes();
  const sorted = pipeline.sortNodes(nodes, 'name');
  assert.equal(sorted[0].name, 'A-vmess');
  assert.equal(sorted[sorted.length - 1].name, 'D-hy2');
});

test('管道：重命名', () => {
  const nodes = makeNodes();
  const renamed = pipeline.renameNodes(nodes, { prefix: '[P] ', suffix: ' -X' });
  assert.equal(renamed[0].name, '[P] B-ss -X');
});

test('管道：非法正则抛出明确错误', () => {
  assert.throws(() => pipeline.filterNodes(makeNodes(), { include: '[' }), /无效的正则/);
});
