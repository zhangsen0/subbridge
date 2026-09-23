/* 抓取来源管理（表格增删改查）与日期变量/后缀解析单元测试 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { SourceStore } = require('../src/core/sourceStore');
const { expandDateVariables, parseSourceOptions } = require('../src/core/sourceOptions');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subbridge-src-'));
  const store = {
    readDataFile(key) {
      try { return fs.readFileSync(path.join(dir, key), 'utf8'); } catch { return null; }
    },
    writeDataFile(key, val) { fs.writeFileSync(path.join(dir, key), val); return true; },
  };
  return { dir, store };
}

function fakeConfig(extra = []) {
  return { subscription: { extra_sources: extra } };
}

test('日期变量展开：{Y_m_d} / {Ymd} / {Y} / {m} / {d}', () => {
  const base = new Date(2026, 8, 23); // 2026-09-23
  assert.equal(expandDateVariables('https://x.com/{Y_m_d}/a.yaml', base), 'https://x.com/2026_09_23/a.yaml');
  assert.equal(expandDateVariables('https://x.com/{Ymd}.yaml', base), 'https://x.com/20260923.yaml');
  assert.equal(expandDateVariables('https://x.com/{Y}/{m}/{Ymd}', base), 'https://x.com/2026/09/20260923');
  assert.equal(expandDateVariables('https://x.com/{Y-m-d}', base), 'https://x.com/2026-09-23');
});

test('来源后缀解析：url|links 与 url|ss 拆分为 url + suffix', () => {
  const a = parseSourceOptions('https://a.com/x.txt|links');
  assert.equal(a.url, 'https://a.com/x.txt');
  assert.equal(a.suffix, 'links');
  const b = parseSourceOptions('https://b.com/ss/sub|ss');
  assert.equal(b.suffix, 'ss');
  const c = parseSourceOptions('https://c.com/plain');
  assert.equal(c.suffix, '');
});

test('SourceStore：新增/编辑/删除 + 与 extra_sources 双向同步', async () => {
  const { store } = tmpStore();
  const saved = [];
  const ss = new SourceStore(store, fakeConfig(['https://old.com/sub']), async (patch) => {
    saved.push(patch.subscription.extra_sources.slice());
  });
  // 旧配置链接自动并入（等待异步加载完成）
  await ss.ready();
  const list0 = ss.list();
  assert.equal(list0.length, 1);
  assert.equal(list0[0].url, 'https://old.com/sub');
  assert.equal(list0[0].auto, true);
  // 新增
  const item = await ss.add({ url: 'https://new.com/sub', note: '测试源' });
  assert.ok(item.id);
  assert.equal(ss.list().length, 2);
  // 同步写回配置
  assert.ok(saved.some((arr) => arr.includes('https://new.com/sub')));
  // 编辑（停用）
  await ss.update(item.id, { enabled: false });
  const after = ss.list().find((s) => s.id === item.id);
  assert.equal(after.enabled, false);
  // 删除
  await ss.remove(item.id);
  assert.equal(ss.list().length, 1);
});
