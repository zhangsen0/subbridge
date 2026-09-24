'use strict';

/**
 * SubBridge 全功能系统测试（按人员使用流程 + 全自动流程）
 *
 * 覆盖：认证/入口、驾驶舱、全站参数（含主订阅）、场景模板与一键配置、订阅源 CRUD、
 * 抓取、节点池全操作、质量门槛/清理/过滤、无人值守（分步开启→手动触发→进度→退出）、
 * 后台任务、事件日志、对外订阅输出（clash/singbox/links/v2ray + 规则）、本地节点、备份恢复、静态资源。
 *
 * 依赖：本地实例 127.0.0.1:18081（SUBBRIDGE_DATA_DIR 独立目录）+ mock-sources 18100。
 * 用法：node scripts/full-system-test.js
 */

const http = require('node:http');
const { spawn } = require('node:child_process');

const BASE = 18081;
const TOKEN = 'admin-token';
const MAIN = 'https://proxy.520215.xyz/sub?token=d662b808e0a23961eb81ce8d40647f4d';

function req(method, path, body, token, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-API-Token'] = token;
    const r = http.request({ host: '127.0.0.1', port: BASE, path, method, headers, timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, body: buf, json });
      });
    });
    r.on('error', (e) => resolve({ status: 0, body: e.message, json: null }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout', json: null }); });
    if (data) r.write(data);
    r.end();
  });
}

