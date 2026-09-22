'use strict';

/**
 * 数据备份与迁移 API（仅管理员）
 *
 *   GET  /api/backup   导出完整运行时数据：覆盖配置 + 运行时模板 + 生成文件（CF 隧道凭据等）
 *   POST /api/restore  导入备份并生效：整体替换覆盖配置、写入模板与生成文件，重启本地节点
 *
 * 所有读写均经存储层（store），与存储驱动解耦。
 * 注意：备份 JSON 包含接口令牌等敏感信息，请妥善保管（接口本身受管理员令牌保护）。
 */

const path = require('node:path');
const yaml = require('js-yaml');
const pkg = require('../../package.json');
const { replaceConfig } = require('../config/loader');

// 备份中允许恢复的生成文件（数据目录下，经存储层读写）
const KNOWN_FILES = ['cf-tunnel.yml'];

/** 注册备份与迁移路由 */
async function registerBackupApi(app, ctx) {
  // 导出备份
  app.get('/api/backup', async () => {
    const store = ctx.store;

    // 覆盖配置原文
    const configText = await store.readConfig();
    const config = configText ? yaml.load(configText) || {} : {};

    // 运行时模板
    const templates = {};
    for (const name of await store.listTemplates()) {
      templates[name] = await store.readTemplate(name);
    }

    // 生成文件
    const files = {};
    for (const name of KNOWN_FILES) {
      const content = await store.readDataFile(name);
      if (content !== null) files[name] = content;
    }

    return {
      app: pkg.name,
      version: pkg.version,
      exportedAt: new Date().toISOString(),
      config,
      templates,
      files,
    };
  });

  // 导入备份
  app.post('/api/restore', async (req, reply) => {
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: '请求体必须是备份 JSON 对象' });
    }
    if (body.app && body.app !== pkg.name) {
      return reply.code(400).send({ error: `备份文件不属于 ${pkg.name}，已拒绝导入` });
    }
    if (typeof body.config !== 'object' || Array.isArray(body.config)) {
      return reply.code(400).send({ error: '备份缺少 config 对象' });
    }

    const store = ctx.store;
    const problems = [];
    try {
      // 1. 整体替换覆盖配置
      await replaceConfig(body.config);

      // 2. 写入运行时模板（经存储层，文件名白名单校验）
      if (body.templates && typeof body.templates === 'object') {
        for (const [name, content] of Object.entries(body.templates)) {
          try {
            await store.writeTemplate(name, String(content));
          } catch (err) {
            problems.push(`跳过模板 ${name}: ${err.message}`);
          }
        }
      }

      // 3. 写入生成文件（仅允许白名单内的已知文件）
      if (body.files && typeof body.files === 'object') {
        for (const [name, content] of Object.entries(body.files)) {
          if (!KNOWN_FILES.includes(name)) {
            problems.push(`跳过未知文件: ${name}`);
            continue;
          }
          await store.writeDataFile(name, String(content));
        }
      }

      // 4. 重启本地节点使新配置生效
      if (ctx.localnode) {
        try {
          await ctx.localnode.restart();
        } catch (err) {
          problems.push(`本地节点重启失败: ${err.message}`);
        }
      }
    } catch (err) {
      return reply.code(400).send({ error: `导入失败: ${err.message}` });
    }

    return { ok: true, problems };
  });
}

module.exports = { registerBackupApi };
