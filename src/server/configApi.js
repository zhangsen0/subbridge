'use strict';

/**
 * 运行时配置与模板管理 API
 *
 *   GET  /api/config           读取生效配置（脱敏）
 *   POST /api/config           更新配置（持久化到 data/config.yaml）
 *   GET  /api/templates        列出可用模板文件
 *   GET  /api/templates/:name  读取模板内容（data/templates/ 优先于内置 templates/）
 *   PUT  /api/templates/:name  保存/覆盖模板（写入 data/templates/）
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { getConfig, updateConfig, maskSecrets, getDataDir } = require('../config/loader');

// 模板文件名白名单：仅允许安全字符，防止路径穿越
const TEMPLATE_NAME_RE = /^[\w.-]+$/;

/** 列出可用模板（内置 + 运行时覆盖，覆盖优先，去重） */
async function listTemplates(ctx) {
  const names = new Set();
  for (const dir of [ctx.templatesDir, path.join(ctx.dataDir, 'templates')]) {
    try {
      const entries = await fs.readdir(dir);
      for (const e of entries) {
        const full = path.join(dir, e);
        const stat = await fs.stat(full);
        if (stat.isFile()) names.add(e);
      }
    } catch { /* 目录不存在则跳过 */ }
  }
  return [...names].sort();
}

/** 读取模板内容：运行时覆盖优先，其次内置 */
async function readTemplate(name, ctx) {
  const candidates = [path.join(ctx.dataDir, 'templates', name), path.join(ctx.templatesDir, name)];
  for (const p of candidates) {
    try {
      return await fs.readFile(p, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return null;
}

/** 写入/覆盖模板（运行时目录） */
async function writeTemplate(name, content, ctx) {
  const dir = path.join(ctx.dataDir, 'templates');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), String(content), 'utf8');
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
      await updateConfig(body);
      return { ok: true, config: maskSecrets(getConfig()) };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
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
