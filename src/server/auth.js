'use strict';

/**
 * 多级用户鉴权
 *
 * 两级用户：
 *   - 管理员（security.api_token）：完全访问（/convert、/sub、/subscribe、/api/*）
 *   - 普通用户（security.user_token）：仅 /convert、/sub、/subscribe、/api/me
 *
 * 均未配置令牌时完全开放（按管理员处理，兼容旧行为）。
 * 注意：设置 user_token 时务必同时设置 api_token，否则无人具备管理权限。
 */

/** 从请求中提取令牌（header 或 query） */
function extractToken(req) {
  return (
    (req.headers['x-api-token'] || '') ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    (req.query && req.query.token) ||
    ''
  );
}

/**
 * 解析请求角色
 * @param {import('fastify').FastifyRequest} req
 * @param {object} config 生效配置
 * @returns {'admin'|'user'|null} null 表示未授权
 */
function resolveRole(req, config) {
  const security = (config && config.security) || {};
  const adminToken = security.api_token || '';
  const userToken = security.user_token || '';
  const token = extractToken(req);

  if (adminToken && token === adminToken) return 'admin';
  if (userToken && token === userToken) return 'user';
  // 未配置任何令牌：完全开放
  if (!adminToken && !userToken) return 'admin';
  return null;
}

/** 某角色对应的令牌（用于生成对外订阅链接） */
function tokenForRole(config, role) {
  const security = (config && config.security) || {};
  return role === 'user' ? security.user_token || '' : security.api_token || '';
}

/** 构建本机订阅源链接（按角色携带对应令牌） */
function buildSubscriptionUrl(req, config, role) {
  const token = tokenForRole(config, role);
  const subCfg = (config && config.subscription) || {};
  // 订阅链接协议：subscription.url_scheme 显式指定（http/https）优先；
  // 默认 auto：信任反代头 x-forwarded-proto（Render/Zeabur/Nginx 等自动为 https），否则退回请求协议
  const scheme = String(subCfg.url_scheme || 'auto').toLowerCase();
  let proto = req.protocol || 'http';
  const fwd = req.headers && req.headers['x-forwarded-proto'];
  if (scheme === 'auto') {
    if (fwd) proto = String(fwd).split(',')[0].trim() || proto;
  } else {
    proto = scheme;
  }
  const origin = `${proto}://${req.hostname}`;
  return `${origin}/sub${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

module.exports = { extractToken, resolveRole, tokenForRole, buildSubscriptionUrl };
