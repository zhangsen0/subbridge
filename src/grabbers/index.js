'use strict';

/**
 * 站点适配器注册表
 *
 * 用于"站点专用抓取"：某些站点没有标准订阅格式（如 vpngate 的 OpenVPN 批量列表），
 * 由对应适配器负责归一化 URL 与解析内容。新增站点只需：
 *   1. 在 src/grabbers/ 新增文件，导出 { matches(hostname), normalizeUrl?(url), parse(content) }
 *   2. 在本文件 ADAPTERS 数组中注册
 * 抓取中心（src/core/grabber.js）会自动按域名路由，无需改动主流程。
 */

const vpngate = require('./vpngate');

/** 适配器列表（按顺序匹配域名） */
const ADAPTERS = [vpngate];

/** 按主机名查找适配器；无匹配返回 null */
function findAdapter(hostname) {
  return ADAPTERS.find((a) => a.matches && a.matches(hostname)) || null;
}

module.exports = { ADAPTERS, findAdapter };
