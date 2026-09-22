'use strict';

/**
 * SubBridge Web 前台逻辑（原生 JS，无外部依赖）
 * 功能：订阅转换、本机订阅源、本地节点管理、运行时配置编辑、模板管理
 */

/* ============ 工具函数 ============ */
const $ = (id) => document.getElementById(id);

/** HTML 转义（防止配置值注入） */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

/* ============ 亮 / 暗主题 ============ */
const THEME_STORAGE_KEY = 'subbridge-theme';

/** 应用主题并同步按钮文案（按钮文案 = 点击后将切换到的主题） */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('btn-theme');
  if (btn) btn.textContent = theme === 'dark' ? '亮色' : '暗色';
}

/** 初始化主题切换：当前主题已在 <head> 内联脚本设置，这里只挂载切换事件 */
function initTheme() {
  const btn = $('btn-theme');
  if (!btn) return;
  applyTheme(document.documentElement.dataset.theme || 'dark');
  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch (e) { /* 隐私模式忽略 */ }
    applyTheme(next);
  });
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

/* ============ 角色识别（多级用户） ============ */

let currentRole = 'unknown'; // unknown / admin / user

/**
 * 识别当前角色：管理员显示全部页签；普通用户仅保留订阅转换。
 * 同时按角色取得本机订阅源链接（携带对应令牌）。
 */
async function identifyRole() {
  try {
    const resp = await apiFetch('/api/me');
    if (!resp.ok) {
      // 401：令牌缺失或错误
      if (resp.status === 401) {
        currentRole = 'guest';
        toast('未授权：请在顶栏填写令牌', true);
        applyRoleUi();
        return;
      }
      throw new Error('识别角色失败（HTTP ' + resp.status + '）');
    }
    const data = await resp.json();
    currentRole = data.role || 'user';
    applyRoleUi();
    const urlInput = $('sub-source-url');
    if (urlInput && data.subscriptionUrl) urlInput.value = data.subscriptionUrl;
  } catch (err) {
    toast(err.message, true);
  }
}

/** 按角色调整界面：管理员全部页签；普通用户仅订阅转换 */
function applyRoleUi() {
  const isAdmin = currentRole === 'admin';
  document.querySelectorAll('.tab.admin-only').forEach((tab) => {
    tab.classList.toggle('hidden', !isAdmin);
  });
  // 非管理员时，若停留在受管页面则切回转换页
  if (!isAdmin) {
    const activeTab = document.querySelector('.tab.active');
    if (activeTab && activeTab.dataset.tab !== 'convert') {
      document.querySelector('.tab[data-tab="convert"]').click();
    }
  }
  if (currentRole === 'guest') {
    // 未授权：清空订阅链接占位
    const urlInput = $('sub-source-url');
    if (urlInput) urlInput.value = '';
  }
}

/* ============ 高级选项折叠（配置复杂度分级） ============ */

function initAdvancedToggle() {
  const toggle = $('advanced-toggle');
  if (!toggle) return;
  // 记住用户选择
  try {
    toggle.checked = localStorage.getItem('subbridge-advanced') === '1';
  } catch { /* 隐私模式下忽略 */ }
  applyAdvanced();
  toggle.addEventListener('change', () => {
    try {
      localStorage.setItem('subbridge-advanced', toggle.checked ? '1' : '0');
    } catch { /* 忽略 */ }
    applyAdvanced();
  });
}

function applyAdvanced() {
  const advanced = $('advanced-fields');
  if (advanced) advanced.classList.toggle('hidden', !$('advanced-toggle').checked);
}

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
    probe: $('probe').value,
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

/* ============ 配置字段定义 ============ */

