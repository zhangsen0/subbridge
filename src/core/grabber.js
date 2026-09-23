'use strict';

/**
 * 抓取中心：把"任意来源"转换为节点列表
 *
 * 来源类型自动识别，无需用户指定：
 *   1. http(s) 链接
 *      a. 订阅内容（base64 / Clash YAML / V2RayN JSON / 行式分享链接）→ 直接解析
 *      b. HTML 网页 → 提取页面内嵌节点文本，并自动发现页面内的订阅链接递归抓取
 *   2. 非链接文本（直接粘贴的节点 / 订阅内容）→ 按订阅格式自动识别
 *
 * 递归抓取的深度、链接数量上限、订阅链接特征关键词均可配置（禁止写死）。
 * 每次抓取（含递归子链接）都会产出 history 条目，由调用方写入抓取日志。
 */

const { parseSubscription } = require('../parsers');
const { findAdapter } = require('../grabbers');
const { parseSourceOptions, PROTOCOL_NAMES } = require('./sourceOptions');

/** 判断文本是否为 HTML 网页 */
function isHtml(text) {
  return /<(?:!doctype|html|head|body|a\s|script|iframe)[\s>]/i.test(String(text || '').slice(0, 4096));
}

/**
 * 从 HTML 中提取全部 http(s) 链接
 * @param {string} html
 * @returns {string[]} 去重后的链接列表
 */
function extractLinks(html) {
  const seen = new Set();
  const re = /https?:\/\/[^\s"'<>()\[\]{}]+/g;
  let m;
  while ((m = re.exec(html))) {
    // 去掉常见尾部标点，避免把句号/逗号带进链接
    const url = m[0].replace(/[),.;，。]+$/, '');
    if (url) seen.add(url);
  }
  return [...seen];
}

/**
 * 判断链接是否"看起来像订阅地址"（路径特征关键词可配置）
 * @param {string} url
 * @param {string[]} keywords 特征关键词
 * @returns {boolean}
 */
function looksLikeSubLink(url, keywords = []) {
  if (!keywords.length) return false;
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (/\.(txt|yaml|yml|json|conf|clash)$/.test(path)) return true;
    return keywords.some((kw) => path.includes(kw));
  } catch {
    return false;
  }
}

/** 判断是否为 http(s) 链接 */
function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 抓取单个来源（http(s) 链接 或 直接文本）
 * @param {string} source 链接或文本
 * @param {object} opts
 * @param {object} opts.fetcher 抓取器实例（含 fetchMeta）
 * @param {object} opts.config 生效配置（取 grab 配置段）
 * @param {Set<string>} [opts.seen] 已抓取链接去重集合（跨递归共享）
 * @param {number} [opts.depth] 当前递归深度（0 起）
 * @param {Array} [opts.history] 抓取历史（每条：url/status/bytes/nodes/error/kind/ms）
 * @returns {Promise<{nodes: Array, kind: string}>}
 */
