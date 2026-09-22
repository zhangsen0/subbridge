'use strict';

/**
 * 内置模板 API
 *
 * GET /api/presets
 *   返回「订阅选取规则 / 质量门槛 / 自动清理」三类内置模板，
 *   供前台一键初始化（填入输入框后再保存，可自行修改）。
 *
 * 模板定义在 src/config/defaults.yaml 的 presets 段，全部配置化：
 *   前台可增删改（保存到 data/config.yaml 覆盖层），无需改代码。
 */

/**
 * 注册内置模板路由
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx
 */
function registerPresetsApi(app, ctx) {
  app.get('/api/presets', async () => {
    const presets = (ctx.config && ctx.config.presets) || {};
    const pick = (group) => {
      const src = presets[group] || {};
      return Object.entries(src).map(([id, item]) => ({
        id,
        label: (item && item.label) || id,
        desc: (item && item.desc) || '',
        value: (item && Array.isArray(item.value) ? item.value : []),
      }));
    };
    return {
      ok: true,
      rules: pick('rules'),
      quality_gates: pick('quality_gates'),
      cleanup_rules: pick('cleanup_rules'),
    };
  });
}

module.exports = { registerPresetsApi };
