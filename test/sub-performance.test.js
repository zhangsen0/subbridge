'use strict';

/* /sub 拉取性能测试：拉取订阅必须秒回，绝不同步测速（用户强约束）
 *
 * 验证点：
 *   1. /sub 首拉（主订阅本地文件源，async_refresh 异步刷新）响应时间 < 2s
 *   2. /sub 缓存命中响应时间 < 300ms（节点池 500 节点规模）
 *   3. /sub 全链路不触发同步测速（响应头 / 日志无 probe 痕迹）
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 18093;
const TOKEN = 'perf-token';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-perf-'));
const SUB_FILE = path.join(DATA, 'sub.txt');

// 本地文件订阅源：40 个 vmess 节点（可被 fetcher 读取，无需外网）
function makeSub() {
  const lines = [];
  for (let i = 0; i < 40; i++) {
    const uuid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    lines.push(`vmess://${Buffer.from(JSON.stringify({
      v: '2', ps: `节点${i}`, add: `10.0.0.${i % 250 + 1}`, port: 443 + (i % 20),
      id: uuid, aid: 0, scy: 'auto', net: 'tcp', type: 'none',
    })).toString('base64')}`);
  }
  return lines.join('\n');
}

test('测试准备：生成订阅文件与初始配置', () => {
  fs.writeFileSync(SUB_FILE, makeSub());
  fs.writeFileSync(
    path.join(DATA, 'config.yaml'),
    [
      'storage:',
      '  driver: file',
      'subscription:',
      '  main_urls:',
      `    - file://${SUB_FILE}`,
      '  async_refresh: true',
      '  cache_seconds: 60',
      '  include_pool: true',
      'fetcher:',
      '  upstream_proxy: ""',
      'probe:',
      '  enabled: false',
    ].join('\n'),
  );
  assert.ok(fs.existsSync(SUB_FILE));
});

test('/sub 拉取性能：首拉 <2s、缓存命中 <300ms、不同步测速', async () => {
  const child = spawn(process.execPath, ['app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      SUBBRIDGE_DATA_DIR: DATA,
      SUBBRIDGE_API_TOKEN: TOKEN,
      SUBBRIDGE_LOCALNODE_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', (d) => { logs += d.toString(); });

  // 等待就绪
  const base = `http://127.0.0.1:${PORT}`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/ping`);
      if (res.ok) { ready = true; break; }
    } catch { /* 未就绪继续等 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(ready, '实例应在 15s 内就绪');

  try {
    // 先向池里塞 500 个节点（模拟大规模节点池）
    const nodes = [];
    for (let i = 0; i < 500; i++) {
      nodes.push(`vmess://${Buffer.from(JSON.stringify({
        v: '2', ps: `池节点${i}`, add: `10.1.${Math.floor(i / 250)}.${i % 250 + 1}`, port: 1000 + (i % 5000),
        id: `11111111-2222-4333-8444-${String(i).padStart(12, '0')}`, aid: 0, scy: 'auto', net: 'tcp', type: 'none',
      })).toString('base64')}`);
    }
    const addRes = await fetch(`${base}/api/pool/add`, {
      method: 'POST',
      headers: { 'X-API-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: nodes.join('\n') }),
    });
    assert.equal(addRes.status, 200, '节点池添加应成功');

    // 首次 /sub 拉取（async_refresh 异步，不应被主订阅拖慢）
    const t0 = Date.now();
    const r1 = await fetch(`${base}/sub?token=${TOKEN}`);
    const firstMs = Date.now() - t0;
    assert.equal(r1.status, 200, `/sub 首拉应 200（实际 ${r1.status}）`);
    const body1 = await r1.text();
    assert.ok(body1.length > 100, '首拉应返回订阅内容');
    assert.ok(firstMs < 2000, `首拉应在 2s 内返回（实际 ${firstMs}ms）`);

    // 等待异步刷新完成 + 缓存写入
    await new Promise((r) => setTimeout(r, 1500));

    // 缓存命中：应远快于首拉
    const t1 = Date.now();
    const r2 = await fetch(`${base}/sub?token=${TOKEN}`);
    const cachedMs = Date.now() - t1;
    assert.equal(r2.status, 200);
    assert.ok(cachedMs < 300, `缓存命中应在 300ms 内返回（实际 ${cachedMs}ms）`);

    // 二次带规则拉取（规则解析+应用，也应快速返回）
    const t2 = Date.now();
    const r3 = await fetch(`${base}/sub?token=${TOKEN}&rules=${encodeURIComponent(JSON.stringify([{ type: 'type', value: ['vmess'] }, { type: 'limit', count: 10 }]))}`);
    const rulesMs = Date.now() - t2;
    assert.equal(r3.status, 200);
    assert.ok(rulesMs < 500, `带规则拉取应在 500ms 内返回（实际 ${rulesMs}ms）`);

    // 全链路不同步测速：日志中不应出现 probe/测速执行痕迹
    const probeInLogs = /probe|测速/.test(logs);
    assert.ok(!probeInLogs, '日志中不应出现测速执行痕迹');

    console.log(`[perf] 首拉 ${firstMs}ms / 缓存命中 ${cachedMs}ms / 带规则 ${rulesMs}ms`);
  } finally {
    child.kill('SIGTERM');
  }
});
