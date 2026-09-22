'use strict';

/**
 * HTTP 代理服务器（通用 HTTP(S) 转发）
 *
 * 支持：
 *   - 绝对形式请求转发：GET http://host:port/path（普通 HTTP）
 *   - CONNECT 隧道：HTTPS / 任意 TCP 协议
 *   - 可选 Basic 认证（Proxy-Authorization）
 *
 * 所有参数（端口/认证）均来自配置，禁止写死。
 */

const http = require('node:http');
const net = require('node:net');
const { splitHostPort } = require('../core/util');

/**
 * 创建 HTTP 代理服务器
 * @param {{username?: string, password?: string, logger?: object}} options
 * @returns {import('node:http').Server}
 */
function createHttpProxy(options = {}) {
  const username = options.username || '';
  const password = options.password || '';
  const logger = options.logger;
  const authRequired = !!(username || password);
  const expectedAuth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

  /** 校验代理认证 */
  function checkAuth(req) {
    if (!authRequired) return true;
    return (req.headers['proxy-authorization'] || '') === expectedAuth;
  }

  /** 认证失败响应 */
  function rejectUnauthorized(res) {
    res.writeHead(407, {
      'Proxy-Authenticate': 'Basic realm="SubBridge"',
      'content-length': '0',
    });
    res.end();
  }

  const server = http.createServer((req, res) => {
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
  });

  // CONNECT 隧道（HTTPS 与任意 TCP）
  server.on('connect', (req, clientSocket, head) => {
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
  });

  server.on('error', (err) => {
    if (logger) logger.warn(`HTTP 代理异常: ${err.message}`);
  });
  return server;
}

module.exports = { createHttpProxy };