/** 服务配置字段（键 = 配置点号路径；type: text/number/bool/select/list） */
const CONFIG_FIELDS = [
  { key: 'server.host', label: '监听地址', type: 'text' },
  { key: 'server.port', label: '监听端口', type: 'number' },
  { key: 'server.trust_proxy', label: '信任反向代理', type: 'bool' },
  { key: 'fetcher.timeout_seconds', label: '抓取超时（秒）', type: 'number' },
  { key: 'fetcher.retries', label: '抓取重试次数', type: 'number' },
  { key: 'fetcher.retry_base_ms', label: '重试退避初始（毫秒）', type: 'number' },
  { key: 'fetcher.retry_max_ms', label: '重试退避上限（毫秒）', type: 'number' },
  { key: 'fetcher.user_agent', label: '请求 User-Agent', type: 'text' },
  { key: 'fetcher.max_body_bytes', label: '内容大小上限（字节）', type: 'number' },
  { key: 'fetcher.max_concurrency', label: '并发抓取数', type: 'number' },
  { key: 'fetcher.upstream_proxy', label: '上游转发代理（http/https）', type: 'text' },
  { key: 'fetcher.relay_through_localnode', label: '抓取走本机节点自中继', type: 'bool' },
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
  { key: 'probe.enabled', label: '可用性检测默认开启', type: 'bool' },
  { key: 'probe.concurrency', label: '检测并发数', type: 'number' },
  { key: 'probe.timeout_ms', label: '单节点超时（毫秒）', type: 'number' },
  { key: 'probe.drop_unreachable', label: '剔除不可达节点', type: 'bool' },
  { key: 'probe.speed_test', label: 'http/socks5 节点真实测速', type: 'bool' },
  { key: 'probe.speed_test_url', label: '测速下载地址', type: 'text' },
  { key: 'probe.speed_test_bytes', label: '测速采样字节数', type: 'number' },
  { key: 'probe.append_latency', label: '延迟追加到节点名', type: 'bool' },
  { key: 'subscription.main_urls', label: '本机订阅源主订阅地址（每行一个）', type: 'list' },
  { key: 'subscription.default_target', label: '订阅源默认格式', type: 'select', options: ['clash', 'singbox', 'links', 'v2ray'] },
  { key: 'subscription.probe_by_default', label: '订阅源默认启用检测', type: 'bool' },
  { key: 'subscription.cache_seconds', label: '订阅源缓存（秒）', type: 'number' },
  { key: 'subscription.name', label: '订阅源名称', type: 'text' },
  { key: 'security.api_token', label: '管理员令牌（完全访问）', type: 'text' },
  { key: 'security.user_token', label: '普通用户令牌（仅转换/订阅）', type: 'text' },
  { key: 'storage.driver', label: '存储驱动', type: 'select', options: ['file'] },
  { key: 'logging.level', label: '日志级别', type: 'select', options: ['trace', 'debug', 'info', 'warn', 'error'] },
];

/** 本地节点配置字段 */
const LOCALNODE_FIELDS = [
  { key: 'localnode.enabled', label: '启用本机节点', type: 'bool' },
  { key: 'localnode.host', label: '监听地址', type: 'text' },
  { key: 'localnode.http_port', label: 'HTTP 代理端口（0 关闭）', type: 'number' },
  { key: 'localnode.socks_port', label: 'SOCKS5 端口（0 关闭）', type: 'number' },
  { key: 'localnode.username', label: '认证用户名', type: 'text' },
  { key: 'localnode.password', label: '认证密码', type: 'text' },
  { key: 'localnode.public_address', label: '公网地址（域名/IP，留空自动探测）', type: 'text' },
  { key: 'localnode.auto_detect_public_ip', label: '自动探测公网 IP', type: 'bool' },
  { key: 'localnode.public_ip_detect_url', label: 'IP 探测地址', type: 'text' },
  { key: 'localnode.ip_probe_timeout_ms', label: 'IP 探测超时（毫秒）', type: 'number' },
  { key: 'localnode.ip_cache_seconds', label: 'IP 缓存（秒）', type: 'number' },
  { key: 'localnode.inject_into_subscription', label: '注入订阅结果', type: 'bool' },
  { key: 'localnode.http_node_name', label: 'HTTP 节点名称', type: 'text' },
  { key: 'localnode.socks_node_name', label: 'SOCKS5 节点名称', type: 'text' },
];

/** CF 隧道配置字段 */
const CF_TUNNEL_FIELDS = [
  { key: 'cf_tunnel.enabled', label: '启用 CF 隧道', type: 'bool' },
  { key: 'cf_tunnel.binary', label: 'cloudflared 路径/命令', type: 'text' },
  { key: 'cf_tunnel.token', label: '远程管理隧道令牌', type: 'text' },
  { key: 'cf_tunnel.hostname', label: '命名隧道域名', type: 'text' },
  { key: 'cf_tunnel.tunnel_uuid', label: '命名隧道 UUID', type: 'text' },
  { key: 'cf_tunnel.credentials_file', label: '凭据文件路径', type: 'text' },
  { key: 'cf_tunnel.ingress_service', label: '入口服务（留空自动）', type: 'text' },
  { key: 'cf_tunnel.public_hostname_override', label: '注入用公网主机覆盖', type: 'text' },
];

