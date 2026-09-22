'use strict';

/**
 * 多级用户鉴权单元测试
 * 覆盖：令牌提取、角色解析（管理员/普通用户/开放/未授权）、按角色的订阅链接。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractToken, resolveRole, tokenForRole, buildSubscriptionUrl } = require('../src/server/auth');

/** 构造最小请求对象 */
function fakeReq({ header, bearer, query } = {}) {
  const req = {
    headers: {},
    query: {},
    protocol: 'http',
    hostname: '127.0.0.1:18081',
  };
  if (header) req.headers['x-api-token'] = header;
  if (bearer) req.headers.authorization = `Bearer ${bearer}`;
  if (query) req.query.token = query;
  return req;
}

test('extractToken 支持 header 与 query 两种方式', () => {
  assert.equal(extractToken(fakeReq({ header: 'abc' })), 'abc');
  assert.equal(extractToken(fakeReq({ bearer: 'def' })), 'def');
  assert.equal(extractToken(fakeReq({ query: 'ghi' })), 'ghi');
  assert.equal(extractToken(fakeReq()), '');
});

test('resolveRole 两级用户：管理员完全访问，普通用户受限', () => {
  const config = { security: { api_token: 'admin-token', user_token: 'user-token' } };
  assert.equal(resolveRole(fakeReq({ header: 'admin-token' }), config), 'admin');
  assert.equal(resolveRole(fakeReq({ query: 'user-token' }), config), 'user');
  assert.equal(resolveRole(fakeReq({ header: 'wrong' }), config), null, '错误令牌应未授权');
  assert.equal(resolveRole(fakeReq(), config), null, '未携带令牌应未授权');
});

test('resolveRole 未配置令牌时完全开放（按管理员处理）', () => {
  assert.equal(resolveRole(fakeReq(), { security: {} }), 'admin');
  assert.equal(resolveRole(fakeReq(), {}), 'admin');
});

test('resolveRole 仅配置普通用户令牌时，无人具备管理权限', () => {
  const config = { security: { user_token: 'user-token' } };
  assert.equal(resolveRole(fakeReq({ header: 'user-token' }), config), 'user');
  assert.equal(resolveRole(fakeReq(), config), null);
});

test('tokenForRole 与 buildSubscriptionUrl 按角色携带令牌', () => {
  const config = { security: { api_token: 'admin-token', user_token: 'user-token' } };
  assert.equal(tokenForRole(config, 'admin'), 'admin-token');
  assert.equal(tokenForRole(config, 'user'), 'user-token');

  const req = fakeReq();
  assert.equal(
    buildSubscriptionUrl(req, config, 'admin'),
    'http://127.0.0.1:18081/sub?token=admin-token',
  );
  assert.equal(
    buildSubscriptionUrl(req, config, 'user'),
    'http://127.0.0.1:18081/sub?token=user-token',
  );
});
