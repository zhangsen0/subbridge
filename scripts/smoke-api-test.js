// 全功能接口测试
const http = require('node:http');
function req(method, path, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-API-Token'] = token;
    const r = http.request({ host: '127.0.0.1', port: 18081, path, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', (e) => resolve({ status: 0, body: e.message }));
    if (data) r.write(data);
    r.end();
  });
}
(async () => {
  const T = 'admin-token';
  const out = [];
  const t = async (name, fn) => {
    try { const r = await fn(); out.push([name, r.status, (r.body || '').slice(0, 60)]); }
    catch (e) { out.push([name, 'ERR', e.message]); }
  };
  // 认证
  await t('POST /api/login 账号密码', () => req('POST', '/api/login', { username: 'admin', password: 'adminpass' }));
  await t('POST /api/login 错误密码', () => req('POST', '/api/login', { username: 'admin', password: 'wrong' }));
  await t('GET /api/me', () => req('GET', '/api/me', null, T));
  // 驾驶舱
  await t('GET /api/dashboard', () => req('GET', '/api/dashboard', null, T));
  // 节点池
  await t('GET /api/pool?limit=3', () => req('GET', '/api/pool?limit=3', null, T));
  await t('POST /api/pool/probe 空测速', () => req('POST', '/api/pool/probe', { limit: 3, timeout: 5 }, T));
  await t('GET /api/pool/nodes 导出', () => req('GET', '/api/pool/nodes', null, T));
  // 抓取（本地源）
  await t('GET /api/grab 本地源', () => req('GET', '/api/grab?url=http%3A%2F%2F127.0.0.1%3A18099%2Fsub.txt', null, T));
  // 规则
  await t('GET /api/rules 规则列表', () => req('GET', '/api/rules', null, T));
  await t('POST /api/rules 保存规则', () => req('POST', '/api/rules', { rules: [{ type: 'limit', count: 10 }] }, T));
  await t('GET /sub?target=links&rules=1', () => req('GET', '/sub?target=links&rules=1', null, T));
  // 质量门槛
  await t('POST /api/quality/apply', () => req('POST', '/api/quality/apply', { mode: 'all', rules: [{ type: 'alive' }] }, T));
  // 清理
  await t('POST /api/cleanup/apply', () => req('POST', '/api/cleanup/apply', { rules: [] }, T));
  // 日志
  await t('GET /api/logs?limit=5', () => req('GET', '/api/logs?limit=5', null, T));
  await t('POST /api/logs/clear', () => req('POST', '/api/logs/clear', {}, T));
  // 配置
  await t('GET /api/config', () => req('GET', '/api/config', null, T));
  await t('POST /api/config 改超时', () => req('POST', '/api/config', { fetcher: { timeout_seconds: 12 } }, T));
  await t('GET /api/config 确认生效', () => req('GET', '/api/config', null, T));
  // 模板
  await t('GET /api/templates', () => req('GET', '/api/templates', null, T));
  await t('PUT /api/templates 保存', () => req('PUT', '/api/templates/clash', { content: '# test\n{{proxies}}' }, T));
  // 预设模板
  await t('GET /api/presets', () => req('GET', '/api/presets', null, T));
  // 备份
  await t('GET /api/backup', () => req('GET', '/api/backup', null, T));
  // 本地节点
  await t('GET /api/localnode/status', () => req('GET', '/api/localnode/status', null, T));
  await t('GET /api/tunnel/status', () => req('GET', '/api/tunnel/status', null, T));
  // 订阅输出
  await t('GET /sub?target=clash', () => req('GET', '/sub?target=clash', null, null));
  await t('GET /sub?target=singbox', () => req('GET', '/sub?target=singbox', null, null));
  await t('GET /sub?target=v2ray', () => req('GET', '/sub?target=v2ray', null, null));
  await t('GET /sub 无token', () => req('GET', '/sub', null, null));
  // 无权限
  await t('GET /api/config 无令牌', () => req('GET', '/api/config', null, null));
  // 静态
  await t('GET /static/app.js', () => req('GET', '/static/app.js'));
  // 恢复日志（避免清空影响展示）
  await req('POST', '/api/logs/clear', {}, T);
  await t('GET /api/logs 清空后', () => req('GET', '/api/logs?limit=3', null, T));
  out.forEach(([n, s, b]) => console.log(String(s).padStart(4) + ' ' + n + (s >= 400 ? ' ← ' + b.replace(/\n/g, ' ').slice(0, 80) : '')));
  const bad = out.filter(([, s]) => s === 0 || s >= 500);
  console.log('\n失败数:', bad.length, '/', out.length);
  process.exit(0);
})();
