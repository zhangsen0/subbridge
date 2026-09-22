'use strict';

/** 节点质量判定与自动开关测试 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGates, evaluateGates, qualityScore } = require('../src/core/quality');

/** 构造测试节点 */
function makeNode(name, probe) {
  return { name, type: 'ss', server: 'a.example.com', port: 8388, probe };
}

test('parseGates：JSON / YAML / 非法输入', () => {
  assert.equal(parseGates('[{"type":"latency","max_ms":300}]').length, 1);
  assert.equal(parseGates('- type: alive').length, 1);
  assert.deepEqual(parseGates(''), []);
  assert.deepEqual(parseGates('bad'), []);
});

test('qualityScore：按可用性/延迟/速度加权', () => {
  assert.equal(qualityScore(makeNode('无数据')), null);
  const good = makeNode('好', { alive: true, latencyMs: 60, speedBps: 10 * 1024 * 1024 });
  assert.equal(qualityScore(good), 100);
  const dead = makeNode('死', { alive: false });
  assert.equal(qualityScore(dead), 0);
});

test('evaluateGates：all 模式全通过才算合格，未测放行', () => {
  const nodes = [
    makeNode('好', { alive: true, latencyMs: 80, speedBps: 3 * 1024 * 1024 }),
    makeNode('慢', { alive: true, latencyMs: 900, speedBps: 3 * 1024 * 1024 }),
    makeNode('未测'),
    makeNode('死', { alive: false, latencyMs: 0 }),
  ];
  const { pass, fail } = evaluateGates(nodes, [
    { type: 'alive' },
    { type: 'latency', max_ms: 500 },
    { type: 'speed', min_bps: 1024 * 1024 },
  ], { mode: 'all', defaultPass: true });
  assert.deepEqual(pass.map((n) => n.name), ['好', '未测']);
  assert.deepEqual(fail.map((n) => n.name), ['慢', '死']);
});

test('evaluateGates：any 模式任一通过即合格', () => {
  const nodes = [
    makeNode('死但快', { alive: false, latencyMs: 50 }),
    makeNode('活着但慢', { alive: true, latencyMs: 900 }),
  ];
  const { pass, fail } = evaluateGates(nodes, [
    { type: 'alive' },
    { type: 'latency', max_ms: 100 },
  ], { mode: 'any', defaultPass: false });
  assert.deepEqual(pass.map((n) => n.name), ['死但快', '活着但慢']);
  assert.equal(fail.length, 0);
});

test('evaluateGates：门槛可单独停用（enabled:false）且默认开启', () => {
  const nodes = [makeNode('慢', { alive: true, latencyMs: 900 })];
  const { pass } = evaluateGates(nodes, [
    { type: 'latency', max_ms: 100, enabled: false },
  ], { mode: 'all', defaultPass: true });
  assert.equal(pass.length, 1, '被停用的门槛不应生效');
});

test('evaluateGates：score 门槛', () => {
  const nodes = [
    makeNode('优秀', { alive: true, latencyMs: 60, speedBps: 8 * 1024 * 1024 }),
    makeNode('较差', { alive: true, latencyMs: 900, speedBps: 10 * 1024 }),
  ];
  const { pass } = evaluateGates(nodes, [{ type: 'score', min_score: 60 }], { mode: 'all', defaultPass: true });
  assert.deepEqual(pass.map((n) => n.name), ['优秀']);
});

test('evaluateGates：无门槛时全部通过', () => {
  const { pass, fail } = evaluateGates([makeNode('A')], [], { mode: 'all' });
  assert.equal(pass.length, 1);
  assert.equal(fail.length, 0);
});
