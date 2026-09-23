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
    appendSource: toBool(query.append_source, conv.append_source !== false),
    // 请求级自定义头（JSON 对象文本，覆盖 fetcher.headers 全局配置）
    headers: query.headers !== undefined && query.headers !== '' ? query.headers : '',
    // 自定义选取规则（从节点池/抓取结果按规则挑选），JSON/YAML 数组文本
    rules: query.rules !== undefined && query.rules !== '' ? query.rules : '',
    selectGroupName: query.selectGroupName || (conv.clash && conv.clash.select_group_name) || '',
    autoGroupName: query.autoGroupName || (conv.clash && conv.clash.auto_group_name) || '',
    template: query.template || '',
    probe: toBool(query.probe, !!probeCfg.enabled),
  };
}

/**
 * 计算抓取器生效配置（异步，需查节点池）：
 *   抓取代理优先级（"先本机直连，拉取失败才用节点池代理"）：
 *   1. 显式配置 fetcher.upstream_proxy 优先（用户明确指定的转发代理，最高优先）
 *   2. 未显式配置时，主候选为「本机直连」，同时从节点池挑选可用 http 代理作为回退候选
 *      （fetcher.fallback_proxy = 节点池代理；"抓取外部节点的代理也从节点池出"）
 *   3. 启用"自中继采集"时，本机 HTTP 代理节点作为主候选（本机中转也属本地优先）
 *   4. fetcher.pool_empty_fallback_direct 为 false 时：节点池无可用代理则直接失败（不直连）
 */
async function effectiveFetcherConfig(config, ctx) {
  const fetcher = (config.fetcher || {});
  const result = { ...fetcher };

  // 1. 显式配置的上游代理优先（不再叠加回退链，用户指定即最高优先）
  if (fetcher.upstream_proxy) {
    delete result.fallback_proxy;
    return result;
  }

  // 2. 从节点池挑选回退代理（默认开启，可配置关闭）
  if (fetcher.proxy_from_pool !== false && ctx.nodePool) {
    try {
      const { pickProxyFromPool } = require('../core/poolProxy');
      const types = Array.isArray(fetcher.proxy_pool_types) && fetcher.proxy_pool_types.length
        ? fetcher.proxy_pool_types
        : ['http'];
      const picked = await pickProxyFromPool(ctx.nodePool, { types });
      if (picked) {
        result.fallback_proxy = picked.url;
        result._pool_proxy = picked.node;
      }
    } catch {
      /* 池选代理失败时继续尝试其他方式 */
    }
  }

  // 3. 本机节点自中继：本机代理作为主候选（本地优先，无需远端节点）
  if (fetcher.relay_through_localnode && ctx.localnode) {
    const localUrl = ctx.localnode.localProxyUrl();
    if (localUrl) result.upstream_proxy = localUrl;
  }

  // 4. 池空回退直连：要求"无代理即失败"时，若节点池没选出回退代理则标记阻塞
  if (fetcher.pool_empty_fallback_direct === false && !result.upstream_proxy && !result.fallback_proxy) {
    result.pool_empty_blocked = true;
  }
  return result;
}

/**
 * 抓取多个来源（链接或文本）并写入抓取日志（兼容旧结构，供测试与外部调用）
 * 返回结果数组：{url, nodes?, error?}
 */
