'use strict';

/**
 * 账号密码登录 API
 *
 * POST /api/login  body: { username, password } 或 { token }
 *   - 账号密码与 security.admin_username/admin_password 匹配 → 返回管理员令牌
 *   - 账号密码与 security.user_username/user_password 匹配   → 返回普通用户令牌
 *   - 直接提供令牌且与 api_token/user_token 匹配             → 返回该角色令牌
 * 登录成功后前端保存返回的令牌，后续请求携带即可。
 */

const { extractToken } = require('./auth');

/** 常量时间比较，避免时序侧信道 */
function safeEqual(a, b) {
  const A = String(a || '');
  const B = String(b || '');
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A.charCodeAt(i) ^ B.charCodeAt(i);
  return diff === 0;
}

/** 校验一组账号密码（任意一端未配置则不匹配，避免空密码误登录） */
function matchAccount(security, username, password, role) {
  const u = security[`${role}_username`];
  const p = security[`${role}_password`];
  if (!u || !p) return false;
  return safeEqual(u, username) && safeEqual(p, password);
}

/**
 * 注册登录路由
 * @param {import('fastify').FastifyInstance} app
 * @param {object} ctx
 */
function registerLoginApi(app, ctx) {
  app.post('/api/login', async (req, reply) => {
    const body = req.body || {};
    const security = (ctx.config && ctx.config.security) || {};

    // 方式一：账号密码登录
    if (body.username && body.password) {
      if (matchAccount(security, body.username, body.password, 'admin') && security.api_token) {
        ctx.fetchLog.record({ type: 'system', kind: 'login', url: '管理员账号登录', error: '' });
        return { ok: true, role: 'admin', token: security.api_token };
      }
      if (matchAccount(security, body.username, body.password, 'user') && security.user_token) {
        ctx.fetchLog.record({ type: 'system', kind: 'login', url: '普通用户账号登录', error: '' });
        return { ok: true, role: 'user', token: security.user_token };
      }
      ctx.fetchLog.record({ type: 'system', kind: 'login.fail', url: `账号登录失败: ${body.username}`, error: '账号或密码错误' });
      return reply.code(401).send({ error: '账号或密码错误' });
    }

    // 方式二：令牌直填
    const token = body.token || extractToken(req);
    if (token) {
      if (security.api_token && token === security.api_token) {
        ctx.fetchLog.record({ type: 'system', kind: 'login', url: '管理员令牌登录', error: '' });
        return { ok: true, role: 'admin', token: security.api_token };
      }
      if (security.user_token && token === security.user_token) {
        ctx.fetchLog.record({ type: 'system', kind: 'login', url: '普通用户令牌登录', error: '' });
        return { ok: true, role: 'user', token: security.user_token };
      }
    }

    // 未配置任何账号与令牌：公开模式，无需登录
    if (!security.api_token && !security.user_token) {
      return { ok: true, role: 'admin', token: '' };
    }
    return reply.code(401).send({ error: '未授权：账号密码或令牌不正确' });
  });
}

module.exports = { registerLoginApi };
