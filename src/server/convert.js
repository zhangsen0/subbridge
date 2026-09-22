'use strict';

/**
 * /convert 与 /sub 共用的转换核心逻辑
 *
 * 流程：解析参数 -> 抓取订阅（可选经本机节点自中继） -> 探测格式并解析节点
 *       -> 过滤/去重/排序/重命名 -> 可用性检测（可选） -> 注入本机节点 -> 转换输出
 */

const { Fetcher } = require('../core/fetcher');
const { parseSubscription } = require('../parsers');
const { applyPipeline } = require('../core/pipeline');
const { runChecks } = require('../probe/checker');
const { safeHeaderValue } = require('../core/util');
const converters = require('../converters');

/**
 * 从请求中提取订阅地址列表
 * 支持：多个 url 参数、逗号/分号/换行分隔
 */
function extractUrls(urlValue) {
  const values = Array.isArray(urlValue) ? urlValue : [urlValue];
  const urls = [];
  for (const v of values) {
    if (!v) continue;
    for (const part of String(v).split(/[,;\n]/)) {
      const trimmed = part.trim();
      if (trimmed) urls.push(trimmed);
    }
  }
  return urls;
}

/** 从查询参数构建转换选项（配置为默认值，请求参数可覆盖） */
function buildOptions(query, config) {
  const conv = (config.converter || {});
  const probeCfg = (config.probe || {});
  const toBool = (v, def) => {
    if (v === undefined || v === '') return def;
    return v === 'true' || v === '1';
  };

  return {
    name: query.name || '',
    target: (query.target || conv.default_target || 'clash').toLowerCase(),
    include: query.include !== undefined ? query.include : conv.include || '',
    exclude: query.exclude !== undefined ? query.exclude : conv.exclude || '',
    prefix: query.prefix !== undefined ? query.prefix : conv.rename_prefix || '',
    suffix: query.suffix !== undefined ? query.suffix : conv.rename_suffix || '',
    udp: toBool(query.udp, conv.udp !== false),
    sort: query.sort !== undefined ? query.sort : conv.sort || '',
    dedupe: toBool(query.dedupe, conv.dedupe !== false),
    selectGroupName: query.selectGroupName || (conv.clash && conv.clash.select_group_name) || '',
    autoGroupName: query.autoGroupName || (conv.clash && conv.clash.auto_group_name) || '',
    template: query.template || '',
    probe: toBool(query.probe, !!probeCfg.enabled),
  };
}

/**
 * 计算抓取器生效配置：启用"自中继采集"且未显式配置上游代理时，
 * 通过本机 HTTP 代理节点中转抓取（顺带验证本机节点可用）。
 */
function effectiveFetcherConfig(config, ctx) {
  const fetcher = (config.fetcher || {});
  if (fetcher.relay_through_localnode && ctx.localnode && !fetcher.upstream_proxy) {
    const localUrl = ctx.localnode.localProxyUrl();
    if (localUrl) return { ...fetcher, upstream_proxy: localUrl };
  }
  return fetcher;
}

/**
 * 并发抓取多个订阅地址（受 fetcher.max_concurrency 限制）
 * @returns {Promise<Array<{url: string, nodes?: Array, error?: string}>>}
 */
