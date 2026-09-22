'use strict';

/**
 * SubBridge Web 前台逻辑（原生 JS，无外部依赖）
 * 功能：订阅转换、订阅链接生成、运行时配置编辑、模板管理
 */

/* ============ 工具函数 ============ */
const $ = (id) => document.getElementById(id);

/** 统一 API 请求：自动附带接口令牌 */
async function apiFetch(url, options = {}) {
  const token = ($('api-token-input') ? $('api-token-input').value : '').trim();
  const headers = { ...(options.headers || {}) };
  if (token) headers['x-api-token'] = token;
  return fetch(url, { ...options, headers });
}

/** 轻提示 */
function toast(message, isError) {
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add('hidden'), 3000);
}

/** 从嵌套对象按点号路径取值 */
function getByPath(obj, dottedPath) {
  return dottedPath.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

/** 按点号路径写入嵌套对象 */
function setByPath(obj, dottedPath, value) {
  const parts = dottedPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {};
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
}

/* ============ Tab 切换 ============ */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $('panel-' + tab.dataset.tab).classList.add('active');
  });
});

/* ============ 订阅转换 ============ */

/** 收集转换表单参数（与 /convert 接口 query 一致） */
function collectConvertParams() {
  return {
    url: $('urls').value,
    target: $('target').value,
    name: $('name').value,
    include: $('include').value,
    exclude: $('exclude').value,
    prefix: $('prefix').value,
    suffix: $('suffix').value,
    sort: $('sort').value,
    udp: $('udp').value,
  };
}