/* ============ 通用表单渲染 ============ */

let currentConfig = null; // 最近一次加载的生效配置

/**
 * 渲染字段组
 * @param {string} containerId 容器 id
 * @param {Array} fields 字段描述
 * @param {object} config 生效配置
 */
function renderFields(containerId, fields, config) {
  const box = $(containerId);
  if (!box) return;
  box.innerHTML = '';
  for (const field of fields) {
    const value = getByPath(config, field.key);
    const wrap = document.createElement('div');
    wrap.className = 'field';

    const label = document.createElement('label');
    label.textContent = field.label;
    label.setAttribute('for', 'cfg-' + containerId + '-' + field.key.replace(/\./g, '-'));
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
    } else if (field.type === 'list') {
      input = document.createElement('textarea');
      input.rows = 3;
      if (Array.isArray(value)) input.value = value.join('\n');
    } else {
      input = document.createElement('input');
      input.type = field.type === 'number' ? 'number' : 'text';
      if (value !== undefined && value !== null) input.value = String(value);
      if ((field.key === 'security.api_token' || field.key === 'security.user_token') && value) input.value = '******';
    }
    input.dataset.key = field.key;
    input.dataset.kind = field.type || 'text';
    wrap.appendChild(input);
    box.appendChild(wrap);
  }
}

/**
 * 从字段组收集配置片段
 * api_token 掩码值（******）不提交；list 类型转为数组。
 */
function collectFields(containerId) {
  const patch = {};
  document.querySelectorAll(`#${containerId} [data-key]`).forEach((input) => {
    const key = input.dataset.key;
    const kind = input.dataset.kind || 'text';
    if (key === 'security.api_token' && input.value === '******') return;
    if (key === 'security.user_token' && input.value === '******') return;
    let value;
    if (kind === 'bool') value = input.value === 'true';
    else if (kind === 'number') value = input.value === '' ? '' : Number(input.value);
    else if (kind === 'list') value = input.value.split('\n').map((s) => s.trim()).filter(Boolean);
    else value = input.value;
    setByPath(patch, key, value);
  });
  return patch;
}

/* ============ 服务配置 ============ */

async function loadConfig() {
  try {
    const resp = await apiFetch('/api/config');
    if (!resp.ok) throw new Error('加载配置失败（HTTP ' + resp.status + '）');
    const data = await resp.json();
    currentConfig = data.config;
    renderFields('config-fields', CONFIG_FIELDS, currentConfig);
    renderFields('ln-fields', LOCALNODE_FIELDS, currentConfig);
    renderFields('ln-cf-fields', CF_TUNNEL_FIELDS, currentConfig);
  } catch (err) {
    toast(err.message, true);
  }
}

$('btn-save-config').addEventListener('click', async () => {
  try {
    const patch = collectFields('config-fields');
    const resp = await apiFetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '保存失败');
    currentConfig = data.config;
    renderFields('config-fields', CONFIG_FIELDS, currentConfig);
    toast('配置已保存并生效');
  } catch (err) {
    toast('保存失败：' + err.message, true);
  }
});

$('btn-reload-config').addEventListener('click', loadConfig);

/* ============ 数据备份与迁移 ============ */

