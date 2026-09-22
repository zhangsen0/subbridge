'use strict';

/**
 * Cloudflare Tunnel（cloudflared）管理器
 *
 * 用途：本机无公网 IP / 无法端口转发时，通过 CF 隧道将本地代理节点
 *       映射为公网 HTTPS 地址，客户端直接订阅即可访问。
 *
 * 支持三种模式（配置项按优先级自动选择）：
 *   1. token 模式：填 cf_tunnel.token（远程管理隧道，hostname 在 CF 后台配置）
 *   2. 命名隧道：填 hostname + tunnel_uuid + credentials_file（本地生成 ingress 配置）
 *   3. 快速隧道：都不填（自动生成 https://xxx.trycloudflare.com 随机地址）
 *
 * 二进制路径、模式参数全部可配置；进程状态可通过 /api/localnode 查询。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

// 快速隧道 URL 匹配（输出日志中形如 https://xxxx.trycloudflare.com）
const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * 构建 cloudflared 启动参数与命名隧道配置文件
 * @param {object} cfg cf_tunnel 配置
 * @param {object} localCfg localnode 配置
 * @param {object} store 存储实例（生成文件经存储层写入）
 * @returns {{mode: string, args: string[], configFile?: string, configYaml?: string}}
 */
async function buildTunnelCommand(cfg, localCfg, store) {
  const ingress = cfg.ingress_service || `http://127.0.0.1:${localCfg.http_port}`;

  if (cfg.token) {
    return {
      mode: 'token',
      args: ['tunnel', '--no-autoupdate', 'run', '--token', cfg.token],
    };
  }

  if (cfg.hostname && cfg.tunnel_uuid && cfg.credentials_file) {
    const configYaml = [
      `tunnel: ${cfg.tunnel_uuid}`,
      `credentials-file: ${cfg.credentials_file}`,
      'ingress:',
      `  - hostname: ${cfg.hostname}`,
      `    service: ${ingress}`,
      '  - service: http_status:404',
    ].join('\n');
    await store.writeDataFile('cf-tunnel.yml', configYaml + '\n');
    const configFile = path.join(store.dataDir(), 'cf-tunnel.yml');
    return {
      mode: 'named',
      args: ['tunnel', '--config', configFile, 'run'],
      configFile,
      configYaml,
    };
  }

  return {
    mode: 'quick',
    args: ['tunnel', '--no-autoupdate', '--url', ingress],
  };
}

class TunnelManager {
  /**
   * @param {object} config 完整配置
   * @param {object} logger
   * @param {object} store 存储实例（写生成文件、取数据目录）
   */
  constructor(config, logger, store) {
    this.config = config;
    this.logger = logger;
    this.store = store;
    this.proc = null;
    this.publicHost = ''; // 当前生效的公网主机（如 xxx.trycloudflare.com 或自定义域名）
    this.lastError = '';
    this.lastCommand = [];
  }

  get cfg() {
    return this.config.cf_tunnel || {};
  }

  get localCfg() {
    return this.config.localnode || {};
  }

  /** 是否正在运行 */
  get running() {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  /**
   * 启动隧道（先停止旧进程）
   * @returns {Promise<boolean>} 是否成功启动
   */
  async start() {
    this.stop();
    const cfg = this.cfg;
    if (!cfg.enabled) {
      this.log('CF 隧道未启用');
      return false;
    }
    if (!this.localCfg.enabled) {
      this.log('CF 隧道需要先启用本地节点（localnode.enabled）');
      return false;
    }

    let built;
    try {
      built = await buildTunnelCommand(cfg, this.localCfg, this.store);
    } catch (err) {
      this.lastError = `生成隧道配置失败: ${err.message}`;
      this.log(this.lastError);
      return false;
    }
    this.lastCommand = [cfg.binary || 'cloudflared', ...built.args];

    // 命名隧道直接使用配置的 hostname；token/快速隧道需等待日志输出
    if (built.mode === 'named' && cfg.hostname) this.publicHost = cfg.hostname;

    try {
      this.proc = spawn(cfg.binary || 'cloudflared', built.args, {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.lastError = `启动 cloudflared 失败: ${err.message}`;
      this.log(this.lastError);
      return false;
    }

    this.proc.stdout.on('data', (chunk) => this.parseOutput(chunk));
    this.proc.stderr.on('data', (chunk) => this.parseOutput(chunk));
    this.proc.on('exit', (code) => {
      if (code !== 0) this.lastError = `cloudflared 已退出（code=${code}）`;
      this.proc = null;
    });
    this.proc.on('error', (err) => {
      this.lastError = `cloudflared 进程错误: ${err.message}`;
      this.log(this.lastError);
    });
    return true;
  }

  /** 解析进程输出，捕获快速隧道 URL */
  parseOutput(chunk) {
    const text = chunk.toString('utf8');
    const match = text.match(QUICK_URL_RE);
    if (match && match[0] !== this.publicHost) {
      this.publicHost = match[0].replace(/^https?:\/\//, '');
      this.log(`CF 快速隧道已就绪: https://${this.publicHost}`);
    }
  }

  /** 停止隧道进程 */
  stop() {
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        /* 忽略 */
      }
      this.proc = null;
    }
    // 保留 publicHost 作为最后已知地址（注入时优先用显式配置）
  }

  /** 当前公网主机（优先显式配置，其次隧道域名） */
  publicAddress() {
    const cfg = this.cfg;
    if (cfg.public_hostname_override) return cfg.public_hostname_override;
    if (this.publicHost) return this.publicHost;
    return '';
  }

  /** 状态快照 */
  status() {
    return {
      enabled: !!this.cfg.enabled,
      mode: this.lastCommand.includes('--token') ? 'token' : this.lastCommand.includes('--config') ? 'named' : 'quick',
      running: this.running,
      publicHost: this.publicAddress(),
      binary: this.cfg.binary || 'cloudflared',
      lastError: this.lastError,
      command: this.lastCommand,
    };
  }

  log(msg) {
    if (this.logger && this.logger.info) this.logger.info(`[cf-tunnel] ${msg}`);
  }
}

module.exports = { TunnelManager, buildTunnelCommand };
