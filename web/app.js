'use strict';

/* ============================================================
   SubBridge 前台逻辑
   - 登录 / 令牌 / 角色识别
   - 三级使用难度（简单 / 高级 / 专家）
   - 驾驶舱（KPI + 抓取 + 最近动态 + 调试）
   - 节点库（搜索 / 筛选 / 测速 / 删除 / 规则取节点）
   - 事件日志（类型 / 结果过滤）
   - 本地节点与 CF 隧道
   - 全站参数表（分组 / 搜索 / YAML 原文）
   - 模板与备份迁移
   ============================================================ */

/* ---------- 常量 ---------- */
const TOKEN_KEY = 'subbridge-token';
const THEME_KEY = 'subbridge-theme';
const MODE_KEY = 'subbridge-mode';

/* ---------- 工具函数 ---------- */
function $(id) { return document.getElementById(id); }
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function getToken() {
  const el = $('api-token-input');
  const v = el ? el.value.trim() : '';
  if (v) return v;
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
}
function setToken(v) {
  const el = $('api-token-input');
  if (el && v) el.value = v;
  try {
    if (v) localStorage.setItem(TOKEN_KEY, v);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (e) { /* 隐私模式忽略 */ }
}
let toastTimer = null;
function toast(text, isErr) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4200);
}

/** 带令牌的 fetch（自动附带 X-API-Token） */
function apiFetch(url, opts) {
  const headers = Object.assign({}, (opts && opts.headers) || {});
  const token = getToken();
  if (token) headers['X-API-Token'] = token;
  return fetch(url, Object.assign({}, opts, { headers }));
}
/** 读取 JSON 响应，失败抛出带状态的消息 */
async function apiJson(url, opts) {
  const resp = await apiFetch(url, opts);
  if (!resp.ok) {
    let msg = 'HTTP ' + resp.status;
    try { const d = await resp.json(); if (d && d.error) msg = d.error; } catch (e) { /* 忽略 */ }
    throw new Error(msg);
  }
  return resp.json();
}

/* ---------- 格式化 ---------- */
function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtBytes(b) {
  if (b == null) return '-';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}
function fmtSpeed(bps) {
  if (bps == null) return '-';
  if (bps < 1024) return bps + ' B/s';
  if (bps < 1024 * 1024) return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / 1024 / 1024).toFixed(1) + ' MB/s';
}
/** 状态点 + 文本（含质量分） */
function statusCell(n) {
  const p = n.probe;
  if (!p) return '<span class="dot unknown"></span><span class="status-text">未检测</span>';
  if (p.alive) {
    const parts = [];
    if (p.latencyMs != null) parts.push(p.latencyMs + 'ms');
    if (p.speedBps != null) parts.push(fmtSpeed(p.speedBps));
    if (p.score != null) parts.push(p.score + '分');
    return `<span class="dot ok"></span><span class="status-text">${parts.join(' / ') || '可用'}</span>`;
  }
  return `<span class="dot dead"></span><span class="status-text">${escapeHtml(p.error || '不可达')}</span>`;
}
/** 类型徽标配色（按协议热度区分） */
function typeBadge(type) {
  const hot = ['vmess', 'vless', 'trojan'];
  const warm = ['ss', 'ssr', 'hysteria', 'hysteria2', 'tuic'];
  const cls = hot.includes(type) ? 'hot' : warm.includes(type) ? 'warm' : 'cool';
  return `<span class="type-badge ${cls}">${escapeHtml(type)}</span>`;
}

/* ---------- 主题 ---------- */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('btn-theme');
  if (btn) btn.textContent = theme === 'dark' ? '🌙' : '☀️';
}
function initTheme() {
  const btn = $('btn-theme');
  applyTheme(document.documentElement.dataset.theme || 'dark');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 忽略 */ }
    applyTheme(next);
  });
}

/* ---------- 三级使用难度（简单 / 高级 / 专家） ---------- */
function applyMode(mode) {
  document.body.dataset.mode = mode;
  document.querySelectorAll('#mode-switch button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === mode);
  });
  const sel = $('mode-select');
  if (sel) sel.value = mode;
}
function initMode() {
  let mode = 'advanced';
  try { mode = localStorage.getItem(MODE_KEY) || 'advanced'; } catch (e) { /* 忽略 */ }
  if (!['simple', 'advanced', 'expert'].includes(mode)) mode = 'advanced';
  applyMode(mode);
  document.querySelectorAll('#mode-switch button').forEach((b) => {
    b.addEventListener('click', () => {
      const next = b.dataset.mode;
      applyMode(next);
      try { localStorage.setItem(MODE_KEY, next); } catch (e) { /* 忽略 */ }
      // 切到高级/专家时按需加载隐藏数据
      if (next !== 'simple' && currentRole === 'admin') {
        if (next === 'expert') loadDebug();
        loadLogs(true);
      }
      toast(`已切换为${next === 'simple' ? '简单' : next === 'advanced' ? '高级' : '专家'}模式`);
    });
  });
}

/* ---------- Tab 切换（侧边导航） ---------- */
document.querySelectorAll('.nav-item').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((t) => t.classList.remove('on'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('on');
    $('panel-' + tab.dataset.tab).classList.add('active');
    // 进入面板时按需加载
    if (tab.dataset.tab === 'pool') loadPool();
    if (tab.dataset.tab === 'logs' && currentRole === 'admin') loadLogs();
    if (tab.dataset.tab === 'localnode' && currentRole === 'admin') loadLocalNodeStatus();
    if (tab.dataset.tab === 'config' && currentRole === 'admin') loadConfig();
  });
});

/* ---------- 角色识别与登录 ---------- */
let currentRole = 'unknown'; // unknown / admin / user / guest
let subscriptionUrl = '';

async function identifyRole() {
  try {
    const resp = await apiFetch('/api/me');
    if (!resp.ok) {
      if (resp.status === 401) {
        currentRole = 'guest';
        applyRoleUi();
        toast('未授权：请登录或填写令牌', true);
        return;
      }
      throw new Error('识别角色失败（HTTP ' + resp.status + '）');
    }
    const data = await resp.json();
    currentRole = data.role || 'user';
    subscriptionUrl = data.subscriptionUrl || '';
    applyRoleUi();
  } catch (err) {
    toast(err.message, true);
  }
}

