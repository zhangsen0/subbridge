'use strict';

/**
 * 抓取来源预处理：日期变量展开 + 后缀选项解析
 *
 * 一、日期变量（免费订阅源常见"每日更新"路径模板）：
 *    {Y}    四位年份   {m} 两位月份   {d} 两位日期
 *    {Ymd}  20260923   {Y_m_d} 2026_09_23   {Y-m-d} 2026-09-23
 *    时区取服务器本地时间（配置抓取时通常按"今天"预期）。
 *
 * 二、后缀选项（`|` 分隔，可配置化，不写死）：
 *    url|links       把内容按行拆分为多个订阅链接，逐个递归抓取
 *    url|ss          抓取后只保留指定协议的节点（ss/ssr/vmess/vless/trojan/...）
 *    url|其他        未知后缀忽略，按普通来源处理（不阻断）
 */

const pad = (n) => String(n).padStart(2, '0');

/** 展开链接中的日期变量（{Y} {m} {d} {Ymd} {Y_m_d} {Y-m-d} 等），base 为可选基准日期（默认当前本地时间） */
function expandDateVariables(url, base = new Date()) {
  if (!url || typeof url !== 'string' || !url.includes('{')) return url;
  const y = String(base.getFullYear());
  const m = pad(base.getMonth() + 1);
  const d = pad(base.getDate());
  const map = {
    '{Y_m_d}': `${y}_${m}_${d}`,
    '{Y-m-d}': `${y}-${m}-${d}`,
    '{Ymd}': `${y}${m}${d}`,
    '{Y}': y,
    '{m}': m,
    '{d}': d,
  };
  let out = url;
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  return out;
}

/**
 * 解析来源：拆出 URL 与后缀选项
 * @param {string} source 原始来源（可能含 |后缀 和日期变量）
 * @returns {{url: string, suffix: string}}
 */
function parseSourceOptions(source) {
  const raw = String(source || '');
  const idx = raw.indexOf('|');
  const urlPart = idx >= 0 ? raw.slice(0, idx) : raw;
  const suffix = idx >= 0 ? raw.slice(idx + 1).trim().toLowerCase() : '';
  return { url: expandDateVariables(urlPart.trim()), suffix };
}

/** 已知协议名（用于校验后缀是否为协议过滤） */
const PROTOCOL_NAMES = new Set([
  'ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'hy2',
  'tuic', 'http', 'https', 'socks5', 'socks', 'wireguard', 'wg', 'anytls', 'shadowtls',
]);

module.exports = { expandDateVariables, parseSourceOptions, PROTOCOL_NAMES };
