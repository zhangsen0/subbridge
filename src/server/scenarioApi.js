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
        merge_main_urls: true,
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
