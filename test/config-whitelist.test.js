"use strict";
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const { ALLOWED_TOP_KEYS } = require('../src/config/loader');

test('配置白名单覆盖 defaults.yaml 全部顶层键（防止参数表保存被静默丢弃）', () => {
  const text = fs.readFileSync(path.join(__dirname, '../src/config/defaults.yaml'), 'utf8');
  const doc = yaml.load(text);
  const missing = Object.keys(doc).filter((k) => !ALLOWED_TOP_KEYS.has(k));
  assert.deepEqual(missing, [], `默认配置顶层键未在白名单: ${missing.join(', ')}`);
});
