'use strict';

/**
 * 本机订阅源（/sub、/subscribe 端点）
 *
 * 外部客户端仅凭本机订阅链接 + token 即可拉取：
 *   - 默认合并配置中的主订阅地址（subscription.main_urls，对外隐藏上游地址）
 *   - 默认做可用性检测（可通过 probe=1/0 覆盖）
 *   - 自动注入本机节点
 *
 * 响应按 cache_seconds 做内存缓存，降低采集与检测压力。
 */

const converters = require('../converters');
const { buildConverted, buildOptions } = require('./convert');
const { safeHeaderValue } = require('../core/util');

/** 简单哈希，用于缓存键（避免 url 参数不同导致串缓存） */
function hashOf(s) {
  const crypto = require('crypto');
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/**
 * /sub 处理器
 * @param {import('fastify').FastifyRequest} req
 * @param {import('fastify').FastifyReply} reply
 * @param {object} ctx
 */
async function handleSubscribe(req, reply, ctx) {
  const config = ctx.config;
  const subCfg = config.subscription || {};
  const q = req.query || {};

  // 主订阅地址：配置中的 main_urls + 请求可选附加的 url；
  // 均未配置时静默降级为"仅返回本机节点"，而不是报错
  const mainUrls = Array.isArray(subCfg.main_urls) ? subCfg.main_urls.filter(Boolean) : [];
  const extraUrls = q.url ? String(q.url).split(/[,;\n]/).map((s) => s.trim()).filter(Boolean) : [];
  const urls = [...mainUrls, ...extraUrls];

  // 目标格式与探测开关
  const target = (q.target || subCfg.default_target || 'clash').toLowerCase();
  if (!converters.TARGETS[target]) {
    return reply.code(400).send({ error: `不支持的目标格式: ${target}` });
  }
  const probe =
    q.probe !== undefined
      ? q.probe === '1' || q.probe === 'true'
      : subCfg.probe_by_default !== false;

  // 读取缓存（经存储层，支持 TTL；驱动可实现为进程内存或数据库表）
  const cacheSeconds = Number(subCfg.cache_seconds) || 0;
  const cacheKey = `subscription:${target}:${probe}:${hashOf(urls.join(','))}`;
  if (cacheSeconds > 0) {
    const hit = ctx.store.cacheGet(cacheKey);
    if (hit) {
      return send(hit.output, hit.warnings);
    }
  }

  // 构建选项：订阅源默认值 + 请求覆盖
  const opts = buildOptions(
    {
      target,
      probe: probe ? '1' : '0',
      name: q.name || subCfg.name || '',
      include: q.include,
      exclude: q.exclude,
      prefix: q.prefix,
      suffix: q.suffix,
      sort: q.sort,
      udp: q.udp,
    },
    config,
  );

  let result;
  try {
    result = await buildConverted(urls, opts, ctx);
  } catch (err) {
    if (err.detail) return reply.code(502).send({ error: err.message, detail: err.detail });
    return reply.code(500).send({ error: err.message });
  }

  if (cacheSeconds > 0) {
    ctx.store.cacheSet(cacheKey, { output: result.output, warnings: result.warnings }, cacheSeconds);
  }
  return send(result.output, result.warnings);

  function send(output, warnings) {
    const headers = { 'content-type': converters.contentTypeFor(target) };
    if (warnings && warnings.length) headers['x-subbridge-warnings'] = warnings.map(safeHeaderValue).join(' | ');
    return reply.code(200).headers(headers).send(output);
  }
}

module.exports = { handleSubscribe };
