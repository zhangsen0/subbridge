'use strict';

/**
 * 一键配置向导 API（快速开始 / 场景模板）
 *
 *   GET  /api/scenarios        返回 20 个使用场景模板（全部配置化，来自 scenarios.yaml）
 *   POST /api/setup/apply      一键应用场景：写入主订阅 + 规则 + 质量门槛 + 清理规则
 *                              + 本机节点开关 + 推荐参数补丁，立即生效并持久化
 *
 * 设计目标：不懂计算机的用户 5 步完成可用配置（欢迎 -> 选场景 -> 填订阅 -> 开关 ->
 * 确认应用），无需理解任何协议细节。所有参数前台「全站参数」仍可继续修改。
 */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { updateConfig } = require('../config/loader');

// 场景定义文件（与 defaults.yaml 并列，随应用发布；前台不可改但可复制到全站参数调整）
const SCENARIOS_PATH = path.join(__dirname, '../config/scenarios.yaml');

/** 读取场景库（解析失败时返回空，避免接口 500） */
function loadScenarios() {
  try {
    const doc = yaml.load(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
    return (doc && doc.scenarios) || {};
  } catch {
    return {};
  }
}

/** 把规则/门槛/清理/参数补丁转成人类可读的中文说明（供向导卡片展示"内部做了什么配置"） */
const RULE_TEXT = {
  alive: () => '存活可用',
  unreachable: () => '清理不可达节点',
  latency: (r) => (r.max_ms ? `延迟≤${r.max_ms}ms` : '延迟达标'),
  speed: (r) => (r.min_bps ? `速度≥${Math.round(r.min_bps / 1e6)}Mbps` : '速度达标'),
  score: (r) => (r.min_score ? `质量分≥${r.min_score}` : '质量分达标'),
  sort: (r) => {
    const key = r.key === 'speed' ? '速度' : r.key === 'latency' ? '延迟' : r.key || '综合';
    return r.order === 'desc' ? `按${key}降序` : `按${key}升序`;
  },
  limit: (r) => (r.count ? `限${r.count}个` : '限制数量'),
  country: (r) => (Array.isArray(r.value) ? `地区：${r.value.join(' / ')}` : '指定地区'),
  stale: (r) => (r.days ? `清理${r.days}天未更新` : '清理过期节点'),
  slow: (r) => (r.max_ms ? `清理延迟>${r.max_ms}ms` : '清理慢节点'),
  no_probe: (r) => (r.days ? `清理${r.days}天未测速` : '清理未测速节点'),
};

function humanizeRules(rules) {
  return (Array.isArray(rules) ? rules : []).map((r) => (RULE_TEXT[r.type] ? RULE_TEXT[r.type](r) : r.type)).filter(Boolean);
}

/** 参数补丁摘要：converter/clash/probe 等常见键转中文 */
function humanizePatch(patch) {
  const out = [];
  if (!patch || typeof patch !== 'object') return out;
  if (patch.udp !== undefined) out.push(patch.udp ? 'UDP 转发开' : 'UDP 转发关');
  const clash = patch.clash || {};
  if (clash.url_test_interval !== undefined) out.push(`Clash 测速间隔 ${clash.url_test_interval}s`);
  if (clash.url_test_url) out.push('Clash 自定义测速地址');
  const probe = patch.probe || {};
  if (probe.timeout_ms !== undefined) out.push(`测速超时 ${probe.timeout_ms}ms`);
  if (patch.sort !== undefined) out.push(patch.sort ? `排序 ${patch.sort}` : '默认排序');
  return out;
}

/** 生成场景"内部配置"摘要（一组短句） */
function scenarioSummary(s) {
  const items = [];
  const rules = humanizeRules(s && s.rules);
  if (rules.length) items.push(`选取：${rules.join('、')}`);
  const gates = humanizeRules(s && s.quality_gates);
  if (gates.length) items.push(`质量：${gates.join('、')}`);
  const cleans = humanizeRules(s && s.cleanup_rules);
  if (cleans.length) items.push(`清理：${cleans.join('、')}`);
  const patches = humanizePatch(s && s.config_patch);
  if (patches.length) items.push(`参数：${patches.join('、')}`);
  return items;
}

/** 规范化订阅链接文本：按换行/逗号分隔，去空 */
function parseUrls(text) {
  return String(text || '')
    .split(/[\n,，]/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

/**
 * 注册场景与一键配置路由
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx
 */
function registerScenarioApi(app, ctx) {
  // 场景列表（脱敏：仅返回前台需要展示的字段）
  app.get('/api/scenarios', async () => {
    const scenarios = loadScenarios();
    const list = Object.entries(scenarios).map(([id, s]) => ({
      id,
      label: (s && s.label) || id,
      emoji: (s && s.emoji) || '📦',
      desc: (s && s.desc) || '',
      audience: (s && s.audience) || '',
      rules: (s && Array.isArray(s.rules) ? s.rules : []),
      quality_gates: (s && Array.isArray(s.quality_gates) ? s.quality_gates : []),
      cleanup_rules: (s && Array.isArray(s.cleanup_rules) ? s.cleanup_rules : []),
      summary: scenarioSummary(s),
    }));
    return { ok: true, scenarios: list };
  });

  // 一键应用场景（仅管理员）
  app.post('/api/setup/apply', async (req, reply) => {
    if (req.role !== 'admin') {
      return reply.code(403).send({ error: '仅管理员可一键配置' });
    }
    const body = req.body || {};
    const scenarios = loadScenarios();
    const scenario = scenarios[body.scenario_id];
    if (!scenario) {
      return reply.code(400).send({ error: '未找到该场景模板，请重新选择' });
    }

    // 组装配置补丁：订阅源 + 规则 + 质量门槛 + 清理规则 + 场景推荐参数 + 本机节点开关
    const patch = {
      subscription: {
        main_urls: parseUrls(body.main_urls || ''),
        extra_sources: parseUrls(body.extra_sources || ''),
        // 默认不合并主订阅源（仅入池，是否输出由节点池/规则决定），保持全站默认
        merge_main_urls: false,
        include_pool: true,
        rules: Array.isArray(scenario.rules) ? scenario.rules : [],
      },
      pool: {
        default_enabled: true,
        include_disabled: false,
        quality_enabled: body.quality_enabled !== false,
        quality_mode: 'all',
        quality_default_pass: true,
        quality_gates: Array.isArray(scenario.quality_gates) ? scenario.quality_gates : [],
        cleanup_enabled: body.cleanup_enabled !== false,
        cleanup_rules: Array.isArray(scenario.cleanup_rules) ? scenario.cleanup_rules : [],
      },
      localnode: {
        enabled: body.localnode_enabled !== false,
      },
      fetcher: {
        proxy_from_pool: true,
        pool_empty_fallback_direct: true,
      },
    };
    // 场景推荐参数补丁（converter / clash / probe 等，逐层合并）
    if (scenario.config_patch && typeof scenario.config_patch === 'object') {
      for (const [sec, vals] of Object.entries(scenario.config_patch)) {
        patch[sec] = Object.assign({}, patch[sec] || {}, vals);
      }
    }

    try {
      await updateConfig(patch);
      // 配置变更 + 向导完成记入事件日志
      ctx.fetchLog.record({
        type: 'config',
        kind: 'setup',
        url: `一键配置完成：${scenario.label}`,
        error: '',
      });
      ctx.fetchLog.record({
        type: 'system',
        kind: 'setup',
        url: `快速开始向导完成（场景：${scenario.label}，订阅源 ${patch.subscription.main_urls.length} 个）`,
        error: '',
      });

      // 立即按质量门槛自动开关节点（未测节点默认通过，不会误停用）
      try {
        const { maybeApplyQuality } = require('./qualityApi');
        const q = await maybeApplyQuality(ctx, { force: true });
        if (q) {
          ctx.fetchLog.record({
            type: 'pool',
            kind: 'quality',
            url: `一键配置质量门槛应用（${q.mode}，${q.gates} 条）`,
            nodes: q.checked,
            alive: q.enabled,
            error: '',
          });
        }
      } catch (err) {
        ctx.fetchLog.record({ type: 'pool', kind: 'quality', url: '一键配置质量门槛应用失败', error: err.message });
      }

      return {
        ok: true,
        scenario: { id: body.scenario_id, label: scenario.label },
        subscription: patch.subscription,
        pool: { quality_gates: patch.pool.quality_gates.length, cleanup_rules: patch.pool.cleanup_rules.length },
        localnode_enabled: patch.localnode.enabled,
      };
    } catch (err) {
      return reply.code(400).send({ error: `一键配置失败：${err.message}` });
    }
  });
}

module.exports = { registerScenarioApi, loadScenarios };
