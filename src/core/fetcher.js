'use strict';

/**
 * 订阅抓取器
 *
 * 职责：
 *   - 抓取远程订阅内容（仅支持 http/https）
 *   - 支持上游转发代理（http/https，通过 undici ProxyAgent 实现）
 *   - 支持超时、重试、内容大小上限
 *   - SSRF 防护：默认拦截内网/保留地址（可通过配置关闭或加白名单）
 *
 * 全部参数来自配置（fetcher.*），禁止写死。
 */

const { fetch: ufetch, ProxyAgent } = require('undici');
const dns = require('node:dns/promises');
const net = require('node:net');

/** 简单延时 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 判断 IP 是否为内网/保留地址（SSRF 防护用）
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    return (
      a === 0 ||                                    // 0.0.0.0/8
      a === 10 ||                                   // 10.0.0.0/8
      a === 127 ||                                  // 127.0.0.0/8
      (a === 100 && b >= 64 && b <= 127) ||         // 100.64.0.0/10 CGNAT
      (a === 169 && b === 254) ||                   // 169.254.0.0/16 链路本地
      (a === 172 && b >= 16 && b <= 31) ||          // 172.16.0.0/12
      (a === 192 && b === 168) ||                   // 192.168.0.0/16
      (a === 198 && (b === 18 || b === 19)) ||      // 198.18.0.0/15 基准测试
      a >= 224                                      // 组播/保留
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') || lower.startsWith('fd') || // fc00::/7 ULA
      lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb') || // fe80::/10 链路本地
      lower.startsWith('ff')                              // 组播
    );
  }
  return false;
}

class Fetcher {
  /**
   * @param {object} config 完整配置（内部读取 config.fetcher）
   */
  constructor(config) {
    this.fetcherConfig = (config && config.fetcher) || {};
    // 上游转发代理（http/https），复用同一个连接池，提升效率
    this.agent = this.fetcherConfig.upstream_proxy
      ? new ProxyAgent(this.fetcherConfig.upstream_proxy)
      : undefined;
  }

  /**
   * 抓取订阅内容（带重试与 SSRF 防护）
   * @param {string} url 订阅地址
   * @returns {Promise<string>} 订阅文本内容
   */
  async fetchText(url) {
    const cfg = this.fetcherConfig;

    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`不支持的订阅协议（仅支持 http/https）: ${url}`);
    }

    if (cfg.block_private) {
      await this.assertPublicHost(url);
    }

    const retries = Number(cfg.retries) || 0;
    const backoffBase = Number(cfg.retry_base_ms) || 300;
    const backoffMax = Number(cfg.retry_max_ms) || 2000;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        // 指数退避：base -> base*2 -> base*4 ...，上限 backoffMax
        await sleep(Math.min(backoffMax, backoffBase * 2 ** attempt));
      }
      try {
        return await this._fetchOnce(url);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('订阅抓取失败');
  }

  /** 单次抓取 */
  async _fetchOnce(url) {
    const cfg = this.fetcherConfig;
    const timeoutMs = (Number(cfg.timeout_seconds) || 15) * 1000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await ufetch(url, {
        dispatcher: this.agent,
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': cfg.user_agent,
          accept: '*/*',
        },
      });

      if (!res.ok) {
        throw new Error(`订阅抓取失败，HTTP ${res.status}`);
      }

      // 流式读取并限制大小
      const limit = Number(cfg.max_body_bytes) || 10 * 1024 * 1024;
      const chunks = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > limit) {
          throw new Error(`订阅内容超过大小上限（${limit} 字节）`);
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      clearTimeout(timer);
    }
  }

  /** SSRF 防护：解析域名并检查是否指向内网地址 */
  async assertPublicHost(url) {
    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch {
      throw new Error(`无效的订阅地址: ${url}`);
    }

    const allowlist = this.fetcherConfig.private_host_allowlist || [];
    if (allowlist.includes(hostname)) return;

    let records;
    try {
      records = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error(`域名解析失败: ${hostname}`);
    }
    if (!records.length) return;
    for (const record of records) {
      if (isPrivateIp(record.address)) {
        throw new Error(`SSRF 防护：禁止访问内网/保留地址 ${record.address}（域名 ${hostname}）`);
      }
    }
  }
}

module.exports = { Fetcher, isPrivateIp };
