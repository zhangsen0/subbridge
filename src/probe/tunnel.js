'use strict';

/**
 * 代理隧道客户端
 *
 * 通过 http（CONNECT）或 socks5 代理建立到目标 host:port 的隧道，
 * 用于对 http/socks5 节点做真实下载测速（验证节点可用性 + 测网速）。
 *
 * 支持：
 *   - http 代理（含 TLS 代理，如经 CF 隧道暴露的节点）
 *   - socks5 代理（RFC 1928 客户端握手，支持用户名密码认证）
 */

const net = require('node:net');
const tls = require('node:tls');

/**
 * 通过代理建立到目标的隧道
 * @param {{type: string, server: string, port: number, username?: string, password?: string, tls?: boolean, sni?: string, skipCertVerify?: boolean}} proxy 代理节点
 * @param {string} host 目标主机
 * @param {number} port 目标端口
 * @param {number} timeoutMs 超时（毫秒）
 * @returns {Promise<import('node:net').Socket>} 已连接的 socket（TLS 代理返回 TLS socket）
 */
function openProxyTunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const raw = net.connect({ host: proxy.server, port: proxy.port });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        raw.destroy();
        reject(new Error('连接代理超时'));
      }
    }, timeoutMs || 5000);

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      raw.destroy();
      reject(err);
    };
    const succeed = (socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    };

    raw.once('error', (err) => fail(err));

    if (proxy.type === 'http') {
      setupHttpConnect(raw, proxy, host, port, succeed, fail);
    } else if (proxy.type === 'socks5') {
      setupSocks5(raw, proxy, host, port, succeed, fail);
    } else {
      fail(new Error(`不支持的代理类型: ${proxy.type}`));
    }
  });
}