// 导出备份
$('btn-backup').addEventListener('click', async () => {
  try {
    const resp = await apiFetch('/api/backup');
    if (!resp.ok) throw new Error('导出失败（HTTP ' + resp.status + '）');
    const data = await resp.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = URL.createObjectURL(blob);
    a.download = `subbridge-backup-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('备份已导出');
  } catch (err) {
    toast(err.message, true);
  }
});

// 选择备份文件后自动导入
$('restore-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const snapshot = JSON.parse(text);
    const resp = await apiFetch('/api/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '导入失败');
    const problems = (data.problems || []).map((s) => '· ' + s).join('\n');
    toast(problems ? '导入完成（部分内容被跳过）：' + problems : '导入成功，配置已生效');
    // 刷新界面数据
    await loadConfig();
    loadTemplateList();
    loadLocalNodeStatus();
  } catch (err) {
    toast('导入失败：' + err.message, true);
  }
});

$('btn-restore').addEventListener('click', () => $('restore-file').click());

/* ============ 本地节点 ============ */

/** 刷新本地节点状态与订阅源链接 */
async function loadLocalNodeStatus() {
  try {
    const resp = await apiFetch('/api/localnode');
    if (!resp.ok) throw new Error('获取本地节点状态失败');
    const data = await resp.json();
    renderLocalNodeStatus(data.localnode);
  } catch (err) {
    toast(err.message, true);
  }
}

/** 渲染状态卡 */
function renderLocalNodeStatus(ln) {
  const box = $('ln-status-body');
  if (!box) return;
  const dot = (on) => `<span class="dot ${on ? 'on' : 'off'}"></span>`;
  const rows = [
    ['HTTP 代理', `${dot(ln.http.running)} ${ln.http.running ? `运行中（端口 ${ln.http.port}）` : '未运行'}`],
    ['SOCKS5 代理', `${dot(ln.socks5.running)} ${ln.socks5.running ? `运行中（端口 ${ln.socks5.port}）` : '未运行'}`],
    ['CF 隧道', `${dot(ln.tunnel.running)} ${ln.tunnel.enabled ? `${ln.tunnel.mode} 模式` + (ln.tunnel.running ? ' · 运行中' : '') : '未启用'}`],
    ['隧道域名', escapeHtml(ln.tunnel.publicHost || '（无）')],
    ['节点公网地址', escapeHtml(ln.publicAddress || '（未确定）')],
    ['注入订阅', ln.injectIntoSubscription ? '开启' : '关闭'],
  ];
  box.innerHTML =
    '<div class="ln-status-grid">' +
    rows.map(([k, v]) => `<div class="ln-status-item"><span class="ln-key">${k}</span><span class="ln-val">${v}</span></div>`).join('') +
    '</div>' +
    (ln.tunnel.lastError ? `<p class="hint" style="color:var(--danger)">隧道错误：${escapeHtml(ln.tunnel.lastError)}</p>` : '');

  // 订阅源链接
  const urlInput = $('sub-source-url');
  if (urlInput && ln.subscriptionUrl) urlInput.value = ln.subscriptionUrl;
}

// 保存本地节点 + CF 隧道配置并重启
$('btn-ln-save').addEventListener('click', async () => {
  try {
    const patch = { ...collectFields('ln-fields'), ...collectFields('ln-cf-fields') };
    const resp = await apiFetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '保存失败');
    currentConfig = data.config;
    renderFields('ln-fields', LOCALNODE_FIELDS, currentConfig);
    renderFields('ln-cf-fields', CF_TUNNEL_FIELDS, currentConfig);
    toast('配置已保存，正在重启本地节点...');
    await restartLocalNode();
  } catch (err) {
    toast('保存失败：' + err.message, true);
  }
});

$('btn-ln-reload').addEventListener('click', () => {
  if (currentConfig) {
    renderFields('ln-fields', LOCALNODE_FIELDS, currentConfig);
    renderFields('ln-cf-fields', CF_TUNNEL_FIELDS, currentConfig);
  }
});

$('btn-ln-restart').addEventListener('click', restartLocalNode);

/** 重启本地节点与隧道 */
async function restartLocalNode() {
  const btn = $('btn-ln-restart');
  btn.disabled = true;
  try {
    const resp = await apiFetch('/api/localnode/restart', { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '重启失败');
    renderLocalNodeStatus(data.localnode);
    toast('本地节点已重启');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

// 复制本机订阅源链接
$('btn-copy-sub').addEventListener('click', async () => {
  const url = $('sub-source-url').value;
  if (!url) return toast('订阅源链接尚未就绪', true);
  try {
    await navigator.clipboard.writeText(url);
    toast('本机订阅源链接已复制');
  } catch {
    toast('复制失败，请手动复制', true);
  }
});

/* ============ 模板管理 ============ */

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

/** 初始化流程：主题、角色识别，再按权限加载数据 */
async function init() {
  initTheme();
  await identifyRole();
  initAdvancedToggle();
  if (currentRole === 'admin') {
    loadConfig();          // 管理员配置表单
    loadTemplateList();    // 模板列表
    loadLocalNodeStatus(); // 本地节点状态
  }
}

// 令牌变化后重新识别角色（普通用户 -> 管理员 或反之）
$('api-token-input').addEventListener('change', init);

init();