async function fetchAll(urls, fetcher, config) {
  const maxConcurrency = Math.max(1, Number((config.fetcher || {}).max_concurrency) || 5);
  const results = new Array(urls.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < urls.length) {
      const idx = cursor++;
      const url = urls[idx];
      try {
        const content = await fetcher.fetchText(url);
        const { nodes } = parseSubscription(content);
        results[idx] = { url, nodes };
      } catch (err) {
        results[idx] = { url, error: `[${url}] ${err.message}` };
      }
    }
  };

  const workers = [];
  for (let i = 0; i < Math.min(maxConcurrency, urls.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * 可用性检测：TCP 连通性（全部节点）+ 真实测速（http/socks5 节点）
 * 按配置剔除不可达节点、追加延迟后缀。
 */
async function applyProbe(nodes, config, warnings) {
  const probeCfg = (config.probe || {});
  if (!nodes.length) return nodes;

  const checked = await runChecks(nodes, {
    concurrency: probeCfg.concurrency || 10,
    timeoutMs: probeCfg.timeout_ms || 3000,
    speedTest: !!probeCfg.speed_test,
    speedTestUrl: probeCfg.speed_test_url,
    speedTestBytes: probeCfg.speed_test_bytes,
  });

  let alive = checked.filter((n) => !n.probe || n.probe.alive);
  const deadCount = checked.length - alive.length;
  if (deadCount) warnings.push(`可用性检测：${deadCount} 个节点不可达`);

  if (probeCfg.append_latency) {
    alive = alive.map((n) => {
      if (!n.probe || n.probe.latencyMs == null) return n;
      const clone = Object.assign(Object.create(Object.getPrototypeOf(n)), n);
      clone.name = `${n.name} [${n.probe.latencyMs}ms]`;
      return clone;
    });
  }

  return probeCfg.drop_unreachable === false ? checked : alive;
}

/**
 * 构建转换结果（/convert 与 /sub 共用）
 * @param {string[]} urls 订阅地址列表
 * @param {object} opts 转换选项（buildOptions 输出）
 * @param {{config: object, templatesDir: string, store: object, localnode?: object}} ctx
 * @returns {Promise<{output: string, warnings: string[]}>}
 */
async function buildConverted(urls, opts, ctx) {
  const config = ctx.config;
  const warnings = [];
  const nodes = [];

  if (urls.length) {
    // 1. 抓取并解析（可选经本机节点自中继）
    const fetcher = new Fetcher({ fetcher: effectiveFetcherConfig(config, ctx) });
    const results = await fetchAll(urls, fetcher, config);

    const skipFailed = (config.converter || {}).skip_failed !== false;
    for (const r of results) {
      if (r.error) {
        warnings.push(r.error);
        if (!skipFailed) {
          const err = new Error('订阅抓取失败');
          err.detail = warnings;
          throw err;
        }
        continue;
      }
      if (r.nodes && r.nodes.length) nodes.push(...r.nodes);
      else warnings.push(`[${r.url}] 未能从订阅内容中解析出任何节点`);
    }

    if (!nodes.length) {
      const err = new Error('所有订阅均未解析出可用节点');
      err.detail = warnings;
      throw err;
    }
  } else {
    // 未配置任何订阅地址：允许仅返回本机节点（本机作为订阅源使用）
    warnings.push('未配置主订阅地址，仅返回本机节点');
  }

  // 2. 过滤/去重/排序/重命名
  let processed = applyPipeline(nodes, opts);

  // 3. 可用性检测（可选）
  if (opts.probe) {
    processed = await applyProbe(processed, config, warnings);
  }

  // 4. 注入本机节点（Clash / sing-box 目标；本机作为订阅节点使用）
  if (ctx.localnode && ['clash', 'singbox'].includes(opts.target)) {
    let localNodes = [];
    try {
      localNodes = await ctx.localnode.localNodes();
    } catch (err) {
      warnings.push(`本机节点注入失败: ${err.message}`);
    }
    if (localNodes.length) processed.push(...localNodes);
  }

  // 5. 转换输出
  let output;
  try {
    output = await converters.convert(opts.target, processed, opts, ctx);
  } catch (err) {
    throw new Error(`转换失败: ${err.message}`);
  }
  return { output, warnings };
}

/** 校验请求参数，返回错误字符串或空串 */
function validate(query, config) {
  const opts = buildOptions(query, config);
  if (!opts.target) return '缺少目标格式';
  if (!converters.TARGETS[opts.target]) {
    return `不支持的目标格式: ${opts.target}（可选：${converters.TARGET_NAMES.join(' / ')}）`;
  }
  // 校验正则合法性
  for (const key of ['include', 'exclude']) {
    if (opts[key]) {
      try {
        new RegExp(opts[key]);
      } catch {
        return `无效的正则表达式(${key}): ${opts[key]}`;
      }
    }
  }
  return '';
}

/**
 * /convert 处理器
 * @param {import('fastify').FastifyRequest} req
 * @param {import('fastify').FastifyReply} reply
 * @param {object} ctx
 */
async function handleConvert(req, reply, ctx) {
  const config = ctx.config;
  const query = req.query || {};

  // 参数校验
  const invalid = validate(query, config);
  if (invalid) return reply.code(400).send({ error: invalid });

  const urls = extractUrls(query.url);
  if (!urls.length) {
    return reply.code(400).send({ error: '缺少 url 参数（订阅地址）' });
  }

  const opts = buildOptions(query, config);
  let result;
  try {
    result = await buildConverted(urls, opts, ctx);
  } catch (err) {
    if (err.detail) return reply.code(502).send({ error: err.message, detail: err.detail });
    return reply.code(500).send({ error: err.message });
  }

  const headers = { 'content-type': converters.contentTypeFor(opts.target) };
  if (result.warnings.length) headers['x-subbridge-warnings'] = result.warnings.map(safeHeaderValue).join(' | ');
  return reply.code(200).headers(headers).send(result.output);
}

module.exports = { handleConvert, buildConverted, extractUrls, buildOptions, fetchAll };