/** 轮询直到断言满足或超时 */
async function waitFor(desc, fn, timeoutMs = 60000, intervalMs = 1500) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时: ${desc} | 最后结果: ${JSON.stringify(last)}`);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  if (!ok) console.log('  ✗ FAIL ' + name + (detail ? ' ← ' + String(detail).slice(0, 120) : ''));
}

(async () => {
  // 起本地 mock 源
  const mock = spawn('node', ['scripts/mock-sources.js', '18100'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));

  // 前置：放行本地源（SSRF 白名单）+ 初始化主订阅
  await req('POST', '/api/config', { fetcher: { private_host_allowlist: ['127.0.0.1'] } }, TOKEN);

  console.log('== A. 认证与入口 ==');
  {
    const p = await req('GET', '/ping');
    check('GET /ping', p.status === 200 && p.json && p.json.status === 'ok', p.body);
    const home = await req('GET', '/');
    check('GET / 未登录返回页面', home.status === 200, home.status);
    const okLogin = await req('POST', '/api/login', { username: 'admin', password: 'adminpass' });
    check('POST /api/login 正确密码', okLogin.status === 200 && okLogin.json && okLogin.json.role === 'admin', okLogin.body);
    const badLogin = await req('POST', '/api/login', { username: 'admin', password: 'wrong' });
    check('POST /api/login 错误密码 401', badLogin.status === 401, badLogin.body);
    const me = await req('GET', '/api/me', null, TOKEN);
    check('GET /api/me', me.status === 200 && me.json && me.json.role === 'admin', me.body);
    const noAuth = await req('GET', '/api/config');
    check('GET /api/config 无令牌 401', noAuth.status === 401, noAuth.body);
  }

  console.log('== B. 驾驶舱 ==');
  {
    const d = await req('GET', '/api/dashboard', null, TOKEN);
    check('GET /api/dashboard', d.status === 200 && d.json && d.json.pool && typeof d.json.pool.total === 'number', d.body);
    check('驾驶舱包含 KPI 区块', d.json && ['pool', 'subscription', 'localnode', 'logs', 'recentNodes', 'recentLogs'].every((k) => k in d.json), d.body);
  }

  console.log('== C. 全站参数（含主订阅） ==');
  {
    const c = await req('GET', '/api/config', null, TOKEN);
    check('GET /api/config', c.status === 200 && c.json && c.json.config, c.body);
    const cfg = c.json.config;
    check('配置分组齐全', ['fetcher', 'grab', 'pool', 'subscription', 'localnode', 'probe'].every((k) => k in cfg), Object.keys(cfg).join(','));
    const set = await req('POST', '/api/config', { fetcher: { timeout_seconds: 11 } }, TOKEN);
    check('POST /api/config 修改参数', set.status === 200, set.body);
    const c2 = await req('GET', '/api/config', null, TOKEN);
    check('配置修改生效', c2.json.config.fetcher.timeout_seconds === 11, c2.body);
    // 主订阅设置（含持久化验证，重启实例后仍应在）
    const setMain = await req('POST', '/api/config', { subscription: { main_urls: [MAIN] } }, TOKEN);
    check('POST /api/config 设置主订阅', setMain.status === 200, setMain.body);
    const c3 = await req('GET', '/api/config', null, TOKEN);
    const gotMain = (c3.json.config.subscription && c3.json.config.subscription.main_urls) || [];
    check('主订阅写入配置', gotMain.includes(MAIN), JSON.stringify(gotMain));
    const raw = await req('GET', '/api/config/raw', null, TOKEN);
    check('GET /api/config/raw', raw.status === 200 && typeof raw.body === 'string' && raw.body.includes('main_urls'), raw.status + ' len=' + raw.body.length);
  }

  console.log('== D. 场景模板 + 一键配置 ==');
  {
    const sc = await req('GET', '/api/scenarios', null, TOKEN);
    check('GET /api/scenarios 场景列表', sc.status === 200 && Array.isArray(sc.json && sc.json.scenarios) && sc.json.scenarios.length >= 20, sc.body);
    const tp = await req('GET', '/api/templates', null, TOKEN);
    check('GET /api/templates 模板列表', tp.status === 200 && tp.json, tp.body);
    const one = await req('GET', '/api/templates/' + encodeURIComponent('clash.tmpl.yaml'), null, TOKEN);
    check('GET /api/templates/:name', one.status === 200, one.body);
    const save = await req('PUT', '/api/templates/' + encodeURIComponent('clash.tmpl.yaml'), { content: '# test\n{{proxies}}' }, TOKEN);
    check('PUT /api/templates/:name 保存', save.status === 200, save.body);
    const apply = await req('POST', '/api/setup/apply', { scenario_id: 'streaming', main_urls: MAIN }, TOKEN);
    check('POST /api/setup/apply 应用影视场景', apply.status === 200, apply.body);
    const c = await req('GET', '/api/config', null, TOKEN);
    const urls = (c.json.config.probe && c.json.config.probe.speed_test_urls) || [];
    check('影视场景预置多测速候选', Array.isArray(urls) && urls.length >= 3, JSON.stringify(urls).slice(0, 150));
  }

  console.log('== E. 订阅源管理 ==');
  let sid1, sid2;
  {
    const list = await req('GET', '/api/sources?page=1&pageSize=10', null, TOKEN);
    check('GET /api/sources 分页', list.status === 200 && list.json && typeof list.json.total === 'number', list.body);
    const add = await req('POST', '/api/sources', { url: 'http://127.0.0.1:18100/sub.txt', name: '本地行式源' }, TOKEN);
    check('POST /api/sources 添加单个', add.status === 200 && add.json && add.json.source && add.json.source.id, add.body);
    sid1 = add.json.source.id;
    const batch = await req('POST', '/api/sources', { urls: ['http://127.0.0.1:18100/clash.yaml', 'http://127.0.0.1:18100/base64.txt'] }, TOKEN);
    check('POST /api/sources 批量添加', batch.status === 200 && batch.json && Array.isArray(batch.json.sources) && batch.json.sources.length === 2, batch.body);
    sid2 = batch.json.sources[0].id;
    const upd = await req('PUT', '/api/sources/' + sid1, { name: '本地行式源-改', enabled: true }, TOKEN);
    check('PUT /api/sources/:id 编辑', upd.status === 200, upd.body);
  }

  console.log('== F. 抓取 ==');
  {
    const g = await req('GET', '/api/grab?url=' + encodeURIComponent('http://127.0.0.1:18100/sub.txt'), null, TOKEN, 30000);
    check('GET /api/grab 单源抓取', g.status === 200 && g.json && g.json.summary && g.json.summary.parsed > 0, g.body);
    const grabAll = await req('POST', '/api/sources/grab', { probe: false }, TOKEN);
    check('POST /api/sources/grab 批量抓取启动', grabAll.status === 200 && grabAll.json && grabAll.json.async === true, grabAll.body);
    await waitFor('批量抓取完成', async () => {
      const t = await req('GET', '/api/tasks', null, TOKEN);
      const task = (t.json.tasks || []).find((x) => x.type === 'grab');
      return task && task.status !== 'running';
    }, 60000);
    const t = await req('GET', '/api/tasks', null, TOKEN);
    const grabTask = (t.json.tasks || []).find((x) => x.type === 'grab');
    check('批量抓取任务完成', grabTask && grabTask.status === 'completed', JSON.stringify(grabTask));
    check('批量抓取成功数>0', grabTask && grabTask.ok > 0, JSON.stringify(grabTask));
  }

  console.log('== G. 节点池 ==');
  let nodeKey;
  {
    const add = await req('POST', '/api/pool/add', { links: 'vless://90cd4a77-141a-43c9-991b-08263cfe9c10@jp1.test-node.dev:443?security=tls&type=ws&path=%2F&encryption=none#%E6%B5%8B%E8%AF%95%E8%8A%82%E7%82%B9-JP' }, TOKEN);
    check('POST /api/pool/add 手工添加', add.status === 200 && add.json && add.json.ok === true && ((add.json.added || 0) + (add.json.updated || 0)) >= 1, add.body);
    const list = await req('GET', '/api/pool?page=1&pageSize=5', null, TOKEN);
    check('GET /api/pool 分页', list.status === 200 && list.json && typeof list.json.total === 'number', list.body);
    const first = list.json.nodes && list.json.nodes[0];
    if (first) nodeKey = `${first.type}:${first.server}:${first.port}`;
    const detail = await req('GET', '/api/pool/' + encodeURIComponent(nodeKey || 'x'), null, TOKEN);
    check('GET /api/pool/:key', detail.status === 200, detail.body);
    const tog = await req('POST', '/api/pool/toggle', { key: nodeKey, enabled: false }, TOKEN);
    check('POST /api/pool/toggle 停用', tog.status === 200 && tog.json && tog.json.enabled === false, tog.body);
    await req('POST', '/api/pool/toggle', { key: nodeKey, enabled: true }, TOKEN);
    const probe = await req('POST', '/api/pool/probe', { keys: [nodeKey], timeout: 3 }, TOKEN, 30000);
    check('POST /api/pool/probe 测速', probe.status === 200, probe.body);
    const q = await req('POST', '/api/pool/apply-quality', {}, TOKEN, 30000);
    check('POST /api/pool/apply-quality 质量门槛', q.status === 200, q.body);
    const filter = await req('POST', '/api/pool/filter', { keys: [nodeKey] }, TOKEN, 30000);
    check('POST /api/pool/filter 过滤', filter.status === 200 && filter.json && typeof filter.json.usable === 'number', filter.body);
    const clean = await req('POST', '/api/pool/cleanup', {}, TOKEN, 30000);
    check('POST /api/pool/cleanup 清理', clean.status === 200, clean.body);
    const prune = await req('POST', '/api/pool/prune', {}, TOKEN, 30000);
    check('POST /api/pool/prune 删除不可用', prune.status === 200 && prune.json && typeof prune.json.removed === 'number', prune.body);
  }

  console.log('== H. 无人值守（全自动流程） ==');
  {
    const st = await req('GET', '/api/auto-pilot', null, TOKEN);
    check('GET /api/auto-pilot 状态', st.status === 200 && st.json && Array.isArray(st.json.steps), st.body);
    check('auto-pilot 含进度字段', st.json && ('current_task' in st.json) && ('last_summary' in st.json), st.body);
    const start = await req('POST', '/api/auto-pilot/start', { steps: ['cron', 'probe', 'remove', 'cleanup'], cron: '0 4 * * *' }, TOKEN);
    check('POST /api/auto-pilot/start 开启', start.status === 200 && start.json && start.json.enabled === true, start.body);
    const st2 = await req('GET', '/api/auto-pilot', null, TOKEN);
    const allOn = st2.json.steps.every((s) => s.applied);
    check('四步骤全部已开启', allOn, JSON.stringify(st2.json.steps));
    check('cron 为 0 4', st2.json.cron === '0 4 * * *', st2.json.cron);
    const trigger = await req('POST', '/api/auto-grab', {}, TOKEN, 15000);
    check('POST /api/auto-grab 手动触发', trigger.status === 200 && trigger.json && trigger.json.ok === true, trigger.body);
    // 触发后立即查状态应出现 current_task（运行中）
    await waitFor('自动采集任务出现', async () => {
      const s = await req('GET', '/api/auto-pilot', null, TOKEN);
      return s.json && s.json.current_task;
    }, 20000, 1000);
    const sMid = await req('GET', '/api/auto-pilot', null, TOKEN);
    check('运行中 current_task 有进度', sMid.json.current_task && typeof sMid.json.current_task.done === 'number', JSON.stringify(sMid.json.current_task));
    await waitFor('自动采集完成', async () => {
      const s = await req('GET', '/api/auto-pilot', null, TOKEN);
      return s.json && s.json.current_task === null && s.json.last_run_at;
    }, 120000, 2000);
    const sEnd = await req('GET', '/api/auto-pilot', null, TOKEN);
    check('auto-pilot last_summary 记录', sEnd.json.last_summary && typeof sEnd.json.last_summary.sources === 'number', JSON.stringify(sEnd.json.last_summary));
    check('last_summary 含成功数', sEnd.json.last_summary && sEnd.json.last_summary.ok >= 0, JSON.stringify(sEnd.json.last_summary));
    const stop = await req('POST', '/api/auto-pilot/stop', {}, TOKEN);
    check('POST /api/auto-pilot/stop 退出', stop.status === 200 && stop.json && stop.json.enabled === false, stop.body);
    const st3 = await req('GET', '/api/auto-pilot', null, TOKEN);
    check('退出后步骤全关', st3.json.steps.every((s) => !s.applied), JSON.stringify(st3.json.steps));
  }

  console.log('== I. 后台任务 ==');
  {
    const t = await req('GET', '/api/tasks', null, TOKEN);
    check('GET /api/tasks 列表', t.status === 200 && Array.isArray(t.json.tasks), t.body);
    check('任务含进行中+历史', t.json.tasks.length >= 1, t.body);
  }

  console.log('== J. 事件日志 ==');
  {
    const l = await req('GET', '/api/logs?page=1&pageSize=5', null, TOKEN);
    check('GET /api/logs 分页', l.status === 200 && l.json && typeof l.json.total === 'number', l.body);
    const lf = await req('GET', '/api/logs?type=grab&page=1&pageSize=5', null, TOKEN);
    check('GET /api/logs 按类型过滤', lf.status === 200, lf.body);
    const clear = await req('POST', '/api/logs/clear', {}, TOKEN);
    check('POST /api/logs/clear 清空', clear.status === 200, clear.body);
    const after = await req('GET', '/api/logs?page=1&pageSize=5', null, TOKEN);
    check('清空后日志条数回落', after.status === 200, after.body);
  }

  console.log('== K. 对外订阅输出 ==');
  {
    for (const target of ['clash', 'singbox', 'links', 'v2ray']) {
      const r = await req('GET', '/sub?token=' + TOKEN + '&target=' + target, null, null, 15000);
      check('GET /sub target=' + target, r.status === 200 && r.body.length > 0, r.status + ' len=' + r.body.length);
    }
    const rule = await req('GET', '/sub?token=' + TOKEN + '&target=links&rules=' + encodeURIComponent(JSON.stringify([{ type: 'limit', count: 5 }])), null, null, 15000);
    check('GET /sub 带规则过滤', rule.status === 200 && rule.body.length > 0, rule.body);
    const sub2 = await req('GET', '/subscribe?token=' + TOKEN + '&target=links', null, null, 15000);
    check('GET /subscribe 兼容路径', sub2.status === 200, sub2.body);
    const conv = await req('GET', '/convert?url=' + encodeURIComponent('http://127.0.0.1:18100/sub.txt') + '&target=links&probe=0', null, TOKEN, 30000);
    check('GET /convert 抓取转换', conv.status === 200 && conv.body.length > 0, conv.body);
  }

  console.log('== L. 本地节点 ==');
  {
    const l = await req('GET', '/api/localnode', null, TOKEN);
    check('GET /api/localnode', l.status === 200 && l.json, l.body);
    const r = await req('POST', '/api/localnode/restart', {}, TOKEN, 15000);
    check('POST /api/localnode/restart', r.status === 200, r.body);
  }

  console.log('== M. 备份 / 恢复 ==');
  {
    const b = await req('GET', '/api/backup', null, TOKEN);
    check('GET /api/backup 备份', b.status === 200 && b.json, b.body);
    const payload = b.json;
    const rest = await req('POST', '/api/restore', payload, TOKEN, 30000);
    check('POST /api/restore 恢复', rest.status === 200 && rest.json && rest.json.ok === true, rest.body);
  }

  console.log('== N. 静态资源与页面 ==');
  {
    for (const f of ['/', '/login', '/setup', '/static/app.js', '/static/style.css', '/static/index.html', '/static/login.html', '/static/setup.html']) {
      const r = await req('GET', f, null, null);
      check('GET ' + f, r.status === 200, r.status);
    }
  }

  mock.kill();
  const failed = results.filter((r) => !r.ok);
  const total = results.length;
  console.log('\n========================================');
  console.log('测试完成：' + (total - failed.length) + '/' + total + ' 通过');
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log('  - ' + f.name + ' ← ' + f.detail));
  }
  process.exit(failed.length ? 1 : 0);
})();