function applyRoleUi() {
  const isAdmin = currentRole === 'admin';
  const loggedIn = currentRole === 'admin' || currentRole === 'user';
  // 登录态徽标 + 登录/退出按钮
  const badge = $('role-badge');
  const btn = $('btn-login');
  if (badge) {
    badge.textContent = currentRole === 'admin' ? '管理员' : currentRole === 'user' ? '普通用户' : '未登录';
    badge.className = 'badge ' + (isAdmin ? 'ok' : currentRole === 'user' ? '' : 'warn');
  }
  if (btn) {
    btn.textContent = loggedIn ? '退出' : '登录';
    btn.classList.toggle('ghost', !loggedIn);
  }
  document.querySelectorAll('.nav-item.admin-only').forEach((tab) => tab.classList.toggle('hidden', !isAdmin));
  document.querySelectorAll('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin));
  // 非管理员隐藏操作列相关按钮（删除等）
  document.querySelectorAll('.ops-admin').forEach((el) => el.classList.toggle('hidden', !isAdmin));
  if (isAdmin) {
    if (document.body.dataset.mode === 'expert') loadDebug();
    loadLogs(true);
  }
  loadDashboard();
}

/* ---------- 登录跳转 ---------- */
function initLogin() {
  const btn = $('btn-login');
  if (btn) {
    btn.addEventListener('click', () => {
      // 已登录：点击为退出（清除令牌回登录页）；未登录：跳转登录页
      if (currentRole === 'admin' || currentRole === 'user') {
        setToken('');
        currentRole = 'guest';
        applyRoleUi();
        location.href = '/login';
      } else {
        location.href = '/login';
      }
    });
  }
  // 已保存令牌自动填充
  const saved = getToken();
  if (saved) {
    const el = $('api-token-input');
    if (el) el.value = saved;
  }
  const input = $('api-token-input');
  if (input) {
    input.addEventListener('change', () => {
      setToken(input.value.trim());
      identifyRole();
    });
  }
}

/* ============================================================
   驾驶舱（主页）
   ============================================================ */
async function loadDashboard() {
  try {
    const d = await apiJson('/api/dashboard');
    $('kpi-pool-total').textContent = d.pool.total;
    $('kpi-pool-alive').textContent = `可用 ${d.pool.alive} · 停用 ${d.pool.disabled} · 不可达 ${d.pool.dead}`;
    $('kpi-log-total').textContent = d.logs.total;
    $('kpi-log-ok').textContent = `成功 ${d.logs.ok} · 失败 ${d.logs.fail}`;
    $('kpi-subcount').textContent = d.subscription.mainUrls;
    $('kpi-merge').textContent = `合并主订阅 ${d.subscription.mergeMainUrls ? '开' : '关'} · 含节点池 ${d.subscription.includePool ? '开' : '关'}`;
    const ln = d.localnode;
    const lnLabel = ln.enabled ? `${ln.httpRunning ? 'HTTP✓' : ''} ${ln.socksRunning ? 'SOCKS5✓' : ''}`.trim() || '已启用' : '未启用';
    $('kpi-localnode').textContent = lnLabel;
    $('kpi-tunnel').textContent = `隧道 ${ln.tunnelRunning ? '运行中' : '未运行'}${ln.publicHost ? ' · ' + ln.publicHost : ''}`;
    subscriptionUrl = d.subscription.subscriptionUrl || subscriptionUrl;

    renderMini($('recent-logs'), d.recentLogs || [], (l) => ({
      t: typeName(l.type) + ' · ' + (l.url || '').slice(0, 60),
      m: l.error ? '失败' : (l.nodes != null ? l.nodes + ' 节点' : '成功'),
      err: !!l.error,
    }));
    renderMini($('recent-nodes'), d.recentNodes || [], (n) => ({
      t: n.name || '',
      m: n.probe && n.probe.alive ? '可用' : '未测',
      err: false,
    }));
    if (document.body.dataset.mode === 'expert') renderDebug(d);
  } catch (err) {
    toast('加载驾驶舱失败：' + err.message, true);
  }
}

function renderMini(container, list, mapFn) {
  if (!container) return;
  if (!list.length) {
    container.innerHTML = '<div class="mini-item"><span class="t">暂无数据</span></div>';
    return;
  }
  container.innerHTML = list
    .map((it) => {
      const m = mapFn(it);
      return `<div class="mini-item"><span class="t">${escapeHtml(m.t)}</span><span class="m" style="color:${m.err ? 'var(--danger)' : 'var(--text-faint)'}">${escapeHtml(m.m)}</span></div>`;
    })
    .join('');
}

/* ---------- 抓取 ---------- */
const GRAB_SAMPLE = 'https://www.vpngate.net/cn/';

function grabInputValue() {
  const v = $('grab-input').value.trim();
  if (!v) { toast('请先填写抓取来源', true); return ''; }
  return v;
}

function buildSubUrl() {
  const base = subscriptionUrl || (location.origin + '/sub');
  return base;
}

async function doGrab(probe) {
  const input = grabInputValue();
  if (!input) return;
  const btn = probe ? $('btn-speedtest') : $('btn-grab');
  const old = btn.textContent;
  btn.textContent = probe ? '抓取并测速中...' : '抓取中...';
  btn.disabled = true;
  try {
    if (probe) {
      const d = await apiJson('/api/probe?url=' + encodeURIComponent(input));
      renderGrabResults(
        d.results.map((r) => ({
          name: r.name, type: r.type, server: r.server, port: r.port,
          probe: { alive: r.alive, latencyMs: r.latencyMs, speedBps: r.speedBps, error: r.error },
        })),
        `测速完成：共 ${d.summary.total} 个，可用 ${d.summary.alive} 个` +
          (d.summary.avgLatencyMs != null ? `，平均延迟 ${d.summary.avgLatencyMs}ms` : ''),
        [],
      );
    } else {
      const d = await apiJson('/api/grab?url=' + encodeURIComponent(input));
      renderGrabResults(
        d.nodes,
        `解析 ${d.summary.parsed} 个 · 节点池新增 ${d.summary.poolAdded} / 更新 ${d.summary.poolUpdated}`,
        d.warnings || [],
      );
    }
    loadDashboard();
    if (currentRole === 'admin') loadLogs(true);
  } catch (err) {
    toast('抓取失败：' + err.message, true);
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
}

function renderGrabResults(nodes, meta, warnings) {
  const box = $('grab-result');
  box.classList.remove('hidden');
  $('grab-meta').textContent = meta;
  const body = $('grab-nodes');
  if (!nodes.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">未解析出节点（见下方告警）</td></tr>';
  } else {
    body.innerHTML = nodes
      .map((n) => `<tr>
        <td class="node-name">${escapeHtml(n.name || '')}</td>
        <td>${typeBadge(n.type)}</td>
        <td class="node-server">${escapeHtml(n.server || '')}:${escapeHtml(n.port != null ? n.port : '')}</td>
        <td>${statusCell(n)}</td>
      </tr>`)
      .join('');
  }
  const warn = $('grab-warnings');
  warn.innerHTML = warnings && warnings.length
    ? '⚠ ' + warnings.map(escapeHtml).join('<br>⚠ ')
    : '';
  const rulesHint = $('grab-rules-hint');
  if (rulesHint) {
    const r = $('rules-input');
    if (r && r.value.trim()) {
      rulesHint.textContent = '已启用自定义规则：当前订阅链接将按规则从节点池取节点（见「节点库 → 自定义规则」）。';
    } else {
      rulesHint.textContent = '如需按规则从节点池取节点，可在「节点库 → 自定义规则」配置后复制带规则链接。';
    }
  }
}

function initGrab() {
  $('btn-grab').addEventListener('click', () => doGrab(false));
  $('btn-speedtest').addEventListener('click', () => doGrab(true));
  $('btn-grab-example').addEventListener('click', () => {
    $('grab-input').value = GRAB_SAMPLE;
    toast('已填入示例（vpngate 公开网页），点击「抓取并入库」即可体验');
  });
  $('btn-copy-sub').addEventListener('click', async () => {
    const url = buildSubUrl();
    try { await navigator.clipboard.writeText(url); toast('订阅链接已复制'); }
    catch (e) { toast('复制失败：' + e.message, true); }
  });
  $('btn-copy-sub-rules').addEventListener('click', async () => {
    const r = $('rules-input');
    if (!r || !r.value.trim()) {
      toast('请先在「节点库 → 自定义规则」填写规则', true);
      $('rules-card').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    const url = buildSubUrl() + '&rules=' + encodeURIComponent(r.value.trim());
    try { await navigator.clipboard.writeText(url); toast('带规则订阅链接已复制'); }
    catch (e) { toast('复制失败：' + e.message, true); }
  });
}

/* ---------- 专家调试 ---------- */
async function loadDebug() {
  try {
    const d = await apiJson('/api/dashboard');
    renderDebug(d);
  } catch (err) {
    toast('加载调试数据失败：' + err.message, true);
  }
}
function renderDebug(d) {
  const box = $('debug-json');
  if (!box) return;
  box.value = JSON.stringify(
    { pool: d.pool, logs: d.recentLogs || [], recentNodes: d.recentNodes || [] },
    null, 2,
  );
}
function initDebug() {
  const btn = $('btn-debug-refresh');
  if (btn) btn.addEventListener('click', loadDebug);
}

/* ============================================================
   节点库
   ============================================================ */
let poolAll = [];

async function loadPool() {
  try {
    const qs = [];
    const search = $('pool-search').value.trim();
    const type = $('pool-type').value;
    const enabled = $('pool-enabled').value;
    const onlyAlive = $('pool-only-alive').checked;
    if (search) qs.push('search=' + encodeURIComponent(search));
    if (type) qs.push('type=' + encodeURIComponent(type));
    if (enabled) qs.push('enabled=' + encodeURIComponent(enabled));
    if (onlyAlive) qs.push('ok=1');
    const d = await apiJson('/api/pool' + (qs.length ? '?' + qs.join('&') : ''));
    poolAll = d.nodes;
    refreshPoolTypes();
    renderPool(d.nodes, d.total);
  } catch (err) {
    toast('加载节点库失败：' + err.message, true);
  }
}

function renderPool(nodes, total) {
  const body = $('pool-body');
  if (!nodes.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty">暂无节点。先在「驾驶舱」抓取，或配置主订阅后由 /sub 自动累积。${total ? `（共 ${total} 个，被当前筛选隐藏）` : ''}</td></tr>`;
    return;
  }
  body.innerHTML = nodes
    .map((n) => {
      const key = `${n.type}:${n.server}:${n.port}`;
      const enabled = n.enabled !== false;
      const dim = enabled ? '' : ' style="opacity:0.45"';
      const toggle = currentRole === 'admin'
        ? `<button class="btn small ${enabled ? '' : 'ghost'}" data-toggle="${escapeHtml(key)}" data-next="${enabled ? '0' : '1'}" type="button">${enabled ? '停用' : '启用'}</button>`
        : `<span class="tag ${enabled ? 'tag-ok' : 'tag-fail'}">${enabled ? '启用' : '停用'}</span>`;
      const ops = currentRole === 'admin'
        ? `<button class="btn ghost small ops-admin" data-remove="${escapeHtml(key)}" type="button">删除</button>`
        : '';
      return `<tr${dim}>
        <td class="node-name">${escapeHtml(n.name || '')}${enabled ? '' : ' <span class="tag tag-fail">停用</span>'}</td>
        <td>${typeBadge(n.type)}</td>
        <td class="node-server">${escapeHtml(n.server || '')}:${escapeHtml(n.port != null ? n.port : '')}</td>
        <td>${statusCell(n)}</td>
        <td class="node-source">${escapeHtml(n.source || '-')}</td>
        <td class="status-text">${fmtTime(n.updatedAt)}</td>
        <td class="ops-admin">${toggle}</td>
        <td class="ops-admin">${ops}</td>
      </tr>`;
    })
    .join('');
}

function initPool() {
  $('pool-search').addEventListener('input', loadPool);
  $('pool-type').addEventListener('change', loadPool);
  $('pool-enabled').addEventListener('change', loadPool);
  $('pool-only-alive').addEventListener('change', loadPool);

  $('btn-pool-probe').addEventListener('click', async () => {
    const btn = $('btn-pool-probe');
    btn.textContent = '测速中（可能较慢）...';
    btn.disabled = true;
    try {
      const d = await apiJson('/api/pool/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      let msg = `测速完成：共 ${d.tested} 个，可用 ${d.alive} 个`;
      if (d.quality) msg += `；质量门槛停用 ${d.quality.disabled} / 启用 ${d.quality.enabled}`;
      if (d.cleanup) msg += `；自动清理删除 ${d.cleanup.removed}`;
      toast(msg);
      loadPool();
      loadDashboard();
      if (currentRole === 'admin') loadLogs(true);
    } catch (err) {
      toast('测速失败：' + err.message, true);
    } finally {
      btn.textContent = '测速';
      btn.disabled = false;
    }
  });

  $('btn-pool-clear').addEventListener('click', async () => {
    if (!window.confirm('确定清空整个节点池？该操作不可恢复。')) return;
    try {
      await apiJson('/api/pool/clear', { method: 'POST' });
      toast('节点池已清空');
      loadPool();
      loadDashboard();
      if (currentRole === 'admin') loadLogs(true);
    } catch (err) {
      toast('清空失败：' + err.message, true);
    }
  });

  // 行内开关（事件委托）
  $('pool-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-toggle]');
    if (!btn) return;
    try {
      await apiJson('/api/pool/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: btn.dataset.toggle, enabled: btn.dataset.next === '1' }),
      });
      toast(btn.dataset.next === '1' ? '节点已启用' : '节点已停用（不再输出到订阅）');
      loadPool();
      loadDashboard();
      if (currentRole === 'admin') loadLogs(true);
    } catch (err) {
      toast('操作失败：' + err.message, true);
    }
  });

  // 行内删除（事件委托）
  $('pool-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    if (!window.confirm('确定删除该节点？')) return;
    try {
      await apiJson('/api/pool/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: [btn.dataset.remove] }) });
      toast('节点已删除');
      loadPool();
      loadDashboard();
      if (currentRole === 'admin') loadLogs(true);
    } catch (err) {
      toast('删除失败：' + err.message, true);
    }
  });

  // 类型下拉（进入页面时收集一次）
  refreshPoolTypes();
}

/** 类型下拉选项（从当前已加载节点收集） */
function refreshPoolTypes() {
  const sel = $('pool-type');
  if (!sel) return;
  const cur = sel.value;
  const types = [...new Set(poolAll.map((n) => n.type).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">全部类型</option>' +
    types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  sel.value = cur;
}

/* ---------- 自动清理：自定义删除逻辑 ---------- */
function initCleanup() {
  const syncCleanupUi = () => {
    if (!currentConfig) return;
    const pool = currentConfig.pool || {};
    const input = $('cleanup-input');
    if (input && Array.isArray(pool.cleanup_rules) && pool.cleanup_rules.length && !input.value.trim()) {
      input.value = JSON.stringify(pool.cleanup_rules, null, 2);
    }
  };
  window.__syncCleanupUi = syncCleanupUi;

  $('btn-cleanup-apply').addEventListener('click', async () => {
    const input = $('cleanup-input').value.trim();
    if (!input) { toast('请先填写清理规则', true); return; }
    if (!window.confirm('执行清理将按规则删除匹配的节点，确定继续？')) return;
    const btn = $('btn-cleanup-apply');
    btn.disabled = true;
    btn.textContent = '清理中...';
    try {
      await apiJson('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pool: { cleanup_rules: JSON.parse(input) } }),
      });
      const d = await apiJson('/api/pool/cleanup', { method: 'POST' });
      const box = $('cleanup-result');
      box.classList.remove('hidden');
      $('cleanup-result-text').textContent =
        `清理完成：检查 ${d.checked} 个节点，删除 ${d.removed} 个（规则 ${d.rules} 条）。`;
      toast(`清理完成：删除 ${d.removed} 个节点`);
      loadPool();
      loadDashboard();
      if (currentRole === 'admin') loadLogs(true);
    } catch (err) {
      toast('清理失败：' + err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '立即清理';
    }
  });
}

/* ---------- 质量门槛：按多指标自动开关节点 ---------- */
function initQuality() {
  // 加载配置时同步模式下拉与默认门槛
  const syncQualityUi = () => {
    if (!currentConfig) return;
    const pool = currentConfig.pool || {};
    const modeSel = $('quality-mode');
    if (modeSel && pool.quality_mode === 'any') modeSel.value = 'any';
    const input = $('quality-input');
    if (input && Array.isArray(pool.quality_gates) && pool.quality_gates.length && !input.value.trim()) {
      input.value = JSON.stringify(pool.quality_gates, null, 2);
    }
  };
  window.__syncQualityUi = syncQualityUi;

  $('btn-quality-apply').addEventListener('click', async () => {
    const input = $('quality-input').value.trim();
    if (!input) { toast('请先填写质量门槛', true); return; }
    const btn = $('btn-quality-apply');
    btn.disabled = true;
    btn.textContent = '应用中...';
    try {
      // 先把门槛保存进配置（写入 pool.quality_gates / quality_mode），再强制执行
      const patch = { pool: { quality_gates: JSON.parse('[' + input.replace(/^\[/, '').replace(/\]$/, '') + ']') } };
      await apiJson('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      const d = await apiJson('/api/pool/apply-quality', { method: 'POST' });
      const box = $('quality-result');
      box.classList.remove('hidden');
      $('quality-result-text').textContent =
        `应用完成：检查 ${d.checked} 个节点，自动停用 ${d.disabled} 个，自动启用 ${d.enabled} 个（门槛 ${d.gates} 条，模式 ${d.mode}）。`;
      toast(`质量门槛已应用：停用 ${d.disabled} / 启用 ${d.enabled}`);
      loadPool();
      loadDashboard();
      if (currentRole === 'admin') loadLogs(true);
    } catch (err) {
      toast('应用失败：' + err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '立即应用';
    }
  });
}

/* ---------- 内置模板：一键初始化规则 / 质量门槛 / 清理规则 ---------- */
const PRESET_GROUPS = [
  { select: 'rules-preset', btn: 'btn-rules-preset', input: 'rules-input', desc: 'rules-preset-desc' },
  { select: 'quality-preset', btn: 'btn-quality-preset', input: 'quality-input', desc: 'quality-preset-desc' },
  { select: 'cleanup-preset', btn: 'btn-cleanup-preset', input: 'cleanup-input', desc: 'cleanup-preset-desc' },
];

/** 拉取内置模板并填充下拉框 */
async function loadPresets() {
  try {
    const d = await apiJson('/api/presets');
    const map = { rules: d.rules, quality_gates: d.quality_gates, cleanup_rules: d.cleanup_rules };
    PRESET_GROUPS.forEach((g) => {
      const sel = $(g.select);
      if (!sel) return;
      sel.innerHTML = '<option value="">选择模板…</option>';
      const kind = g.input === 'rules-input' ? 'rules' : g.input === 'quality-input' ? 'quality_gates' : 'cleanup_rules';
      (map[kind] || []).forEach((p) => {
        const opt = document.createElement('option');
        opt.value = JSON.stringify(p.value);
        opt.textContent = p.label;
        opt.dataset.desc = p.desc || '';
        sel.appendChild(opt);
      });
      const btn = $(g.btn);
      btn.onclick = () => {
        const v = sel.value;
        if (!v) { toast('请先选择模板', true); return; }
        const opt = sel.selectedOptions[0];
        $(g.input).value = JSON.stringify(JSON.parse(v), null, 2);
        const descEl = $(g.desc);
        if (descEl) descEl.textContent = (opt && opt.dataset.desc) || '';
        toast('模板已填入，可修改后保存');
      };
      sel.onchange = () => {
        const opt = sel.selectedOptions[0];
        const descEl = $(g.desc);
        if (descEl) descEl.textContent = sel.value && opt ? (opt.dataset.desc || '') : '';
      };
    });
  } catch (err) {
    /* 模板加载失败不阻塞页面 */
  }
}

function initRules() {
  $('btn-rules-gen').addEventListener('click', () => {
    const rules = $('rules-input').value.trim();
    if (!rules) { toast('请先填写规则', true); return; }
    const base = buildSubUrl();
    const url = base + (base.includes('?') ? '&' : '?') + 'rules=' + encodeURIComponent(rules);
    $('rules-url').textContent = url;
    $('rules-result').classList.remove('hidden');
  });
  $('btn-rules-copy').addEventListener('click', async () => {
    const code = $('rules-url');
    if (!code.textContent) { toast('请先生成订阅链接', true); return; }
    try { await navigator.clipboard.writeText(code.textContent); toast('已复制'); }
    catch (e) { toast('复制失败：' + e.message, true); }
  });
}

/* ============================================================
   事件日志（仅管理员）
   ============================================================ */
const LOG_TYPES = { fetch: '抓取', probe: '测速', pool: '节点池', config: '配置', system: '系统' };
function typeName(t) { return LOG_TYPES[t] || t || '其他'; }

async function loadLogs(silent) {
  const qs = ['limit=300'];
  const type = $('log-type').value;
  const ok = $('log-ok').value;
  if (type) qs.push('type=' + type);
  if (ok) qs.push('ok=' + ok);
  try {
    const d = await apiJson('/api/logs?' + qs.join('&'));
    renderLogs(d.logs || []);
  } catch (err) {
    if (!silent) toast('加载日志失败：' + err.message, true);
  }
}

function renderLogs(logs) {
  const body = $('log-body');
  if (!logs.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty">暂无日志</td></tr>';
    return;
  }
  body.innerHTML = logs
    .map((l) => {
      const cls = l.error ? 'tag-fail' : 'tag-ok';
      const okText = l.error ? '失败' : '成功';
      return `<tr>
        <td class="status-text">${fmtTime(l.ts)}</td>
        <td><span class="tag ${cls}">${escapeHtml(typeName(l.type))}</span></td>
        <td class="node-name">${escapeHtml((l.url || '').slice(0, 120))}</td>
        <td class="status-text">${l.httpStatus != null ? l.httpStatus : '-'}</td>
        <td class="status-text">${l.bytes != null ? fmtBytes(l.bytes) : '-'}</td>
        <td class="status-text">${l.nodes != null ? l.nodes : '-'}${l.alive != null ? '（存活 ' + l.alive + '）' : ''}</td>
        <td class="status-text">${l.durationMs != null ? l.durationMs + 'ms' : '-'}</td>
        <td class="node-source">${escapeHtml((l.error || okText).slice(0, 80))}</td>
      </tr>`;
    })
    .join('');
}

function initLogs() {
  $('log-type').addEventListener('change', () => loadLogs());
  $('log-ok').addEventListener('change', () => loadLogs());
  $('btn-log-refresh').addEventListener('click', () => loadLogs());
  $('btn-log-clear').addEventListener('click', async () => {
    if (!window.confirm('确定清空全部事件日志？')) return;
    try {
      await apiJson('/api/logs/clear', { method: 'POST' });
      toast('日志已清空');
      loadLogs();
      loadDashboard();
    } catch (err) {
      toast('清空失败：' + err.message, true);
    }
  });
}

/* ============================================================
   本地节点与 CF 隧道（仅管理员）
   ============================================================ */
const LOCALNODE_FIELDS = [
  { key: 'localnode.enabled', label: '启用本机节点', type: 'bool', hint: '开启后本机即成为订阅节点（HTTP/SOCKS5 代理）。' },
  { key: 'localnode.host', label: '监听地址', type: 'text', hint: '0.0.0.0 表示所有网卡可访问；仅本机使用可填 127.0.0.1。' },
  { key: 'localnode.http_port', label: 'HTTP 代理端口（0 关闭）', type: 'number', hint: '对外暴露的 HTTP 代理端口，如 1082。' },
  { key: 'localnode.socks_port', label: 'SOCKS5 端口（0 关闭）', type: 'number', hint: '对外暴露的 SOCKS5 代理端口，如 1083。' },
  { key: 'localnode.username', label: '认证用户名', type: 'text', hint: '必填：避免成为开放代理。' },
  { key: 'localnode.password', label: '认证密码', type: 'text', hint: '必填：客户端连接时使用的密码。' },
  { key: 'localnode.public_address', label: '公网地址（域名/IP，留空自动探测）', type: 'text', hint: '有公网 IP 或域名时填写，会写进订阅节点地址。' },
  { key: 'localnode.auto_detect_public_ip', label: '自动探测公网 IP', type: 'bool', hint: '无公网 IP 时留空自动探测（如 192.168.x.x 内网则探测不到公网）。' },
  { key: 'localnode.public_ip_detect_url', label: 'IP 探测地址', type: 'text', hint: '如 http://ip-api.com/json 等返回 IP 的接口。' },
  { key: 'localnode.ip_probe_timeout_ms', label: 'IP 探测超时（毫秒）', type: 'number', hint: '' },
  { key: 'localnode.ip_cache_seconds', label: 'IP 缓存（秒）', type: 'number', hint: '' },
  { key: 'localnode.inject_into_subscription', label: '注入订阅结果', type: 'bool', hint: '开启后 /sub 输出自动包含本机节点。' },
  { key: 'localnode.http_node_name', label: 'HTTP 节点名称', type: 'text', hint: '' },
  { key: 'localnode.socks_node_name', label: 'SOCKS5 节点名称', type: 'text', hint: '' },
];

const CF_TUNNEL_FIELDS = [
  { key: 'cf_tunnel.enabled', label: '启用 CF 隧道', type: 'bool', hint: '本机无公网 IP 时把节点映射为公网 HTTPS 地址。' },
  { key: 'cf_tunnel.binary', label: 'cloudflared 路径/命令', type: 'text', hint: '留空用 PATH 中的 cloudflared；容器内可用绝对路径。' },
  { key: 'cf_tunnel.token', label: '远程管理隧道令牌', type: 'text', hint: '模式一：填了即用远程隧道，hostname 在 CF 后台配置。' },
  { key: 'cf_tunnel.hostname', label: '命名隧道域名', type: 'text', hint: '模式二：如 node.example.com。' },
  { key: 'cf_tunnel.tunnel_uuid', label: '命名隧道 UUID', type: 'text', hint: '模式二：cloudflared tunnel create 生成的 ID。' },
  { key: 'cf_tunnel.credentials_file', label: '凭据文件路径', type: 'text', hint: '模式二：cloudflared tunnel login 生成的 json 凭据。' },
  { key: 'cf_tunnel.ingress_service', label: '入口服务（留空自动）', type: 'text', hint: '如 http://localhost:1082。' },
  { key: 'cf_tunnel.public_hostname_override', label: '注入用公网主机覆盖', type: 'text', hint: '填了则以它作为订阅节点地址（如自定义域名）。' },
];

async function loadLocalNodeStatus() {
  try {
    const d = await apiJson('/api/localnode');
    renderLocalNodeStatus(d.localnode || {});
  } catch (err) {
    $('ln-status-body').innerHTML = `<div class="ln-item"><div class="k">加载失败</div><div class="v">${escapeHtml(err.message)}</div></div>`;
  }
}

function renderLocalNodeStatus(ln) {
  const box = $('ln-status-body');
  if (!box) return;
  const items = [
    ['本机节点', ln.enabled ? '已启用' : '未启用', !ln.enabled],
    ['HTTP 代理', ln.http && ln.http.running ? `运行中 :${ln.http.port}` : '未运行', !(ln.http && ln.http.running)],
    ['SOCKS5 代理', ln.socks5 && ln.socks5.running ? `运行中 :${ln.socks5.port}` : '未运行', !(ln.socks5 && ln.socks5.running)],
    ['公网地址', ln.publicAddress || '未探测', !ln.publicAddress],
    ['CF 隧道', ln.tunnel && ln.tunnel.running ? '运行中' : '未运行', !(ln.tunnel && ln.tunnel.running)],
    ['隧道公网地址', (ln.tunnel && ln.tunnel.publicHost) || '无', !(ln.tunnel && ln.tunnel.publicHost)],
  ];
  box.innerHTML = items
    .map(([k, v, bad]) => `<div class="ln-item"><div class="k">${k}</div><div class="v" style="color:${bad ? 'var(--text-faint)' : 'var(--ok)'}">${escapeHtml(v)}</div></div>`)
    .join('');
}

function initLocalNode() {
  renderFields('ln-fields', LOCALNODE_FIELDS, null);
  renderFields('ln-cf-fields', CF_TUNNEL_FIELDS, null);

  $('btn-ln-save').addEventListener('click', async () => {
    const patch = Object.assign({}, collectFields('ln-fields'), collectFields('ln-cf-fields'));
    try {
      await apiJson('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      toast('本地节点配置已保存，请点击「重启本地节点与隧道」生效');
    } catch (err) {
      toast('保存失败：' + err.message, true);
    }
  });
  $('btn-ln-reload').addEventListener('click', async () => {
    await loadConfig();
    renderFields('ln-fields', LOCALNODE_FIELDS, currentConfig);
    renderFields('ln-cf-fields', CF_TUNNEL_FIELDS, currentConfig);
    toast('已重新加载配置');
  });
  $('btn-ln-restart').addEventListener('click', restartLocalNode);
}

async function restartLocalNode() {
  const btn = $('btn-ln-restart');
  const old = btn.textContent;
  btn.textContent = '重启中...';
  btn.disabled = true;
  try {
    await apiJson('/api/localnode/restart', { method: 'POST' });
    toast('本地节点与隧道已重启');
    loadLocalNodeStatus();
    loadDashboard();
  } catch (err) {
    toast('重启失败：' + err.message, true);
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
}

/* ============================================================
   全站参数表（仅管理员）
   ============================================================ */
const CONFIG_FIELDS = [
  { group: '运行', key: 'server.host', label: '监听地址', type: 'text', hint: '0.0.0.0 供外部访问；127.0.0.1 仅本机。' },
  { group: '运行', key: 'server.port', label: '监听端口', type: 'number', hint: 'HTTP 服务端口。' },
  { group: '运行', key: 'server.trust_proxy', label: '信任反向代理', type: 'bool', hint: '置于 Nginx/CF 后时开启，以正确识别来源与协议。' },
  { group: '抓取', key: 'fetcher.timeout_seconds', label: '抓取超时（秒）', type: 'number', hint: '单个来源请求超时。' },
  { group: '抓取', key: 'fetcher.retries', label: '抓取重试次数', type: 'number', hint: '失败自动重试次数。' },
  { group: '抓取', key: 'fetcher.retry_base_ms', label: '重试退避初始（毫秒）', type: 'number', hint: '' },
  { group: '抓取', key: 'fetcher.retry_max_ms', label: '重试退避上限（毫秒）', type: 'number', hint: '' },
  { group: '抓取', key: 'fetcher.user_agent', label: '请求 User-Agent', type: 'text', hint: '部分订阅源按 UA 识别，可伪装成浏览器。' },
  { group: '抓取', key: 'fetcher.max_body_bytes', label: '内容大小上限（字节）', type: 'number', hint: '防止大文件拖垮内存。' },
  { group: '抓取', key: 'fetcher.max_concurrency', label: '并发抓取数', type: 'number', hint: '' },
  { group: '抓取', key: 'fetcher.upstream_proxy', label: '上游转发代理（http/https）', type: 'text', hint: '显式配置时优先于"节点池挑选"与本机自中继，如 http://user:pass@host:8080。' },
  { group: '抓取', key: 'fetcher.proxy_from_pool', label: '代理从节点池挑选', type: 'bool', hint: '未配置上游代理时，自动挑选池中可用 http 节点作为抓取代理。' },
  { group: '抓取', key: 'fetcher.proxy_pool_types', label: '池代理类型白名单', type: 'list', hint: '每行一个类型，默认 http。' },
  { group: '抓取', key: 'fetcher.headers', label: '抓取自定义请求头（JSON）', type: 'json', hint: '如 {"Authorization":"Bearer xxx","Cookie":"a=1"}；支持鉴权订阅源；可被 ?headers= 参数覆盖。' },
  { group: '抓取', key: 'fetcher.relay_through_localnode', label: '抓取走本机节点自中继', type: 'bool', hint: '未配上游代理且池无可用代理时，经本机 HTTP 节点中转采集（顺带验证本机节点）。' },
  { group: '抓取', key: 'fetcher.block_private', label: 'SSRF 防护（拦截内网）', type: 'bool', hint: '拦截抓取内网地址，防止 SSRF；内网测试时关闭。' },
  { group: '抓取', key: 'grab.max_depth', label: '网页递归抓取深度', type: 'number', hint: '从网页发现订阅链接后最多递归几层（0 仅解析页面本身）。' },
  { group: '抓取', key: 'grab.max_links', label: '网页最多递归链接数', type: 'number', hint: '控制递归抓取总量，防止无限爬取。' },
  { group: '抓取', key: 'grab.link_keywords', label: '订阅链接特征关键词', type: 'list', hint: '命中这些路径特征才当作订阅链接递归抓取，每行一个。' },
  { group: '转换', key: 'converter.default_target', label: '默认目标格式', type: 'select', options: ['clash', 'singbox', 'links', 'v2ray'], hint: '不带 target 参数时输出该格式。' },
  { group: '转换', key: 'converter.dedupe', label: '节点去重', type: 'bool', hint: '同名/同地址节点自动去重。' },
  { group: '转换', key: 'converter.append_source', label: '节点名追加来源备注', type: 'bool', hint: '如「节点名 [example.com]」，便于追溯来源。' },
  { group: '转换', key: 'converter.udp', label: '节点默认 UDP', type: 'bool', hint: '' },
  { group: '转换', key: 'converter.sort', label: '默认排序', type: 'select', options: ['', 'name', 'name_desc'], hint: '' },
  { group: '转换', key: 'converter.include', label: '默认包含（正则）', type: 'text', hint: '只保留名称匹配的节点，如 香港|HK。' },
  { group: '转换', key: 'converter.exclude', label: '默认排除（正则）', type: 'text', hint: '去掉名称匹配的节点，如 测试|过期。' },
  { group: '转换', key: 'converter.rename_prefix', label: '默认名称前缀', type: 'text', hint: '' },
  { group: '转换', key: 'converter.rename_suffix', label: '默认名称后缀', type: 'text', hint: '' },
  { group: '转换', key: 'converter.skip_failed', label: '失败订阅跳过继续', type: 'bool', hint: '多个订阅源时，单个失败不影响整体输出。' },
  { group: '转换', key: 'converter.clash.select_group_name', label: 'Clash 手动选择组名', type: 'text', hint: '' },
  { group: '转换', key: 'converter.clash.auto_group_name', label: 'Clash 自动测速组名', type: 'text', hint: '' },
  { group: '转换', key: 'converter.clash.url_test_url', label: '测速探测地址', type: 'text', hint: 'Clash 客户端自动选组用的 URL。' },
  { group: '转换', key: 'converter.clash.url_test_interval', label: '测速间隔（秒）', type: 'number', hint: '' },
  { group: '检测', key: 'probe.enabled', label: '可用性检测默认开启', type: 'bool', hint: '' },
  { group: '检测', key: 'probe.upstream_proxy', label: '上游探测代理（http/socks5）', type: 'text', hint: '配置后检测经代理 CONNECT 完成，适合本机无法直连目标网络的环境；留空则直连（回退抓取代理）。' },
  { group: '检测', key: 'probe.concurrency', label: '检测并发数', type: 'number', hint: '并发过高可能被服务商限流。' },
  { group: '检测', key: 'probe.timeout_ms', label: '单节点超时（毫秒）', type: 'number', hint: '' },
  { group: '检测', key: 'probe.drop_unreachable', label: '剔除不可达节点', type: 'bool', hint: '仅在当前输出剔除，节点池仍保留。' },
  { group: '检测', key: 'probe.speed_test', label: 'http/socks5 节点真实测速', type: 'bool', hint: '开启后对 http/socks5 节点做真实下载测速（较慢）。' },
  { group: '检测', key: 'probe.speed_test_url', label: '测速下载地址', type: 'text', hint: '' },
  { group: '检测', key: 'probe.speed_test_bytes', label: '测速采样字节数', type: 'number', hint: '' },
  { group: '检测', key: 'probe.append_latency', label: '延迟追加到节点名', type: 'bool', hint: '如「节点 [120ms]」。' },
  { group: '订阅源', key: 'subscription.main_urls', label: '主订阅地址（每行一个）', type: 'list', hint: '/sub 自动合并这些地址；外部无法看到上游地址。支持多个。' },
  { group: '订阅源', key: 'subscription.extra_sources', label: '其他订阅链接（每行：名称|URL）', type: 'list', hint: '自动拉取入池补充节点库；是否输出由节点池/规则决定。' },
  { group: '订阅源', key: 'subscription.merge_main_urls', label: '主订阅结果直接并入输出', type: 'bool', hint: '关闭时主订阅仅作为节点池来源，不直接输出。' },
  { group: '订阅源', key: 'subscription.include_pool', label: '输出包含节点池', type: 'bool', hint: '关闭则 /sub 不并入节点池累积节点。' },
  { group: '订阅源', key: 'subscription.default_target', label: '订阅源默认格式', type: 'select', options: ['clash', 'singbox', 'links', 'v2ray'], hint: '' },
  { group: '订阅源', key: 'subscription.probe_by_default', label: '订阅源默认启用检测', type: 'bool', hint: '可用 ?probe=1/0 覆盖。' },
  { group: '订阅源', key: 'subscription.cache_seconds', label: '订阅源缓存（秒）', type: 'number', hint: '0 不缓存；节点池更新自动失效。' },
  { group: '订阅源', key: 'subscription.name', label: '订阅源名称', type: 'text', hint: '显示在 Clash 等客户端的订阅名。' },
  { group: '订阅源', key: 'subscription.rules', label: '自定义选取规则（从节点池取节点）', type: 'list', hint: 'JSON/YAML 规则数组，每行一个规则；也可在链接后加 &rules= 覆盖。' },
  { group: '节点池', key: 'pool.drop_unreachable', label: '输出时剔除检测不可达', type: 'bool', hint: '仅影响输出，节点池本身保留全部节点。' },
  { group: '节点池', key: 'pool.default_enabled', label: '新节点默认启用', type: 'bool', hint: '关闭则新抓取入库的节点默认停用（不输出到订阅）。' },
  { group: '节点池', key: 'pool.include_disabled', label: '输出包含已停用节点', type: 'bool', hint: '也可用订阅链接加 &include_disabled=1 临时包含。' },
  { group: '节点池', key: 'pool.quality_enabled', label: '质量门槛自动开关', type: 'bool', hint: '开启后每次测速完成自动按门槛停用不合格节点、启用合格节点。' },
  { group: '节点池', key: 'pool.quality_mode', label: '质量判定模式', type: 'select', options: ['all', 'any'], hint: 'all 全部门槛通过才算合格；any 任一通过即算合格。' },
  { group: '节点池', key: 'pool.quality_default_pass', label: '未测节点默认放行', type: 'bool', hint: '避免刚入库未测速的节点被误停用。' },
  { group: '节点池', key: 'pool.quality_gates', label: '质量门槛列表（每行一条）', type: 'list', hint: 'alive / latency / speed / score / name 类型，如 { type:"latency", max_ms:500 }。' },
  { group: '节点池', key: 'pool.cleanup_enabled', label: '自动清理（按规则删除）', type: 'bool', hint: '默认关闭（保留全部）；开启后测速/刷新时按 cleanup_rules 自动删除。' },
  { group: '节点池', key: 'pool.cleanup_rules', label: '清理规则（每行一条）', type: 'list', hint: '满足任一规则即删除：unreachable / stale / no_probe / latency / speed / score / name / source。' },
  { group: '安全', key: 'security.api_token', label: '管理员令牌（完全访问）', type: 'text', hint: '留空则未配置令牌（开放模式）；建议设置。' },
  { group: '安全', key: 'security.user_token', label: '普通用户令牌（仅转换/订阅）', type: 'text', hint: '设置时务必同时设置管理员令牌。' },
  { group: '安全', key: 'security.admin_username', label: '管理员登录账号', type: 'text', hint: '登录页「账号密码」方式使用；留空禁用该方式。' },
  { group: '安全', key: 'security.admin_password', label: '管理员登录密码', type: 'text', hint: '登录成功返回管理员令牌。' },
  { group: '安全', key: 'security.user_username', label: '普通用户登录账号', type: 'text', hint: '' },
  { group: '安全', key: 'security.user_password', label: '普通用户登录密码', type: 'text', hint: '' },
  { group: '存储与日志', key: 'storage.driver', label: '存储驱动', type: 'select', options: ['file'], hint: '当前支持文件存储；可扩展数据库驱动。' },
  { group: '存储与日志', key: 'fetch_log.capacity', label: '事件日志容量（条）', type: 'number', hint: '超限自动丢弃最旧记录。' },
  { group: '存储与日志', key: 'logging.level', label: '日志级别', type: 'select', options: ['trace', 'debug', 'info', 'warn', 'error'], hint: '' },
];

let currentConfig = null;

/** 渲染字段组（支持分组标题 + 搜索过滤） */
function renderFields(containerId, fields, config, filter) {
  const box = $(containerId);
  if (!box) return;
  const kw = (filter || '').trim().toLowerCase();
  const list = kw
    ? fields.filter((f) =>
        (f.label || '').toLowerCase().includes(kw) ||
        f.key.toLowerCase().includes(kw) ||
        (f.hint || '').toLowerCase().includes(kw) ||
        (f.group || '').toLowerCase().includes(kw))
    : fields;
  if (!list.length) {
    box.innerHTML = '<p class="hint">没有匹配的参数</p>';
    return;
  }
  let html = '';
  let lastGroup = '';
  for (const field of list) {
    if (field.group && field.group !== lastGroup) {
      lastGroup = field.group;
      html += `<div class="group-title">${escapeHtml(field.group)}</div>`;
    }
    const value = getByPath(config, field.key);
    const id = 'cfg-' + containerId + '-' + field.key.replace(/\./g, '-');
    let input;
    if (field.type === 'bool') {
      const opts = [true, false].map((v) =>
        `<option value="${v}" ${Boolean(value) === v ? 'selected' : ''}>${v ? '开启' : '关闭'}</option>`).join('');
      input = `<select id="${id}" data-key="${field.key}" data-kind="bool">${opts}</select>`;
    } else if (field.type === 'select') {
      const opts = field.options.map((v) =>
        `<option value="${escapeHtml(v)}" ${String(value) === String(v) ? 'selected' : ''}>${v === '' ? '（默认）' : escapeHtml(v)}</option>`).join('');
      input = `<select id="${id}" data-key="${field.key}" data-kind="select">${opts}</select>`;
    } else if (field.type === 'list') {
      const v = Array.isArray(value) ? value.join('\n') : (value || '');
      input = `<textarea id="${id}" data-key="${field.key}" data-kind="list" rows="3">${escapeHtml(v)}</textarea>`;
    } else if (field.type === 'json') {
      let v = '';
      try { v = value && typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value || ''); } catch { v = ''; }
      input = `<textarea id="${id}" data-key="${field.key}" data-kind="json" rows="5" spellcheck="false">${escapeHtml(v)}</textarea>`;
    } else {
      const masked = (field.key === 'security.api_token' || field.key === 'security.user_token' ||
        field.key === 'security.admin_password' || field.key === 'security.user_password') && value
        ? '******' : (value != null ? String(value) : '');
      input = `<input id="${id}" data-key="${field.key}" data-kind="${field.type || 'text'}" type="${field.type === 'number' ? 'number' : 'text'}" value="${escapeHtml(masked)}">`;
    }
    html += `<div class="field">
      <label for="${id}">${escapeHtml(field.label)}</label>
      ${input}
      ${field.hint ? `<p class="hint">${escapeHtml(field.hint)}</p>` : ''}
    </div>`;
  }
  box.innerHTML = html;
}

/** 收集字段组为配置片段（掩码值不提交；list 转数组） */
function collectFields(containerId) {
  const patch = {};
  document.querySelectorAll(`#${containerId} [data-key]`).forEach((input) => {
    const key = input.dataset.key;
    const kind = input.dataset.kind || 'text';
    if ((key === 'security.api_token' || key === 'security.user_token' ||
         key === 'security.admin_password' || key === 'security.user_password') && input.value === '******') return;
    let value;
    if (kind === 'bool') value = input.value === 'true';
    else if (kind === 'number') value = input.value === '' ? '' : Number(input.value);
    else if (kind === 'list') value = input.value.split('\n').map((s) => s.trim()).filter(Boolean);
    else value = input.value;
    setByPath(patch, key, value);
  });
  return patch;
}

async function loadConfig() {
  try {
    const d = await apiJson('/api/config');
    currentConfig = d.config;
    renderFields('config-fields', CONFIG_FIELDS, currentConfig, $('config-search').value);
    renderFields('ln-fields', LOCALNODE_FIELDS, currentConfig);
    renderFields('ln-cf-fields', CF_TUNNEL_FIELDS, currentConfig);
    if (window.__syncQualityUi) window.__syncQualityUi();
    if (window.__syncCleanupUi) window.__syncCleanupUi();
  } catch (err) {
    toast('加载配置失败：' + err.message, true);
  }
}

function initConfig() {
  $('config-search').addEventListener('input', () => {
    renderFields('config-fields', CONFIG_FIELDS, currentConfig, $('config-search').value);
  });
  $('btn-reload-config').addEventListener('click', loadConfig);
  $('btn-save-config').addEventListener('click', async () => {
    const patch = collectFields('config-fields');
    if (!Object.keys(patch).length) { toast('没有可保存的修改', true); return; }
    try {
      await apiJson('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      toast('配置已保存并生效');
      await loadConfig();
      loadDashboard();
      loadLogs(true);
    } catch (err) {
      toast('保存失败：' + err.message, true);
    }
  });

  // 专家：配置原文 YAML
  $('btn-raw-load').addEventListener('click', async () => {
    try {
      const resp = await apiFetch('/api/config/raw');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      $('config-raw').value = await resp.text();
      toast('已加载配置原文');
    } catch (err) {
      toast('加载失败：' + err.message, true);
    }
  });
  $('btn-raw-save').addEventListener('click', async () => {
    try {
      await apiJson('/api/config/raw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: $('config-raw').value }) });
      toast('配置原文已保存并生效');
      await loadConfig();
    } catch (err) {
      toast('保存失败：' + err.message, true);
    }
  });
}

/* ============================================================
   模板管理
   ============================================================ */
async function loadTemplateList() {
  try {
    const d = await apiJson('/api/templates');
    const sel = $('template-select');
    sel.innerHTML = (d.files || []).map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
    if (sel.options.length && !sel.value) sel.value = sel.options[0].value;
  } catch (err) {
    toast('加载模板列表失败：' + err.message, true);
  }
}
function initTemplates() {
  $('btn-tpl-load').addEventListener('click', async () => {
    const name = $('template-select').value;
    if (!name) { toast('请先选择模板', true); return; }
    try {
      const d = await apiJson('/api/templates/' + encodeURIComponent(name));
      $('template-editor').value = d.content || '';
    } catch (err) {
      toast('加载模板失败：' + err.message, true);
    }
  });
  $('btn-tpl-save').addEventListener('click', async () => {
    const name = $('template-select').value;
    if (!name) { toast('请先选择模板', true); return; }
    try {
      await apiJson('/api/templates/' + encodeURIComponent(name), {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: $('template-editor').value,
      });
      toast('模板已保存');
    } catch (err) {
      toast('保存模板失败：' + err.message, true);
    }
  });
}

/* ============================================================
   备份与迁移
   ============================================================ */
function initBackup() {
  $('btn-backup').addEventListener('click', async () => {
    try {
      const resp = await apiFetch('/api/backup');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const text = await resp.text();
      const blob = new Blob([text], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'subbridge-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('备份已导出');
    } catch (err) {
      toast('导出失败：' + err.message, true);
    }
  });

  $('restore-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!window.confirm('导入备份将覆盖当前配置/模板/隧道凭据并重启服务，确定继续？')) {
      e.target.value = '';
      return;
    }
    try {
      const text = await file.text();
      await apiJson('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
      toast('备份导入成功，配置已生效');
      e.target.value = '';
      await loadConfig();
      loadDashboard();
      if (currentRole === 'admin') loadLogs(true);
    } catch (err) {
      toast('导入失败：' + err.message, true);
      e.target.value = '';
    }
  });
  $('btn-restore').addEventListener('click', () => $('restore-file').click());
}

/* ============================================================
   初始化
   ============================================================ */
async function init() {
  initTheme();
  initMode();
  initLogin();
  initGrab();
  initDebug();
  initPool();
  initRules();
  initQuality();
  initCleanup();
  initLogs();
  initLocalNode();
  initConfig();
  initTemplates();
  initBackup();
  await identifyRole();
  loadPresets();
}
document.addEventListener('DOMContentLoaded', init);
