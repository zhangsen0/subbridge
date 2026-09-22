'use strict';

/**
 * /convert 转换接口处理逻辑
 *
 * 流程：解析参数 -> 并发抓取订阅（受限并发） -> 探测格式并解析节点
 *       -> 过滤/去重/排序/重命名 -> 按目标格式转换 -> 返回
 */

const { Fetcher } = require('../core/fetcher');
const { parseSubscription } = require('../parsers');
const { applyPipeline } = require('../core/pipeline');
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
  };
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
 * @param {object} ctx { config, templatesDir, dataDir }
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

  // 抓取并解析
  const fetcher = new Fetcher(config);
  const results = await fetchAll(urls, fetcher, config);

  // 汇总节点与警告
  const nodes = [];
  const warnings = [];
  const skipFailed = (config.converter || {}).skip_failed !== false;
  for (const r of results) {
    if (r.error) {
      warnings.push(r.error);
      if (!skipFailed) {
        return reply.code(502).send({ error: '订阅抓取失败', detail: warnings });
      }
      continue;
    }
    if (r.nodes && r.nodes.length) nodes.push(...r.nodes);
    else warnings.push(`[${r.url}] 未能从订阅内容中解析出任何节点`);
  }

  if (!nodes.length) {
    return reply.code(422).send({ error: '所有订阅均未解析出可用节点', detail: warnings });
  }

  // 过滤/去重/排序/重命名
  const processed = applyPipeline(nodes, opts);

  // 转换
  let output;
  try {
    output = await converters.convert(opts.target, processed, opts, ctx);
  } catch (err) {
    return reply.code(500).send({ error: `转换失败: ${err.message}` });
  }

  const headers = { 'content-type': converters.contentTypeFor(opts.target) };
  if (warnings.length) headers['x-subbridge-warnings'] = warnings.join(' | ');
  return reply.code(200).headers(headers).send(output);
}

module.exports = { handleConvert, extractUrls, buildOptions, fetchAll };
