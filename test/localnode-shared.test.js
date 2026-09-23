'use strict';

/* 端口复用（shared）模式单元测试：CONNECT 隧道 / 绝对 URL 转发 / 认证 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');

const { createConnectHandler, createAbsoluteHandler, createAuthChecker } = require('../src/localnode/httpProxy');

/** 构造一个本地 echo HTTP 服务，返回 { server, url, close } */
function startEchoServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('echo-ok:' + req.url);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** 通过 CONNECT 隧道请求一个 http 目标（手工构造 HTTP 请求字节流） */
function tunnelRequest(proxyServer, targetHost, targetPort, authHeader) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyServer.address().port, '127.0.0.1', () => {
      let req = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
      if (authHeader) req += `Proxy-Authorization: ${authHeader}\r\n`;
      req += '\r\n';
      socket.write(req);
    });
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.includes('\r\n\r\n')) {
        const head = buf.toString('utf8');
        if (head.startsWith('HTTP/1.1 200')) {
          // 建立隧道后，向目标发送一条 HTTP 请求
          socket.write(`GET /probe HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`);
        }
      }
      // 收到响应结束（echo 服务关闭连接）即完成
      if (buf.toString('utf8').includes('echo-ok:')) {
        socket.destroy();
        resolve(buf.toString('utf8'));
      }
    });
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); reject(new Error('tunnel timeout')); }, 5000).unref();
  });
}

test('shared CONNECT：认证正确时隧道连通目标服务', async () => {
  const echo = await startEchoServer();
  const auth = createAuthChecker({ username: 'u', password: 'p' });
  const handler = createConnectHandler({ checkAuth: auth });
  const proxy = http.createServer();
  proxy.on('connect', handler);
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

  const target = new URL(echo.url);
  const body = await tunnelRequest(proxy, target.hostname, target.port, 'Basic ' + Buffer.from('u:p').toString('base64'));
  assert.ok(body.includes('echo-ok:/probe'), '隧道应转发到目标服务并返回响应');

  proxy.close();
  echo.server.close();
});

test('shared CONNECT：认证错误返回 407', async () => {
  const auth = createAuthChecker({ username: 'u', password: 'p' });
  const handler = createConnectHandler({ checkAuth: auth });
  const proxy = http.createServer();
  proxy.on('connect', handler);
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

  const body = await new Promise((resolve, reject) => {
    const socket = net.connect(proxy.address().port, '127.0.0.1', () => {
      socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
    });
    let buf = '';
    socket.on('data', (d) => { buf += d.toString(); });
    socket.on('end', () => resolve(buf));
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 5000).unref();
  });
  assert.ok(body.startsWith('HTTP/1.1 407'), '错误认证应返回 407');

  proxy.close();
});

test('shared absolute：GET http://host/path 正常转发并带认证', async () => {
  const echo = await startEchoServer();
  const auth = createAuthChecker({ username: 'u', password: 'p' });
  const handler = createAbsoluteHandler({ checkAuth: auth });
  const proxy = http.createServer(handler);
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

  const target = new URL(echo.url);
  const res = await new Promise((resolve, reject) => {
    http.get(
      {
        host: '127.0.0.1',
        port: proxy.address().port,
        path: `http://${target.host}/page`,
        headers: { 'Proxy-Authorization': 'Basic ' + Buffer.from('u:p').toString('base64') },
      },
      resolve,
    ).on('error', reject);
  });
  let body = '';
  for await (const chunk of res) body += chunk;
  assert.equal(res.statusCode, 200);
  assert.equal(body, 'echo-ok:/page');

  proxy.close();
  echo.server.close();
});

test('shared absolute：无认证返回 407', async () => {
  const echo = await startEchoServer();
  const auth = createAuthChecker({ username: 'u', password: 'p' });
  const handler = createAbsoluteHandler({ checkAuth: auth });
  const proxy = http.createServer(handler);
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

  const target = new URL(echo.url);
  const res = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: proxy.address().port, path: `http://${target.host}/page` }, resolve).on('error', reject);
  });
  assert.equal(res.statusCode, 407);

  proxy.close();
  echo.server.close();
});
