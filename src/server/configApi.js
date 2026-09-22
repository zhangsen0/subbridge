'use strict';

/**
 * 运行时配置与模板管理 API
 *
 *   GET  /api/config           读取生效配置（脱敏）
 *   POST /api/config           更新配置（持久化到 data/config.yaml）
 *   GET  /api/config/raw       读取配置原文（YAML，专家模式用）
 *   POST /api/config/raw       以 YAML 原文更新配置（专家模式用）
 *   GET  /api/templates        列出可用模板文件
 *   GET  /api/templates/:name  读取模板内容（data/templates/ 优先于内置 templates/）
 *   PUT  /api/templates/:name  保存/覆盖模板（写入 data/templates/）
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const yaml = require('js-yaml');
const { getConfig, updateConfig, maskSecrets } = require('../config/loader');

// 模板文件名白名单：仅允许安全字符，防止路径穿越
const TEMPLATE_NAME_RE = /^[\w.-]+$/;

/** 列出可用模板（内置 + 运行时覆盖，覆盖优先，去重） */
async function listTemplates(ctx) {
  const names = new Set();
  // 运行时模板（经存储层）
  for (const e of await ctx.store.listTemplates()) names.add(e);
  // 内置模板（随应用发布，只读回退）
  try {
    const entries = await fs.readdir(ctx.templatesDir);
    for (const e of entries) {
      const stat = await fs.stat(path.join(ctx.templatesDir, e));
      if (stat.isFile()) names.add(e);
    }
  } catch { /* 目录不存在则跳过 */ }
  return [...names].sort();
}

/** 读取模板内容：运行时覆盖优先，其次内置 */
async function readTemplate(name, ctx) {
  const override = await ctx.store.readTemplate(name);
  if (override !== null) return override;
  try {
    return await fs.readFile(path.join(ctx.templatesDir, name), 'utf8');
  } catch {
    return null;
  }
}

/** 写入/覆盖模板（经存储层写入运行时目录） */
async function writeTemplate(name, content, ctx) {
  await ctx.store.writeTemplate(name, String(content));
}

/** 注册配置与模板管理路由 */
async function registerConfigApi(app, ctx) {
  // 读取生效配置（脱敏后返回）
  app.get('/api/config', async () => ({ config: maskSecrets(getConfig()) }));

  // 更新配置
  app.post('/api/config', async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: '请求体必须是 JSON 对象' });
    }
    try {
      const keyCount = Object.keys(body).length;
      await updateConfig(body);
      // 配置变更记入事件日志
      ctx.fetchLog.record({ type: 'config', kind: 'update', url: `更新 ${keyCount} 个配置项`, nodes: 0, error: '' });
      return { ok: true, config: maskSecrets(getConfig()) };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // 配置原文（YAML，专家模式：可直改参数表未覆盖的新键）
  app.get('/api/config/raw', async (req, reply) => {
    const text = (await ctx.store.readConfig()) || '';
    reply.type('text/yaml; charset=utf-8').send(text);
  });

  // 以 YAML 原文更新配置
  app.post('/api/config/raw', async (req, reply) => {
    const body = req.body || {};
    const text = String(body.text || '').trim();
    if (!text) return reply.code(400).send({ error: '配置原文不能为空' });
    try {
      const doc = yaml.load(text);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        return reply.code(400).send({ error: '配置原文必须是 YAML 对象' });
      }
      await updateConfig(doc);
      ctx.fetchLog.record({ type: 'config', kind: 'update.raw', url: '以 YAML 原文更新配置', error: '' });
      return { ok: true, config: maskSecrets(getConfig()) };
    } catch (err) {
      return reply.code(400).send({ error: `YAML 解析失败: ${err.message}` });
    }
  });

  // 模板列表
  app.get('/api/templates', async () => ({ files: await listTemplates(ctx) }));

  // 读取模板
  app.get('/api/templates/:name', async (req, reply) => {
    const name = req.params.name;
    if (!TEMPLATE_NAME_RE.test(name)) {
      return reply.code(400).send({ error: '非法模板名' });
    }
    const content = await readTemplate(name, ctx);
    if (content === null) return reply.code(404).send({ error: '模板不存在' });
    return { name, content };
  });

  // 保存模板
  app.put('/api/templates/:name', async (req, reply) => {
    const name = req.params.name;
    if (!TEMPLATE_NAME_RE.test(name)) {
      return reply.code(400).send({ error: '非法模板名' });
    }
    const body = req.body || {};
    if (typeof body.content !== 'string') {
      return reply.code(400).send({ error: '缺少 content 字段' });
    }
    await writeTemplate(name, body.content, ctx);
    return { ok: true, name };
  });
}

module.exports = { registerConfigApi };
