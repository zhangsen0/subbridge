'use strict';

/**
 * 内置模板测试：验证 defaults.yaml 中 presets 段的全部模板
 * 都能被规则引擎 / 质量门槛 / 清理引擎正确解析并执行（不报错、有产出）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const yaml = require('js-yaml');
const fs = require('node:fs');
const { parseRules, applyRules } = require('../src/core/rules');
const { parseGates, evaluateGates } = require('../src/core/quality');
const { parseCleanupRules, evaluateCleanup } = require('../src/core/cleanup');

const defaults = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'defaults.yaml'), 'utf8'));
const presets = (defaults && defaults.presets) || {};

// 造一批带探测数据的节点（覆盖可用/不可用/快/慢/港台/美国/测试名）
const sampleNodes = [
  { name: '香港-01', type: 'vless', server: 'h1.example.com', port: 443, countryCode: 'HK', source: 'https://a.com/sub', probe: { alive: true, latencyMs: 120, speedBps: 6000000 } },
  { name: '台湾-02', type: 'vmess', server: 't2.example.com', port: 443, countryCode: 'TW', source: 'https://a.com/sub', probe: { alive: true, latencyMs: 260, speedBps: 2000000 } },
  { name: '美国-03', type: 'ss', server: 'u3.example.com', port: 8388, countryCode: 'US', source: 'https://b.com/x', probe: { alive: true, latencyMs: 480, speedBps: 800000 } },
  { name: '日本-04', type: 'trojan', server: 'j4.example.com', port: 443, countryCode: 'JP', source: 'https://b.com/x', probe: { alive: false, latencyMs: null, speedBps: null } },
  { name: '测试-节点', type: 'ss', server: 'x5.example.com', port: 8388, countryCode: 'CN', source: '文本输入', probe: { alive: true, latencyMs: 1500, speedBps: 30000 } },
];

test('内置模板：订阅选取规则全部可解析且能执行', () => {
  const rulesPresets = (presets.rules || {});
  assert.ok(Object.keys(rulesPresets).length >= 5, '至少内置 5 套订阅规则模板');
  for (const [id, item] of Object.entries(rulesPresets)) {
    const rules = parseRules(item.value);
    assert.ok(rules.length > 0, `模板 ${id} 规则应非空`);
    const out = applyRules(sampleNodes, rules);
    assert.ok(Array.isArray(out), `模板 ${id} 执行结果应为数组`);
  }
});

test('内置模板：质量门槛全部可解析且能执行', () => {
  const qualityPresets = (presets.quality_gates || {});
  assert.ok(Object.keys(qualityPresets).length >= 3, '至少内置 3 套质量门槛模板');
  for (const [id, item] of Object.entries(qualityPresets)) {
    const gates = parseGates(item.value);
    assert.ok(gates.length > 0, `模板 ${id} 门槛应非空`);
    const result = evaluateGates(sampleNodes, gates, { mode: 'all', defaultPass: true });
    assert.ok(Array.isArray(result.pass) && Array.isArray(result.fail), `模板 ${id} 执行结果结构错误`);
  }
});

test('内置模板：清理规则全部可解析且能执行', () => {
  const cleanupPresets = (presets.cleanup_rules || {});
  assert.ok(Object.keys(cleanupPresets).length >= 3, '至少内置 3 套清理规则模板');
  for (const [id, item] of Object.entries(cleanupPresets)) {
    const rules = parseCleanupRules(item.value);
    assert.ok(rules.length > 0, `模板 ${id} 规则应非空`);
    const toRemove = evaluateCleanup(sampleNodes, rules);
    assert.ok(Array.isArray(toRemove), `模板 ${id} 执行结果应为数组`);
  }
});
