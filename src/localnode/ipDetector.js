'use strict';

/**
 * 公网 IP 探测（带缓存）
 *
 * 用于本机没有显式公网地址配置时，自动获取出口公网 IP 作为节点地址。
 * 探测地址、超时、UA、缓存时长均可配置（localnode.* 配置块）；
 * 探测失败时返回上一次缓存值（若存在）。
 */

const { fetch: ufetch } = require('undici');

// 模块级缓存（单进程内共享）
const cache = { value: '', ts: 0 };

/**
 * 获取公网 IP
 * @param {string} detectUrl 探测服务地址
 * @param {{cacheSeconds?: number, timeoutMs?: number, userAgent?: string, logger?: object}} opts
 * @returns {Promise<string>} 公网 IP；失败返回缓存或空串
 */
async function getPublicIp(detectUrl, opts = {}) {
  const ttl = (Number(opts.cacheSeconds) || 300) * 1000;
  if (cache.value && Date.now() - cache.ts < ttl) return cache.value;

  const timeoutMs = Number(opts.timeoutMs) || 5000;
  try {
    const res = await ufetch(detectUrl, {
      headers: {
        'user-agent': opts.userAgent,
        accept: 'text/plain',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).trim();
    if (/^[\d.:a-fA-F]+$/.test(text)) {
      cache.value = text;
      cache.ts = Date.now();
      return text;
    }
    throw new Error('返回内容不是 IP');
  } catch (err) {
    if (opts.logger) opts.logger.warn(`公网 IP 探测失败: ${err.message}`);
    return cache.value;
  }
}

module.exports = { getPublicIp };
