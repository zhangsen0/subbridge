'use strict';

/**
 * 本地节点管理器
 *
 * 职责：
 *   1. 按配置启动/停止 HTTP、SOCKS5 代理服务（本机作为订阅节点）
 *   2. 可选启动 Cloudflare Tunnel，把节点映射为公网地址
 *   3. 构建注入订阅的本机节点（Clash / sing-box 目标）
 *
 * 节点公网地址解析优先级：
 *   localnode.public_address（显式配置） > cf_tunnel 域名 > 自动探测公网 IP
 */

const { createHttpProxy } = require('./httpProxy');
const { createSocks5Server } = require('./socks5Proxy');
const { TunnelManager } = require('./tunnel');
const { getPublicIp } = require('./ipDetector');
const Proxy = require('../core/proxy');

class LocalNodeManager {
  /**
   * @param {object} config 完整配置
   * @param {object} logger
   * @param {object} store 存储实例（透传给隧道管理器等）
   */
  constructor(config, logger, store) {
    this.config = config;
    this.logger = logger;
    this.store = store || null;
    this.servers = new Map(); // kind -> { server, port }
    this.tunnel = new TunnelManager(config, logger, store);
  }

  get cfg() {
    return this.config.localnode || {};
  }

  /** 启动本地代理服务与可选隧道 */
  async start() {
    this.stop();
    const cfg = this.cfg;
    if (!cfg.enabled) {
      this.log('本地节点未启用（localnode.enabled=false）');
      return;
    }

    // 收集需要启动的服务（避免异步监听竞态：先确定目标，再等待全部就绪）
    const targets = [];
    if (Number(cfg.http_port) > 0) targets.push(['http', Number(cfg.http_port)]);
    if (Number(cfg.socks_port) > 0) targets.push(['socks5', Number(cfg.socks_port)]);
    if (!targets.length) {
      this.log('本地节点已启用，但 http_port 与 socks_port 均为 0，未启动任何代理');
      return;
    }
    await Promise.all(targets.map(([kind, port]) => this.startServer(kind, port)));

    // 代理服务就绪后再启动 CF 隧道（可选）
    await this.tunnel.start();
  }

  /** 启动单个代理服务（等待监听成功） */
  startServer(kind, port) {
    const cfg = this.cfg;
    const opts = {
      username: cfg.username || '',
      password: cfg.password || '',
      logger: this.logger,
    };
    const server = kind === 'http' ? createHttpProxy(opts) : createSocks5Server(opts);
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.log(`[${kind}] 监听失败（端口 ${port}）: ${err.message}`);
        reject(err);
      };
      server.on('error', fail);
      server.listen(port, cfg.host || '0.0.0.0', () => {
        if (settled) return;
        settled = true;
        this.servers.set(kind, { server, port });
        this.log(`[${kind}] 节点已启动: ${cfg.host || '0.0.0.0'}:${port}`);
        resolve();
      });
    });
  }

  /** 停止全部服务（含隧道） */
  stop() {
    for (const { server } of this.servers.values()) {
      try {
        server.close();
      } catch {
        /* 忽略 */
      }
    }
    this.servers.clear();
    this.tunnel.stop();
  }

  /** 本机 HTTP 代理的上游地址（供"自中继采集"使用）；未运行时返回空串 */
  localProxyUrl() {
    const httpServer = this.servers.get('http');
    if (!httpServer) return '';
    const cfg = this.cfg;
    const auth = cfg.username
      ? `${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password)}@`
      : '';
    return `http://${auth}127.0.0.1:${httpServer.port}`;
  }

  /** 重启全部服务（配置变更后调用） */
  async restart() {
    await this.start();
  }

  /** 解析本机节点对外地址 */
  async resolvePublicAddress() {
    const cfg = this.cfg;
    if (cfg.public_address) return cfg.public_address;
    const tunnelHost = this.tunnel.publicAddress();
    if (tunnelHost) return tunnelHost;
    if (cfg.auto_detect_public_ip) {
      const fetcher = this.config.fetcher || {};
      return getPublicIp(cfg.public_ip_detect_url, {
        cacheSeconds: cfg.ip_cache_seconds,
        timeoutMs: cfg.ip_probe_timeout_ms,
        userAgent: fetcher.user_agent,
        logger: this.logger,
      });
    }
    return '';
  }

  /**
   * 构建注入订阅的本机节点列表
   * @returns {Promise<Array>} 统一节点模型数组；未启用或不可用时为空数组
   */
  async localNodes() {
    const cfg = this.cfg;
    if (!cfg.enabled || !cfg.inject_into_subscription) return [];

    const address = await this.resolvePublicAddress();
    if (!address) {
      this.log('无法确定本机节点公网地址，跳过注入（可在 localnode.public_address 配置）');
      return [];
    }

    // 经 CF 隧道暴露时，节点走 HTTPS（端口 443）
    const viaTunnel = !!this.tunnel.publicAddress();
    const nodes = [];

    if (cfg.http_port > 0 && (this.servers.has('http') || viaTunnel)) {
      nodes.push(
        new Proxy({
          name: cfg.http_node_name || '本机-HTTP',
          type: 'http',
          server: address,
          port: viaTunnel ? 443 : Number(cfg.http_port),
          username: cfg.username || '',
          password: cfg.password || '',
          tls: viaTunnel,
          sni: viaTunnel ? address : '',
          udp: false,
        }),
      );
    }
    if (cfg.socks_port > 0 && this.servers.has('socks5') && !viaTunnel) {
      // SOCKS5 经隧道暴露需要客户端配合 cloudflared access tcp，暂仅直连模式注入
      nodes.push(
        new Proxy({
          name: cfg.socks_node_name || '本机-SOCKS5',
          type: 'socks5',
          server: address,
          port: Number(cfg.socks_port),
          username: cfg.username || '',
          password: cfg.password || '',
          udp: true,
        }),
      );
    }
    return nodes;
  }

  /** 状态快照（供 /api/localnode 与前台展示） */
  async status() {
    const cfg = this.cfg;
    const info = { enabled: !!cfg.enabled };
    info.http = this.servers.has('http')
      ? { running: true, port: this.servers.get('http').port }
      : { running: false, port: Number(cfg.http_port) || 0 };
    info.socks5 = this.servers.has('socks5')
      ? { running: true, port: this.servers.get('socks5').port }
      : { running: false, port: Number(cfg.socks_port) || 0 };
    info.tunnel = this.tunnel.status();
    info.publicAddress = await this.resolvePublicAddress();
    info.injectIntoSubscription = !!cfg.inject_into_subscription;
    return info;
  }

  log(msg) {
    if (this.logger && this.logger.info) this.logger.info(`[localnode] ${msg}`);
  }
}

module.exports = { LocalNodeManager };
