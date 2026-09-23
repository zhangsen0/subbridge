'use strict';

/**
 * 名称唯一化工具（Clash / sing-box 等客户端要求代理名唯一，重名会导致配置校验失败）
 *
 * 对输出对象列表按「基名 + 服务器地址」做唯一化：
 *  - 同名且同服务器同端口：保留一个（完全相同，重复无意义）
 *  - 同名不同服务器：追加序号后缀（如 CF 电信优选-2）
 *
 * @param {Array<object>} list 输出对象列表（元素含 name/tag 与 server/port）
 * @param {object} opts { nameKey?: string, serverKey?: string, portKey?: string }
 * @returns {Array<object>} 名称唯一化后的新列表（原地浅拷贝修改 name/tag 字段）
 */
function ensureUniqueNames(list, opts = {}) {
  const nameKey = opts.nameKey || 'name';
  const serverKey = opts.serverKey || 'server';
  const portKey = opts.portKey || 'port';
  const seen = new Map(); // 基名 -> 已用序列
  const identity = new Set(); // server:port 去重
  const out = [];
  for (const item of list) {
    const base = String(item[nameKey] || 'unnamed');
    const srv = item[serverKey];
    const port = item[portKey];
    const idKey = `${srv}:${port}`;
    // 完全相同（同地址同端口）只保留首个
    if (identity.has(idKey)) continue;
    identity.add(idKey);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    const finalName = n === 1 ? base : `${base}-${n}`;
    const copy = { ...item };
    if (nameKey in copy) copy[nameKey] = finalName;
    if ('tag' in copy) copy.tag = finalName;
    out.push(copy);
  }
  return out;
}

module.exports = { ensureUniqueNames };