async function fetchAll(urls, fetcher, config, ctx = {}) {
  const { fetchSources } = require('../core/grabber');
  const { nodes, history, errors } = await fetchSources(urls, { fetcher, config });

  // 抓取日志：逐条写入（含网页递归发现的子链接）
  const via = fetcher.fetcherConfig && fetcher.fetcherConfig.upstream_proxy ? 'proxy' : 'direct';
  if (ctx.fetchLog) {
    for (const h of history) ctx.fetchLog.record({ ...h, via });
    for (const e of errors) ctx.fetchLog.record({ url: e.source, error: e.error, via });
  }

  return urls.map((url) => {
    const err = errors.find((e) => e.source === url);
    if (err) return { url, error: `[${url}] ${err.error}` };
    return { url, nodes };
  });
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
    // 上游探测代理：探测配置优先，回退抓取配置（沙箱/受限网络经代理探测）
    proxyUrl: probeCfg.upstream_proxy || (config.fetcher && config.fetcher.upstream_proxy) || '',
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
 * @param {{config: object, templatesDir: string, store: object, localnode?: object, nodePool?: object, fetchLog?: object}} ctx
 * @param {{extraNodes?: Array}} [options] extraNodes：预置节点（如 /sub 合并节点池），在抓取结果之后并入
 * @returns {Promise<{output: string, warnings: string[], nodes: Array}>}
 */
async function buildConverted(urls, opts, ctx, { extraNodes = [] } = {}) {
  const config = ctx.config;
  const warnings = [];
  const nodes = [];
  const fetchedNodes = [];
  let poolStats = null;

  if (urls.length) {
    // 1. 抓取并解析（上游代理优先：显式配置 → 节点池挑选 → 本机节点自中继）
    const fetcherCfg = await effectiveFetcherConfig(config, ctx);
    // 请求级自定义头（?headers=JSON）覆盖全局配置 fetcher.headers
    if (opts.headers) {
      try {
        const extra = JSON.parse(opts.headers);
        if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
          fetcherCfg.headers = { ...(fetcherCfg.headers || {}), ...extra };
        }
      } catch {
        /* 非法 JSON 头忽略，走全局配置 */
      }
    }
    const fetcher = new Fetcher({ fetcher: fetcherCfg });
    const { fetchSources } = require('../core/grabber');
    // 代理使用情况：池回退代理（优先展示）→ 显式/本机代理 → 直连
    const poolProxyNode = fetcher.fetcherConfig && fetcher.fetcherConfig._pool_proxy;
    const mainProxy = fetcher.fetcherConfig && fetcher.fetcherConfig.upstream_proxy;
    const via = poolProxyNode ? 'pool-proxy' : mainProxy ? 'proxy' : fetcher.fetcherConfig.pool_empty_blocked ? 'blocked' : 'direct';
    const proxyUsed = poolProxyNode
      ? `${poolProxyNode.type}://${poolProxyNode.server}:${poolProxyNode.port}`
      : mainProxy ? 'configured' : '';
    if (fetcher.fetcherConfig.pool_empty_blocked) {
      warnings.push('节点池无可用代理，且已关闭"池空回退直连"，本次抓取未执行');
      return { output: '', warnings, nodes: [] };
    }
    const { nodes: raw, history, errors } = await fetchSources(urls, { fetcher, config });

    // 抓取日志：逐条写入（含网页递归发现的子链接、使用的代理）
    if (ctx.fetchLog) {
      for (const h of history) ctx.fetchLog.record({ ...h, via, proxyUsed });
      for (const e of errors) ctx.fetchLog.record({ url: e.source, error: e.error, via, proxyUsed });
    }

    // 节点池：抓取结果补充/更新入库（不自动删除；新节点默认启用状态可配置）
    if (ctx.nodePool && raw.length) {
      try {
        poolStats = await ctx.nodePool.upsert(raw, {
          source: urls.join(', '),
          defaultEnabled: (config.pool || {}).default_enabled !== false,
        });
      } catch (err) {
        warnings.push(`节点池写入失败: ${err.message}`);
      }
    }

    fetchedNodes.push(...raw);
    const skipFailed = (config.converter || {}).skip_failed !== false;
    if (errors.length) {
      for (const e of errors) warnings.push(`[${e.source}] ${e.error}`);
      if (!skipFailed) {
        const err = new Error('订阅抓取失败');
        err.detail = warnings;
        throw err;
      }
    }
    // 内容为空告警（网页/订阅均未解析出节点）
    for (const h of history) {
      if (!h.error && h.nodes === 0) {
        warnings.push(`[${h.url || '文本输入'}] 未能从内容中解析出任何节点`);
      }
    }
  }

  // 2. 合并抓取结果与预置节点（节点池 / 主订阅）
  nodes.push(...fetchedNodes, ...extraNodes);

  if (!nodes.length) {
    if (urls.length) {
      const err = new Error('所有订阅均未解析出可用节点');
      err.detail = warnings;
      throw err;
    }
    // 未配置任何订阅地址：允许仅返回本机节点（本机作为订阅源使用）
    warnings.push('未配置主订阅地址，仅返回本机节点');
  }

  // 2.5 自定义选取规则（/convert、/api/grab 传入 ?rules= 时按规则从节点中挑选）
  if (opts.rules) {
    const { parseRules, applyRules } = require('../core/rules');
    const rules = parseRules(opts.rules);
    if (rules.length) {
      nodes.splice(0, nodes.length, ...applyRules(nodes, rules));
    }
  }

  // 3. 过滤/去重/排序/重命名
  let processed = applyPipeline(nodes, opts);

  // 提示目标格式不支持的节点类型（如 OpenVPN 无法转 Clash 节点，输出时会被跳过）
  const unsupported = converters.unsupportedTypes(opts.target, processed);
  if (unsupported.length) {
    warnings.push(`以下节点类型不支持输出为 ${opts.target}，已跳过：${unsupported.join(' / ')}（可在节点库查看与管理）`);
  }

  // 4. 可用性检测（可选）
  if (opts.probe) {
    processed = await applyProbe(processed, config, warnings);
    // 按测速延迟排序（需在检测之后；无数据节点排在最后）
    if (opts.sort === 'latency' || opts.sort === 'latency_desc') {
      const sorted = processed.slice().sort((a, b) => {
        const la = a.probe && a.probe.latencyMs != null ? a.probe.latencyMs : Number.POSITIVE_INFINITY;
        const lb = b.probe && b.probe.latencyMs != null ? b.probe.latencyMs : Number.POSITIVE_INFINITY;
        return opts.sort === 'latency_desc' ? lb - la : la - lb;
      });
      processed = sorted;
    }
  }

  // 5. 注入本机节点（Clash / sing-box 目标；本机作为订阅节点使用）
  if (ctx.localnode && ['clash', 'singbox'].includes(opts.target)) {
    let localNodes = [];
    try {
      localNodes = await ctx.localnode.localNodes();
    } catch (err) {
      warnings.push(`本机节点注入失败: ${err.message}`);
    }
    if (localNodes.length) processed.push(...localNodes);
  }

  // 6. 节点来源备注：默认在节点名后追加 [来源]，标明"从哪个来源抓的"（可配置关闭）
  if (opts.appendSource) {
    processed = processed.map((n) => {
      const label = sourceLabel(n.source);
      if (!label) return n;
      const clone = Object.assign(Object.create(Object.getPrototypeOf(n)), n);
      clone.name = `${n.name} [${label}]`;
      return clone;
    });
  }

  // 7. 转换输出
  let output;
  try {
    output = await converters.convert(opts.target, processed, opts, ctx);
  } catch (err) {
    throw new Error(`转换失败: ${err.message}`);
  }
  return { output, warnings, nodes: processed, poolStats };
}

/**
 * 把来源标记压缩为节点名后缀
 * 订阅/网页链接取主机名（去掉 www.），文本输入标记为"文本"
 * @param {string} source 节点来源标记
 * @returns {string} 展示用来源标签（空串表示无来源）
 */
function sourceLabel(source) {
  if (!source) return '';
  if (source === '文本输入') return '文本';
  try {
    return new URL(source).hostname.replace(/^www\./, '');
  } catch {
    return String(source).slice(0, 40);
  }
}

/** 校验请求参数，返回错误字符串或空串 */
function validate(query, config) {
  const opts = buildOptions(query, config);
  if (!opts.target) return '缺少目标格式';
  // 兼容分隔写法（target=clash|singbox|links|v2ray），取第一个有效值
  if (/[|,]/.test(opts.target)) opts.target = opts.target.split(/[|,]/)[0].trim();
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

module.exports = { handleConvert, buildConverted, extractUrls, buildOptions, fetchAll, effectiveFetcherConfig };