async function fetchSource(source, opts) {
  const fetcher = opts.fetcher;
  const grabCfg = (opts.config && opts.config.grab) || {};
  const maxDepth = Math.max(0, Number(grabCfg.max_depth) || 0);
  const maxLinks = Math.max(0, Number(grabCfg.max_links) || 0);
  const keywords = Array.isArray(grabCfg.link_keywords) ? grabCfg.link_keywords : [];
  const seen = opts.seen || new Set();
  const history = opts.history || [];
  const depth = opts.depth || 0;

  // 来源预处理：展开日期变量（{Y_m_d} 等）+ 解析 |后缀（links=按行拆源，协议名=结果过滤）
  const { url: srcUrl, suffix } = parseSourceOptions(source);

  // 直接文本（非链接）：按订阅格式识别
  if (!isHttpUrl(srcUrl)) {
    const { nodes, format } = parseSubscription(srcUrl);
    for (const n of nodes) n.source = '文本输入';
    history.push({ url: '', kind: 'text', format, nodes: nodes.length, error: '', durationMs: 0 });
    return { nodes, kind: 'text' };
  }

  // http(s) 链接：按域名路由到站点适配器（优先），否则按内容分类
  const started = Date.now();
  let hostname = '';
  try {
    hostname = new URL(srcUrl).hostname;
  } catch {
    hostname = '';
  }
  const adapter = findAdapter(hostname);

  // |links 模式：拉取内容后按行拆分为独立订阅链接，逐个递归抓取（不要求订阅特征关键词）
  if (suffix === 'links') {
    let linkText = '';
    try {
      const meta = await fetcher.fetchMeta(adapter && adapter.normalizeUrl ? adapter.normalizeUrl(srcUrl) : srcUrl);
      linkText = meta.text || '';
    } catch (err) {
      history.push({ url: srcUrl, kind: 'links', error: err.message, durationMs: Date.now() - started });
      throw err;
    }
    const lineUrls = [];
    for (const line of String(linkText).split(/\r?\n/)) {
      const u = line.trim();
      if (isHttpUrl(u) && !seen.has(u)) lineUrls.push(u);
    }
    const nodes = [];
    let discovered = 0;
    for (const link of lineUrls.slice(0, maxLinks || lineUrls.length)) {
      seen.add(link);
      discovered += 1;
      try {
        const sub = await fetchSource(link, { fetcher, config: opts.config, seen, depth: depth + 1, history });
        nodes.push(...sub.nodes);
      } catch {
        // 子链接失败不阻断主流程
      }
    }
    history.push({
      url: srcUrl, kind: 'links', format: 'links', nodes: nodes.length,
      discoveredLinks: discovered, error: '', durationMs: Date.now() - started,
    });
    return { nodes, kind: 'links' };
  }

  let meta;
  try {
    meta = await fetcher.fetchMeta(adapter && adapter.normalizeUrl ? adapter.normalizeUrl(srcUrl) : srcUrl);
  } catch (err) {
    history.push({ url: srcUrl, kind: 'url', error: err.message, durationMs: Date.now() - started });
    throw err;
  }
  const { text, status, bytes, contentType } = meta;
  const base = {
    url: srcUrl,
    httpStatus: status,
    bytes,
    durationMs: Date.now() - started,
  };

  // |协议名 后缀：抓取后按协议过滤（如 proxypool.link/ss/sub|ss 只保留 ss 节点）
  const filterProtocol = PROTOCOL_NAMES.has(suffix) ? suffix : '';

  // 站点专用解析（如 vpngate）
  if (adapter) {
    const parsed = adapter.parse(text);
    let nodes = parsed.nodes || [];
    for (const n of nodes) n.source = srcUrl;
    if (filterProtocol) nodes = nodes.filter((n) => n.type === filterProtocol);
    history.push({ ...base, kind: 'site', format: parsed.format, nodes: nodes.length, error: '' });
    return { nodes, kind: 'site' };
  }

  // HTML 网页：提取内嵌节点 + 发现订阅链接递归
  if (isHtml(text)) {
    let nodes = parseSubscription(text).nodes;
    if (filterProtocol) nodes = nodes.filter((n) => n.type === filterProtocol);
    for (const n of nodes) n.source = srcUrl;
    let discovered = 0;
    const candidates = extractLinks(text).filter((u) => !seen.has(u) && looksLikeSubLink(u, keywords));
    if (depth < maxDepth) {
      for (const link of candidates.slice(0, maxLinks || candidates.length)) {
        seen.add(link);
        discovered += 1;
        try {
          const sub = await fetchSource(link, { fetcher, config: opts.config, seen, depth: depth + 1, history });
          nodes.push(...sub.nodes);
        } catch {
          // 子链接失败不阻断主流程（错误已在 history 记录）
        }
      }
    }
    history.push({ ...base, kind: 'web', format: 'web', nodes: nodes.length, discoveredLinks: discovered, error: '' });
    return { nodes, kind: 'web' };
  }

  // 订阅内容
  const parsed = parseSubscription(text);
  let nodes = parsed.nodes || [];
  if (filterProtocol) nodes = nodes.filter((n) => n.type === filterProtocol);
  for (const n of nodes) n.source = srcUrl;
  history.push({ ...base, kind: 'subscription', format: parsed.format, nodes: nodes.length, error: '' });
  return { nodes, kind: 'subscription' };
}

/**
 * 并发抓取多个来源（链接或文本），合并节点
 * @param {string[]} sources
 * @param {object} opts 同 fetchSource（fetcher/config 必填）
 * @returns {Promise<{nodes: Array, history: Array, errors: Array}>}
 */
async function fetchSources(sources, opts) {
  const history = [];
  const seen = new Set();
  const errors = [];
  const nodes = [];
  const maxConcurrency = Math.max(1, Number(((opts.config || {}).fetcher || {}).max_concurrency) || 5);
  let cursor = 0;

  const worker = async () => {
    while (cursor < sources.length) {
      const idx = cursor++;
      const source = sources[idx];
      try {
        const r = await fetchSource(source, { ...opts, seen, history });
        nodes.push(...r.nodes);
      } catch (err) {
        errors.push({ source, error: err.message });
      }
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(maxConcurrency, sources.length); i++) workers.push(worker());
  await Promise.all(workers);
  return { nodes, history, errors };
}

module.exports = {
  isHtml,
  extractLinks,
  looksLikeSubLink,
  isHttpUrl,
  fetchSource,
  fetchSources,
};