/** 构造 /convert 完整 URL（供 Clash 等客户端订阅使用） */
function buildConvertUrl() {
  const params = collectConvertParams();
  const qs = Object.entries(params)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${location.origin}/convert${qs ? '?' + qs : ''}`;
}

/** 目标格式 -> 下载文件扩展名 */
function extForTarget(target) {
  return { clash: 'yaml', singbox: 'json', links: 'txt', v2ray: 'txt' }[target] || 'txt';
}

$('convert-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-convert');
  btn.disabled = true;
  btn.textContent = '转换中...';
  try {
    const url = buildConvertUrl();
    const resp = await apiFetch(url);
    const text = await resp.text();
    if (!resp.ok) {
      let message = text;
      try { message = JSON.parse(text).error || message; } catch { /* 非 JSON 错误原样展示 */ }
      throw new Error(message);
    }
    const warnings = resp.headers.get('x-subbridge-warnings');
    $('result').textContent = text;
    $('result-meta').textContent = warnings ? '⚠ ' + warnings : '转换成功';
    $('result-box').classList.remove('hidden');
  } catch (err) {
    toast('转换失败：' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '转 换';
  }
});

// 复制订阅链接
$('btn-copy-link').addEventListener('click', async () => {
  const url = buildConvertUrl();
  try {
    await navigator.clipboard.writeText(url);
    toast('订阅链接已复制：' + url);
  } catch {
    toast('复制失败，请手动复制：' + url, true);
  }
});

// 复制结果
$('btn-copy-result').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('result').textContent);
    toast('结果已复制');
  } catch {
    toast('复制失败', true);
  }
});

// 下载结果
$('btn-download').addEventListener('click', () => {
  const target = $('target').value;
  const blob = new Blob([$('result').textContent], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `subbridge-${Date.now()}.${extForTarget(target)}`;
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ============ 服务配置 ============ */

/** 配置表单字段描述（键 = 配置点号路径） */
const CONFIG_FIELDS = [
  { key: 'server.host', label: '监听地址', type: 'text' },
  { key: 'server.port', label: '监听端口', type: 'number' },
  { key: 'server.trust_proxy', label: '信任反向代理', type: 'bool' },
  { key: 'fetcher.timeout_seconds', label: '抓取超时（秒）', type: 'number' },
  { key: 'fetcher.retries', label: '抓取重试次数', type: 'number' },
  { key: 'fetcher.user_agent', label: '请求 User-Agent', type: 'text' },
  { key: 'fetcher.max_body_bytes', label: '内容大小上限（字节）', type: 'number' },
  { key: 'fetcher.max_concurrency', label: '并发抓取数', type: 'number' },
  { key: 'fetcher.upstream_proxy', label: '上游转发代理（http/https）', type: 'text' },
  { key: 'fetcher.block_private', label: 'SSRF 防护（拦截内网）', type: 'bool' },
  { key: 'converter.default_target', label: '默认目标格式', type: 'select', options: ['clash', 'singbox', 'links', 'v2ray'] },
  { key: 'converter.dedupe', label: '节点去重', type: 'bool' },
  { key: 'converter.udp', label: '节点默认 UDP', type: 'bool' },
  { key: 'converter.sort', label: '默认排序', type: 'select', options: ['', 'name', 'name_desc'] },
  { key: 'converter.include', label: '默认包含（正则）', type: 'text' },
  { key: 'converter.exclude', label: '默认排除（正则）', type: 'text' },
  { key: 'converter.rename_prefix', label: '默认名称前缀', type: 'text' },
  { key: 'converter.rename_suffix', label: '默认名称后缀', type: 'text' },
  { key: 'converter.skip_failed', label: '失败订阅跳过继续', type: 'bool' },
  { key: 'converter.clash.select_group_name', label: 'Clash 手动选择组名', type: 'text' },
  { key: 'converter.clash.auto_group_name', label: 'Clash 自动测速组名', type: 'text' },
  { key: 'converter.clash.url_test_url', label: '测速探测地址', type: 'text' },
  { key: 'converter.clash.url_test_interval', label: '测速间隔（秒）', type: 'number' },
  { key: 'security.api_token', label: '接口令牌（留空关闭鉴权）', type: 'text' },
  { key: 'logging.level', label: '日志级别', type: 'select', options: ['trace', 'debug', 'info', 'warn', 'error'] },
];

let currentConfig = null; // 最近一次加载的生效配置

/** 渲染配置表单 */
function renderConfigForm(config) {
  const box = $('config-fields');
  box.innerHTML = '';
  for (const field of CONFIG_FIELDS) {
    const value = getByPath(config, field.key);
    const wrap = document.createElement('div');
    wrap.className = 'field';

    const label = document.createElement('label');
    label.textContent = field.label;
    label.setAttribute('for', 'cfg-' + field.key.replace(/\./g, '-'));
    wrap.appendChild(label);

    let input;
    if (field.type === 'bool') {
      input = document.createElement('select');
      input.dataset.type = 'bool';
      for (const v of [true, false]) {
        const opt = document.createElement('option');
        opt.value = String(v);
        opt.textContent = v ? '开启' : '关闭';
        opt.selected = Boolean(value) === v;
        input.appendChild(opt);
      }
    } else if (field.type === 'select') {
      input = document.createElement('select');
      for (const v of field.options) {
        const opt = document.createElement('option');
        opt.value = String(v);
        opt.textContent = v === '' ? '（默认）' : v;
        opt.selected = String(value) === String(v);
        input.appendChild(opt);
      }
    } else {
      input = document.createElement('input');
      input.type = field.type === 'number' ? 'number' : 'text';
      if (value !== undefined && value !== null) input.value = String(value);
      if (field.key === 'security.api_token' && value) input.value = '******';
    }
    input.id = 'cfg-' + field.key.replace(/\./g, '-');
    input.dataset.key = field.key;
    wrap.appendChild(input);
    box.appendChild(wrap);
  }
}

/** 从表单收集配置片段（api_token 掩码值不提交） */
function collectConfigChanges() {
  const patch = {};
  document.querySelectorAll('#config-fields [data-key]').forEach((input) => {
    const key = input.dataset.key;
    let value = input.value;
    if (input.dataset.type === 'bool') value = value === 'true';
    else if (input.type === 'number' && value !== '') value = Number(value);
    if (key === 'security.api_token' && value === '******') return; // 未修改令牌，跳过
    setByPath(patch, key, value);
  });
  return patch;
}

// 加载配置
async function loadConfig() {
  try {
    const resp = await apiFetch('/api/config');
    if (!resp.ok) throw new Error('加载配置失败（HTTP ' + resp.status + '）');
    const data = await resp.json();
    currentConfig = data.config;
    renderConfigForm(currentConfig);
  } catch (err) {
    toast(err.message, true);
  }
}

// 保存配置
$('btn-save-config').addEventListener('click', async () => {
  try {
    const patch = collectConfigChanges();
    const resp = await apiFetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '保存失败');
    currentConfig = data.config;
    renderConfigForm(currentConfig);
    toast('配置已保存并生效');
  } catch (err) {
    toast('保存失败：' + err.message, true);
  }
});

$('btn-reload-config').addEventListener('click', loadConfig);

/* ============ 模板管理 ============ */

/** 加载模板列表 */
async function loadTemplateList() {
  try {
    const resp = await apiFetch('/api/templates');
    if (!resp.ok) throw new Error('加载模板列表失败');
    const data = await resp.json();
    const select = $('template-select');
    select.innerHTML = '';
    for (const name of data.files) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

// 加载选中模板
$('btn-tpl-load').addEventListener('click', async () => {
  const name = $('template-select').value;
  if (!name) return toast('请先选择模板', true);
  try {
    const resp = await apiFetch('/api/templates/' + encodeURIComponent(name));
    if (!resp.ok) throw new Error('模板不存在');
    const data = await resp.json();
    $('template-editor').value = data.content;
    toast('已加载模板：' + name);
  } catch (err) {
    toast(err.message, true);
  }
});

// 保存模板
$('btn-tpl-save').addEventListener('click', async () => {
  const name = $('template-select').value;
  if (!name) return toast('请先选择模板', true);
  try {
    const resp = await apiFetch('/api/templates/' + encodeURIComponent(name), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: $('template-editor').value }),
    });
    if (!resp.ok) throw new Error('保存失败');
    toast('模板已保存：' + name);
  } catch (err) {
    toast(err.message, true);
  }
});

/* ============ 初始化 ============ */
loadConfig();
loadTemplateList();
