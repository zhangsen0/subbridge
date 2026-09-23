'use strict';

/**
 * HTTP 代理核心处理函数（通用 HTTP(S) 转发）
 *
 * 拆分为可复用的处理器，供两种模式挂载：
 *   - standalone：挂到独立 http.Server（createHttpProxy）
 *   - shared：挂到主 Web 服务端口（CONNECT → server 'connect' 事件；绝对 URL → Fastify 钩子）
 *
 * 支持：
 *   - 绝对形式请求转发：GET http://host:port/path（普通 HTTP）
 *   - CONNECT 隧道：HTTPS / 任意 TCP 协议
 *   - 可选 Basic 认证（Proxy-Authorization）
 *
 * 所有参数（认证/日志）均来自配置，禁止写死。
 */

const http = require('node:http');
const net = require('node:net');
const { splitHostPort } = require('../core/util');

/**
 * 构造代理认证校验器
 * @param {{username?: string, password?: string}} options
 */
function createAuthChecker(options = {}) {
  const username = options.username || '';
  const password = options.password || '';
  const authRequired = !!(username || password);
  const expectedAuth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  /** 校验代理认证（Proxy-Authorization） */
  return function checkAuth(req) {
    if (!authRequired) return true;
    return (req.headers['proxy-authorization'] || '') === expectedAuth;
  };
}

/**
 * 构造绝对 URL 转发处理器（GET http://host:port/path 形式，普通 HTTP 目标）
 * @param {{checkAuth?: Function, logger?: object}} options
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
function createAbsoluteHandler(options = {}) {
  const checkAuth = options.checkAuth || (() => true);
  const logger = options.logger;

  /** 认证失败响应 */
  function rejectUnauthorized(res) {
    res.writeHead(407, {
      'Proxy-Authenticate': 'Basic realm="SubBridge"',
      'content-length': '0',
    });
    res.end();
  }

  return function handleAbsolute(req, res) {
    if (!checkAuth(req)) return rejectUnauthorized(res);

    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400, { 'content-length': '0' });
      return res.end();
    }

    // HTTPS 绝对形式无法直接转发，提示客户端改用 CONNECT
    if (target.protocol === 'https:') {
      res.writeHead(400, { 'content-length': '0' });
      return res.end();
    }
    if (target.protocol !== 'http:' || !target.hostname) {
      res.writeHead(400, { 'content-length': '0' });
      return res.end();
    }

    // 转发普通 HTTP 请求
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    delete headers.connection;

    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: req.method,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502, { 'content-length': '0' });
      res.end();
    });
    req.pipe(upstream);
  };
}

/**
 * 构造 CONNECT 隧道处理器（HTTPS 与任意 TCP 协议）
 * @param {{checkAuth?: Function, logger?: object}} options
 * @returns {(req: import('node:http').IncomingMessage, clientSocket: import('node:net').Socket, head: Buffer) => void}
 */
function createConnectHandler(options = {}) {
  const checkAuth = options.checkAuth || (() => true);
  const logger = options.logger;

  return function handleConnect(req, clientSocket, head) {
    if (!checkAuth(req)) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    const { host, port } = splitHostPort(req.url);
    if (!host || !port) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    const dst = net.connect({ host, port });
    dst.on('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) dst.write(head);
      clientSocket.pipe(dst);
      dst.pipe(clientSocket);
    });
    dst.on('error', () => {
      try {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } catch {
        clientSocket.destroy();
      }
    });
    clientSocket.on('error', () => dst.destroy());
  };
}

/**
 * 创建 HTTP 代理服务器（独立端口模式）
 * @param {{username?: string, password?: string, logger?: object}} options
 * @returns {import('node:http').Server}
 */
function createHttpProxy(options = {}) {
  const checkAuth = createAuthChecker(options);
  const logger = options.logger;
  const handleAbsolute = createAbsoluteHandler({ checkAuth, logger });
  const handleConnect = createConnectHandler({ checkAuth, logger });

  const server = http.createServer(handleAbsolute);
  server.on('connect', handleConnect);
  server.on('error', (err) => {
    if (logger && logger.warn) logger.warn(`HTTP 代理异常: ${err.message}`);
  });
  return server;
}

module.exports = {
  createHttpProxy,
  createAuthChecker,
  createAbsoluteHandler,
  createConnectHandler,
};
