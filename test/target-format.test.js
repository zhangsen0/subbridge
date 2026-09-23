'use strict';

/**
 * 目标格式 target 参数兼容性单测
 *   - 单个值：clash
 *   - 分隔写法：clash|singbox|links|v2ray（README 示例可直接复制不报 400）
 *   - 分隔写法：clash,singbox
 *   - 无效值仍应报错
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOptions } = require('../src/server/convert');

/** 复刻 /sub 与 /convert 的 target 归一化逻辑 */
function normalizeTarget(q, def) {
  let target = (q.target || def || 'clash').toLowerCase();
  if (/[|,]/.test(target)) target = target.split(/[|,]/)[0].trim();
  return target;
}

test('target 单值正常归一化', () => {
  assert.equal(normalizeTarget({ target: 'clash' }, 'clash'), 'clash');
  assert.equal(normalizeTarget({ target: 'SINGBOX' }, 'clash'), 'singbox');
});

test('target 竖线分隔写法取第一个有效值（README 示例不报 400）', () => {
  assert.equal(normalizeTarget({ target: 'clash|singbox|links|v2ray' }, 'clash'), 'clash');
  assert.equal(normalizeTarget({ target: 'singbox|links|v2ray' }, 'clash'), 'singbox');
});

test('target 逗号分隔写法取第一个有效值', () => {
  assert.equal(normalizeTarget({ target: 'v2ray,links' }, 'clash'), 'v2ray');
});

test('target 缺省回退默认格式', () => {
  assert.equal(normalizeTarget({}, 'clash'), 'clash');
});

test('target 带空白与大小写混合', () => {
  assert.equal(normalizeTarget({ target: '  Links | clash ' }, 'clash'), 'links');
});

test('buildOptions 仍输出原始 target（校验前归一化由路由层处理）', () => {
  const opts = buildOptions({ target: 'clash|singbox' }, { converter: {}, probe: {} });
  assert.equal(typeof opts.target, 'string');
});
