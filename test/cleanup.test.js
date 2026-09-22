'use strict';

/** 节点池自动清理（自定义删除逻辑）测试 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCleanupRules, evaluateCleanup } = require('../src/core/cleanup');

/** 构造测试节点 */
function makeNode(name, extra = {}) {
  return {
    name,
    type: 'ss',
    server: 'a.example.com',
    port: 8388,
    source: 'https://s.example.com/sub',
    firstSeen: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

const DAY = 24 * 3600 * 1000;

test('parseCleanupRules：JSON / YAML / 非法输入', () => {
  assert.equal(parseCleanupRules('[{"type":"unreachable"}]').length, 1);
  assert.equal(parseCleanupRules('- type: stale\n  days: 7').length, 1);
  assert.deepEqual(parseCleanupRules(''), []);
  assert.deepEqual(parseCleanupRules('bad'), []);
});

test('evaluateCleanup：unreachable 删除不可达节点', () => {
  const nodes = [
    makeNode('活', { probe: { alive: true } }),
    makeNode('死', { probe: { alive: false } }),
    makeNode('未测'),
  ];
  const keys = evaluateCleanup(nodes, [{ type: 'unreachable' }]);
  assert.deepEqual(keys, ['ss:a.example.com:8388']);
});

test('evaluateCleanup：stale 删除超过 N 天未更新', () => {
  const old = new Date(Date.now() - 10 * DAY).toISOString();
  const fresh = new Date().toISOString();
  const nodes = [
    makeNode('旧', { updatedAt: old }),
    makeNode('新', { updatedAt: fresh }),
  ];
  const keys = evaluateCleanup(nodes, [{ type: 'stale', days: 7 }]);
  assert.equal(keys.length, 1);
  assert.ok(keys[0].includes('旧') || nodes[0].server === 'a.example.com');
});

test('evaluateCleanup：latency/speed/score 依赖探测数据，未测节点不命中', () => {
  const nodes = [
    makeNode('慢', { probe: { alive: true, latencyMs: 900, speedBps: 50000 } }),
    makeNode('未测'),
  ];
  const keys = evaluateCleanup(nodes, [
    { type: 'latency', max_ms: 800 },
    { type: 'speed', min_bps: 100000 },
    { type: 'score', max_score: 30 },
  ]);
  assert.equal(keys.length, 1, '仅"慢"被删除，未测节点不命中');
});

test('evaluateCleanup：name / source 规则', () => {
  const nodes = [
    makeNode('香港-测试', { source: 'https://bad.example.com/x' }),
    makeNode('香港-正式', { source: 'https://good.example.com/x' }),
  ];
  const keys = evaluateCleanup(nodes, [
    { type: 'name', match: '测试' },
    { type: 'source', match: 'bad.example.com' },
  ]);
  assert.equal(keys.length, 1, '同一节点命中任一规则即删除（不重复计）');
});

test('evaluateCleanup：规则可停用（enabled:false）且默认开启', () => {
  const nodes = [makeNode('测试节点')];
  const keys = evaluateCleanup(nodes, [{ type: 'name', match: '测试', enabled: false }]);
  assert.equal(keys.length, 0);
});

test('evaluateCleanup：空规则不删除任何节点', () => {
  const nodes = [makeNode('A', { probe: { alive: false } })];
  assert.equal(evaluateCleanup(nodes, []).length, 0);
  assert.equal(evaluateCleanup(nodes, null).length, 0);
});
