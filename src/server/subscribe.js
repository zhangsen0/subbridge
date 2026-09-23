'use strict';

/**
 * 本机订阅源（/sub、/subscribe 端点）
 *
 * 设计：**所有节点都从节点池来**
 *   - 主订阅地址（subscription.main_urls）抓取后统一入池（外部看不到上游地址）
 *   - 网页 / 文本 / 站点抓取也统一入池（补充/更新，不自动删除）
 *   - 本机节点同样入池（来源标记 localnode）
 *   - /sub 输出 = 节点池启用节点（可选 include_disabled）
 *
 * 兼容开关：
 *   - merge_main_urls=false：请求时不主动刷新主订阅，仅输出现有池
 *   - include_pool=false：退回"实时抓取直接输出"（不含池），旧行为保留
 *   - 可用性检测 probe=1/0 覆盖；缓存按 cache_seconds，节点池版本变化自动失效
 */

const converters = require('../converters');
const { buildConverted, buildOptions } = require('./convert');
const { safeHeaderValue } = require('../core/util');
const { parseRules } = require('../core/rules');

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
  // 均未配置时静默降级为"仅返回节点池/本机节点"，而不是报错
  const mainUrls = Array.isArray(subCfg.main_urls) ? subCfg.main_urls.filter(Boolean) : [];
  const extraUrls = q.url ? String(q.url).split(/[,;\n]/).map((s) => s.trim()).filter(Boolean) : [];
  // 其他订阅链接（extra_sources，每行 名称|URL）：自动拉取入池，补充节点库
  const extraSourceUrls = (Array.isArray(subCfg.extra_sources) ? subCfg.extra_sources : [])
    .map((s) => String(s).split('|').pop().trim())
    .filter(Boolean);
  const urls = [...mainUrls, ...extraUrls, ...extraSourceUrls];

  // 合并策略（均可在前台配置）：
  //   merge_main_urls —— 主订阅实时结果是否直接并入输出（false 时仅作为节点池来源）
  //   include_pool    —— 是否并入节点池累积节点（补充/更新、不自动删除）
  const mergeMain = subCfg.merge_main_urls !== false;
  const includePool = subCfg.include_pool !== false;
  const poolDropUnreachable = (config.pool || {}).drop_unreachable === true;

  // 目标格式与探测开关
  // 兼容分隔写法（如 target=clash|singbox|links|v2ray、target=clash,singbox），取第一个有效值
  let target = (q.target || subCfg.default_target || 'clash').toLowerCase();
  if (/[|,]/.test(target)) target = target.split(/[|,]/)[0].trim();
  if (!converters.TARGETS[target]) {
    return reply.code(400).send({
      error: `不支持的目标格式: ${target}（可选：${Object.keys(converters.TARGETS).join(' / ')}）`,
    });
  }
  const probe =
    q.probe !== undefined
      ? q.probe === '1' || q.probe === 'true'
      : subCfg.probe_by_default !== false;

  // 节点池版本（缓存键的一部分：池更新后缓存自动失效）
  let poolVersion = '';
  let extraNodes = [];
  if (includePool && ctx.nodePool) {
    try {
      const pool = await ctx.nodePool.load();
      poolVersion = hashOf(Object.keys(pool).join(','));
    } catch {
      /* 池不可读时按空处理 */
    }
  }

  // 读取缓存（经存储层，支持 TTL；驱动可实现为进程内存或数据库表）
  const cacheSeconds = Number(subCfg.cache_seconds) || 0;
  const cacheKey = `subscription:${target}:${probe}:${mergeMain}:${includePool}:${poolVersion}:${hashOf(urls.join(','))}`;
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

  // 自定义选取规则：从节点池取节点（配置 rules 为默认，请求 ?rules= 覆盖）
  const rulesText = q.rules !== undefined ? String(q.rules) : null;
  const rules = rulesText !== null ? parseRules(rulesText) : parseRules(subCfg.rules);

  let result;
  if (!includePool || !ctx.nodePool) {
    // 兼容模式：实时抓取直接输出（不含节点池，旧行为）
    const fetchUrls = mergeMain ? urls : extraUrls;
    try {
      result = await buildConverted(fetchUrls, opts, ctx, { extraNodes: [] });
    } catch (err) {
      if (err.detail) return reply.code(502).send({ error: err.message, detail: err.detail });
      return reply.code(500).send({ error: err.message });
    }
  } else {
    // 主路径：所有节点都从节点池来
    const warnings = [];

    // 1. 刷新池：抓取主订阅（merge_main_urls=true 时）→ 自动入池；失败不阻断输出
    const fetchUrls = mergeMain ? urls : extraUrls;
    if (fetchUrls.length) {
      try {
        const refresh = await buildConverted(fetchUrls, opts, ctx, { extraNodes: [] });
        warnings.push(...refresh.warnings);
      } catch (err) {
        warnings.push(`主订阅刷新失败（继续输出节点池）: ${err.message}`);
      }
    }

    // 2. 本机节点入池（来源 localnode），输出时从池取
    //    默认（localnode.auto_join_pool=true）启动/重启时已自动入池；
    //    此处作为兜底刷新，保证 /sub 拉取时本机节点始终最新
    if (ctx.localnode) {
      try {
        const localCfg = config.localnode || {};
        if (localCfg.enabled && localCfg.inject_into_subscription && localCfg.auto_join_pool !== false) {
          const lns = await ctx.localnode.localNodes();
          if (lns.length) {
            await ctx.nodePool.upsert(lns, { source: 'localnode' });
          }
        }
      } catch (err) {
        warnings.push(`本机节点入池失败: ${err.message}`);
      }
    }

    // 3. 输出 = 节点池启用节点（+规则选取 +可选停用节点）
    const includeDisabled = q.include_disabled === '1' || q.include_disabled === 'true' || (config.pool || {}).include_disabled === true;
    try {
      extraNodes = await ctx.nodePool.list({ enabled: includeDisabled ? undefined : true });
    } catch (err) {
      warnings.push(`节点池读取失败: ${err.message}`);
      extraNodes = [];
    }
    if (poolDropUnreachable) {
      // 本机节点（用户主动配置）始终保留，不受不可达过滤影响；
      // 其余节点按检测结果过滤（未测节点保留）
      extraNodes = extraNodes.filter((n) => n.source === 'localnode' || !n.probe || n.probe.alive);
    }
    if (rules.length) {
      const { applyRules } = require('../core/rules');
      extraNodes = applyRules(extraNodes, rules);
    }

    try {
      result = await buildConverted([], opts, ctx, { extraNodes });
    } catch (err) {
      if (err.detail) return reply.code(502).send({ error: err.message, detail: err.detail });
      return reply.code(500).send({ error: err.message });
    }
    result.warnings = [...warnings, ...result.warnings];
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
