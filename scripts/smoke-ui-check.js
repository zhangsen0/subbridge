// 无头浏览器 UI 冒烟：加载页面、检查关键元素、走登录、验证接口
const { spawn } = require('node:child_process');
const http = require('node:http');
function get(path, token) {
  return new Promise((resolve) => {
    const headers = token ? { 'X-API-Token': token } : {};
    http.get({ host: '127.0.0.1', port: 18081, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', (e) => resolve({ status: 0, body: e.message }));
  });
}
function post(path, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-API-Token'] = token;
    const r = http.request({ host: '127.0.0.1', port: 18081, path, method: 'POST', headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', (e) => resolve({ status: 0, body: e.message }));
    if (data) r.write(data);
    r.end();
  });
}
(async () => {
  // 1. 页面结构
  const page = await get('/');
  const checks = [
    ['首页含顶栏品牌', page.body.includes('SubBridge')],
    ['含侧边导航', page.body.includes('nav-item')],
    ['含驾驶舱面板', page.body.includes('panel-grab')],
    ['含节点库面板', page.body.includes('panel-pool')],
    ['含全站参数面板', page.body.includes('panel-config')],
    ['含内置模板选择器(rules)', page.body.includes('rules-preset')],
    ['含内置模板选择器(quality)', page.body.includes('quality-preset')],
    ['含内置模板选择器(cleanup)', page.body.includes('cleanup-preset')],
  ];
  checks.forEach(([n, ok]) => console.log((ok ? 'PASS' : 'FAIL') + ' ' + n));
  // 2. 登录接口（无令牌应 401；GET 不存在，用 POST）
  const login = await post('/api/login', { username: 'admin', password: 'adminpass' }, '');
  console.log('登录接口(无令牌应401):', login.status);
  // 3. 预置模板接口
  const presets = await get('/api/presets', 'admin-token');
  const pd = JSON.parse(presets.body);
  console.log('模板接口:', presets.status, 'rules=' + pd.rules.length, 'quality=' + pd.quality_gates.length, 'cleanup=' + pd.cleanup_rules.length);
  // 4. 驾驶舱
  const dash = await get('/api/dashboard', 'admin-token');
  const dd = JSON.parse(dash.body);
  console.log('驾驶舱:', dash.status, 'poolTotal=' + (dd.pool ? dd.pool.total : '?'), 'logTotal=' + (dd.logs ? dd.logs.total : '?'));
  // 5. 节点库
  const pool = await get('/api/pool', 'admin-token');
  const pp = JSON.parse(pool.body);
  console.log('节点库:', pool.status, 'nodes=' + (pp.nodes ? pp.nodes.length : '?'));
  // 6. 订阅输出（links）
  const sub = await get('/sub?target=links&token=admin-token', '');
  console.log('订阅links:', sub.status, '行数=' + sub.body.split('\n').filter(Boolean).length);
  // 7. 日志
  const logs = await get('/api/logs?limit=5', 'admin-token');
  const ll = JSON.parse(logs.body);
  console.log('事件日志:', logs.status, 'entries=' + (ll.logs ? ll.logs.length : '?'));
  // 8. 配置
  const cfg = await get('/api/config', 'admin-token');
  console.log('配置:', cfg.status);
  process.exit(0);
})();