/** http 代理 CONNECT 隧道 */
function setupHttpConnect(raw, proxy, host, port, succeed, fail) {
  const auth = proxy.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`
    : '';
  raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);

  let buf = '';
  const onData = (chunk) => {
    buf += chunk.toString('latin1');
    const idx = buf.indexOf('\r\n\r\n');
    if (idx < 0) {
      if (buf.length > 8192) fail(new Error('代理响应异常'));
      return;
    }
    raw.removeListener('data', onData);
    const head = buf.slice(0, idx);
    if (!/^HTTP\/1\.[01] 200/i.test(head)) {
      return fail(new Error(`代理 CONNECT 失败: ${head.split('\r\n')[0] || '未知错误'}`));
    }
    const rest = buf.slice(idx + 4);
    if (rest.length) raw.unshift(Buffer.from(rest, 'latin1'));
    finishTls(raw, proxy, succeed, fail);
  };
  raw.on('data', onData);
}

/** socks5 代理握手 + CONNECT */
function setupSocks5(raw, proxy, host, port, succeed, fail) {
  // 1. 问候：05 01 方法（00 无认证 / 02 用户名密码）
  raw.write(Buffer.from([0x05, 0x01, proxy.username ? 0x02 : 0x00]));
  let stage = 'greeting';
  let acc = Buffer.alloc(0);

  raw.on('data', function onData(chunk) {
    acc = Buffer.concat([acc, chunk]);
    try {
      if (stage === 'greeting') {
        if (acc.length < 2) return;
        const method = acc[1];
        acc = Buffer.alloc(0);
        if (method === 0x02) {
          // 2. 认证：01 ULEN UNAME PLEN PASSWD
          const user = Buffer.from(proxy.username, 'utf8');
          const pass = Buffer.from(proxy.password, 'utf8');
          const msg = Buffer.alloc(3 + user.length + pass.length);
          msg[0] = 0x01;
          msg[1] = user.length;
          user.copy(msg, 2);
          msg[2 + user.length] = pass.length;
          pass.copy(msg, 3 + user.length);
          stage = 'auth';
          raw.write(msg);
          return;
        }
        if (method === 0x00) {
          stage = 'connect';
          return sendConnect(raw, host, port);
        }
        return fail(new Error('SOCKS5 服务器不支持所需认证方式'));
      }
      if (stage === 'auth') {
        if (acc.length < 2) return;
        const ok = acc[0] === 0x01 && acc[1] === 0x00;
        acc = Buffer.alloc(0);
        if (!ok) return fail(new Error('SOCKS5 认证失败'));
        stage = 'connect';
        return sendConnect(raw, host, port);
      }
      if (stage === 'connect') {
        if (acc.length < 10) return;
        if (acc[1] !== 0x00) return fail(new Error(`SOCKS5 连接失败（code=${acc[1]}）`));
        return finishTls(raw, proxy, succeed, fail);
      }
    } catch (err) {
      fail(err);
    }
  });
}

/** 发送 socks5 CONNECT 请求（目标地址以域名形式编码） */
function sendConnect(raw, host, port) {
  const hostBuf = Buffer.from(host, 'utf8');
  const msg = Buffer.alloc(4 + 1 + hostBuf.length + 2);
  msg[0] = 0x05;
  msg[1] = 0x01; // CONNECT
  msg[2] = 0x00;
  msg[3] = 0x03; // 域名
  msg[4] = hostBuf.length;
  hostBuf.copy(msg, 5);
  msg.writeUInt16BE(port, 5 + hostBuf.length);
  raw.write(msg);
}

/** 若代理为 TLS（如 CF 隧道暴露的 http 节点），对隧道做 TLS 包装 */
function finishTls(raw, proxy, succeed, fail) {
  if (!proxy.tls) return succeed(raw);
  const wrapped = tls.connect({
    socket: raw,
    servername: proxy.sni || proxy.server,
    rejectUnauthorized: !proxy.skipCertVerify,
  });
  wrapped.once('secureConnect', () => succeed(wrapped));
  wrapped.once('error', (err) => fail(err));
}

/**
 * 通过代理做下载测速
 * @param {object} proxy 代理节点（http/socks5）
 * @param {string} targetUrl 测速下载地址
 * @param {number} sampleBytes 采样字节数（收到该字节量即结束）
 * @param {number} timeoutMs 超时（毫秒）
 * @returns {Promise<number|null>} 速度（字节/秒）；失败返回 null
 */
async function speedTestViaTunnel(proxy, targetUrl, sampleBytes, timeoutMs) {
  let u;
  try {
    u = new URL(targetUrl);
  } catch {
    return null;
  }
  const targetPort = u.port || (u.protocol === 'https:' ? 443 : 80);
  const socket = await openProxyTunnel(proxy, u.hostname, Number(targetPort), timeoutMs);

  return new Promise((resolve) => {
    const start = Date.now();
    let received = 0;
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const calc = () => {
      const ms = Date.now() - start;
      return ms > 50 && received > 0 ? Math.round((received * 1000) / ms) : null;
    };

    const timer = setTimeout(() => finish(calc()), timeoutMs || 5000);

    socket.on('data', (chunk) => {
      received += chunk.length;
      if (received >= sampleBytes) finish(calc());
    });
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(calc()));

    const request = `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: SubBridge/1.0\r\nConnection: close\r\n\r\n`;
    socket.write(request);
  });
}

/**
 * 经代理做 TCP 连通性探测（CONNECT 隧道打通即视为可达）
 * 用于「沙箱 / 受限网络」等直连不可达场景：探测也走上游代理。
 * @param {string} proxyUrl 代理地址（http://user:pass@host:port 或 socks5://user:pass@host:port）
 * @param {string} host 目标主机
 * @param {number} port 目标端口
 * @param {number} timeoutMs 超时（毫秒）
 * @returns {Promise<number|null>} 隧道建立延迟（毫秒）；不可达返回 null
 */
async function probeViaProxy(proxyUrl, host, port, timeoutMs) {
  let proxy;
  try {
    const u = new URL(proxyUrl);
    if (u.protocol === 'http:') {
      proxy = {
        type: 'http',
        server: u.hostname,
        port: Number(u.port || 80),
        username: u.username || undefined,
        password: u.password || undefined,
        tls: false,
      };
    } else if (u.protocol === 'socks5:') {
      proxy = {
        type: 'socks5',
        server: u.hostname,
        port: Number(u.port || 1080),
        username: u.username || undefined,
        password: u.password || undefined,
      };
    } else {
      return null;
    }
  } catch {
    return null;
  }
  try {
    const start = Date.now();
    const socket = await openProxyTunnel(proxy, host, port, timeoutMs || 5000);
    socket.destroy();
    return Date.now() - start;
  } catch {
    return null;
  }
}

/**
 * 经 HTTP 上游代理（协议桥输出或 http/socks 节点直用）真实下载测速：
 * 请求 speedTestUrl 并下载指定字节量，统计速度（字节/秒）；请求非 2xx/超时返回 null。
 * 用于对任意协议节点做"真实代理连通验证 + 网速测量"（TCP 通不代表协议可用）。
 * @param {string} proxyUrl HTTP 上游代理地址（如 http://127.0.0.1:42379 或 http://user:pass@server:port）
 * @param {string} url 测速地址
 * @param {number} bytes 采样字节数
 * @param {number} timeoutMs 超时（毫秒）
 * @returns {Promise<number|null>} 速度（字节/秒）；失败返回 null
 */
async function speedViaHttpProxy(proxyUrl, url, bytes, timeoutMs) {
  if (!proxyUrl || !url) return null;
  const undici = require('undici');
  const agent = new undici.ProxyAgent(proxyUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 5000);
  try {
    const resp = await undici.fetch(url, { agent, signal: controller.signal });
    if (!resp || !resp.ok || !resp.body) return null;
    const start = Date.now();
    let count = 0;
    for await (const chunk of resp.body) {
      count += chunk.length;
      if (count >= (bytes || 200000)) break;
    }
    const elapsed = (Date.now() - start) / 1000;
    return elapsed > 0 ? Math.round(count / elapsed) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { openProxyTunnel, speedTestViaTunnel, probeViaProxy, speedViaHttpProxy };
