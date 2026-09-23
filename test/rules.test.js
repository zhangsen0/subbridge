'use strict';

/** 节点选取规则引擎测试 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRules, applyRules } = require('../src/core/rules');

/** 构造测试节点 */
function makeNode(name, extra = {}) {
  return { name, type: 'ss', server: 'a.example.com', port: 8388, source: 'https://s.example.com/sub', ...extra };
}

test('parseRules：支持 JSON 数组文本', () => {
  const rules = parseRules('[{"type":"limit","count":5}]');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].type, 'limit');
  assert.equal(rules[0].count, 5);
});

test('parseRules：支持 YAML 数组文本', () => {
  const rules = parseRules('- type: limit\n  count: 3\n- type: include\n  pattern: "HK"');
  assert.equal(rules.length, 2);
  assert.equal(rules[1].pattern, 'HK');
});

test('parseRules：非法输入返回空数组', () => {
  assert.deepEqual(parseRules(''), []);
  assert.deepEqual(parseRules('not-a-rule'), []);
  assert.deepEqual(parseRules(null), []);
});

test('applyRules：include / exclude 按名称正则筛选', () => {
  const nodes = [makeNode('香港-A'), makeNode('日本-B'), makeNode('HK-测试')];
  const out = applyRules(nodes, [
    { type: 'include', pattern: '香港|HK' },
    { type: 'exclude', pattern: '测试' },
  ]);
  assert.deepEqual(out.map((n) => n.name), ['香港-A']);
});

test('applyRules：type / source 筛选', () => {
  const nodes = [
    makeNode('A', { type: 'vmess' }),
    makeNode('B', { type: 'trojan', source: 'https://other.example.com/x' }),
  ];
  const out = applyRules(nodes, [
    { type: 'type', value: ['vmess', 'trojan'] },
    { type: 'source', pattern: 'other.example.com' },
  ]);
  assert.deepEqual(out.map((n) => n.name), ['B']);
});

test('applyRules：latency 上限（未测不满足，剔除）+ sort + limit 组合', () => {
  const nodes = [
    makeNode('慢', { probe: { alive: true, latencyMs: 500 } }),
    makeNode('快', { probe: { alive: true, latencyMs: 80 } }),
    makeNode('未测'),
    makeNode('中', { probe: { alive: true, latencyMs: 200 } }),
  ];
  const out = applyRules(nodes, [
    { type: 'latency', max_ms: 300 },
    { type: 'sort', key: 'latency', order: 'asc' },
    { type: 'limit', count: 2 },
  ]);
  // 延迟排序：快(80) → 中(200) → 未测(视为无穷大)；取前 2
  assert.deepEqual(out.map((n) => n.name), ['快', '中']);
});

test('applyRules：country 国家筛选（大小写不敏感）', () => {
  const nodes = [makeNode('东京', { country: 'JP' }), makeNode('香港', { country: 'HK' })];
  const out = applyRules(nodes, [{ type: 'country', value: ['jp'] }]);
  assert.deepEqual(out.map((n) => n.name), ['东京']);
});

test('applyRules：speed 下限（未测节点不满足，剔除）', () => {
  const nodes = [
    makeNode('快', { probe: { alive: true, speedBps: 5000000 } }),
    makeNode('慢', { probe: { alive: true, speedBps: 100000 } }),
    makeNode('未测'),
  ];
  const out = applyRules(nodes, [{ type: 'speed', min_bps: 1000000 }]);
  assert.deepEqual(out.map((n) => n.name), ['快']);
});

test('applyRules：空规则列表原样返回', () => {
  const nodes = [makeNode('A')];
  assert.equal(applyRules(nodes, []).length, 1);
  assert.equal(applyRules(nodes, null).length, 1);
});
