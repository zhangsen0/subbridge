'use strict';

/**
 * SOCKS5 代理服务器（RFC 1928 + RFC 1929 用户名密码认证）
 *
 * 支持：
 *   - CONNECT（TCP 转发）
 *   - UDP ASSOCIATE（UDP 中继，单客户端关联）
 *   - 可选 RFC 1929 用户名密码认证
 *
 * 实现为纯 Node 标准库，无第三方依赖；所有参数来自配置。
 */

const net = require('node:net');
const dgram = require('node:dgram');

const VERSION = 0x05;
const CMD_CONNECT = 0x01;
const CMD_UDP_ASSOCIATE = 0x03;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_SUCCESS = 0x00;
const REP_HOST_UNREACHABLE = 0x04;
const REP_CMD_NOT_SUPPORTED = 0x07;
const REP_ATYP_NOT_SUPPORTED = 0x08;

/** 缓冲读取器：按需 peek/take，处理 TCP 粘包 */
class BufferReader {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(buf) {
    this.chunks.push(buf);
    this.length += buf.length;
  }

  /** 读取但不消费 */
  peek(n) {
    if (this.length < n) return null;
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    for (const chunk of this.chunks) {
      const take = Math.min(chunk.length, n - offset);
      chunk.copy(out, offset, 0, take);
      offset += take;
      if (offset >= n) break;
    }
    return out;
  }

  /** 读取并消费 */
  take(n) {
    const buf = this.peek(n);
    if (!buf) return null;
    let remaining = n;
    while (remaining > 0) {
      const chunk = this.chunks[0];
      if (chunk.length <= remaining) {
        this.chunks.shift();
        remaining -= chunk.length;
      } else {
        this.chunks[0] = chunk.subarray(remaining);
        remaining = 0;
      }
    }
    this.length -= n;
    return buf;
  }

  get available() {
    return this.length;
  }
}

/**
 * 创建 SOCKS5 代理服务器
 * @param {{username?: string, password?: string, logger?: object}} options
 * @returns {import('node:net').Server}
 */
function createSocks5Server(options = {}) {
  const username = options.username || '';
  const password = options.password || '';
  const logger = options.logger;
  const authRequired = !!(username || password);

  const server = net.createServer((socket) => handleClient(socket));

  function handleClient(socket) {
    const reader = new BufferReader();
    let stage = 'greeting';
    let authed = !authRequired;

    socket.on('data', (chunk) => {
      reader.push(chunk);
      try {
        pump();
      } catch {
        socket.destroy();
      }
    });
    socket.on('error', () => socket.destroy());

    /** 状态机：greeting -> auth(可选) -> request -> 转发 */
    function pump() {
      if (stage === 'greeting') {
        const head = reader.peek(2);
        if (!head) return;
        if (head[0] !== VERSION) throw new Error('不支持的 SOCKS 版本');
        const nMethods = head[1];
        const methods = reader.peek(2 + nMethods);
        if (!methods) return;
        reader.take(2 + nMethods);

        const offered = [...methods.subarray(2)];
        if (authRequired) {
          if (!offered.includes(0x02)) {
            socket.write(Buffer.from([VERSION, 0xff]));
            socket.destroy();
            return;
          }
          socket.write(Buffer.from([VERSION, 0x02]));
          stage = 'auth';
          return;
        }
        if (!offered.includes(0x00)) {
          socket.write(Buffer.from([VERSION, 0xff]));
          socket.destroy();
          return;
        }
        socket.write(Buffer.from([VERSION, 0x00]));
        stage = 'request';
        return;
      }

      if (stage === 'auth') {
        // RFC 1929: VER=1 ULEN UNAME PLEN PASSWD
        const head = reader.peek(2);
        if (!head) return;
        if (head[0] !== 0x01) throw new Error('认证协议错误');
        const ulen = head[1];
        const mid = reader.peek(2 + ulen + 1);
        if (!mid) return;
        const plen = mid[2 + ulen];
        const full = reader.peek(2 + ulen + 1 + plen);
        if (!full) return;
        reader.take(2 + ulen + 1 + plen);

        const uname = full.subarray(2, 2 + ulen).toString('utf8');
        const pass = full.subarray(2 + ulen + 1).toString('utf8');
        if (uname === username && pass === password) {
          authed = true;
          socket.write(Buffer.from([0x01, 0x00]));
          stage = 'request';
        } else {
          socket.write(Buffer.from([0x01, 0x01]));
          socket.destroy();
        }
        return;
      }

      if (stage === 'request') {
        const head = reader.peek(4);
        if (!head) return;
        const cmd = head[1];
        const atyp = head[3];

        // 解析目标地址
        let host;
        let total;
        if (atyp === ATYP_IPV4) {
          total = 10;
        } else if (atyp === ATYP_IPV6) {
          total = 22;
        } else if (atyp === ATYP_DOMAIN) {
          const lenByte = reader.peek(5);
          if (!lenByte) return;
          total = 4 + 1 + lenByte[4] + 2;
        } else {
          reply(socket, REP_ATYP_NOT_SUPPORTED);
          socket.destroy();
          return;
        }
        const full = reader.peek(total);
        if (!full) return;
        reader.take(total);

        let offset = 4;
        if (atyp === ATYP_DOMAIN) {
          const dl = full[offset];
          host = full.subarray(offset + 1, offset + 1 + dl).toString('utf8');
          offset += 1 + dl;
        } else if (atyp === ATYP_IPV4) {
          host = [...full.subarray(offset, offset + 4)].join('.');
          offset += 4;
        } else {
          host = formatIPv6(full.subarray(offset, offset + 16));
          offset += 16;
        }
        const port = full.readUInt16BE(offset);

        if (cmd === CMD_CONNECT) return doConnect(socket, host, port);
        if (cmd === CMD_UDP_ASSOCIATE) return doUdpAssociate(socket);
        reply(socket, REP_CMD_NOT_SUPPORTED);
        socket.destroy();
      }
    }
  }

  /** TCP 转发 */
  function doConnect(socket, host, port) {
    const dst = net.connect({ host, port });
    dst.on('connect', () => {
      reply(socket, REP_SUCCESS, dst.localAddress, dst.localPort);
      socket.pipe(dst);
      dst.pipe(socket);
    });
    dst.on('error', () => {
      try {
        reply(socket, REP_HOST_UNREACHABLE);
      } catch {
        /* 忽略 */
      }
      socket.destroy();
    });
    socket.on('error', () => dst.destroy());
  }

  /** UDP 中继（SOCKS5 UDP ASSOCIATE） */
  function doUdpAssociate(socket) {
    const udp = dgram.createSocket('udp4');
    const pending = new Map(); // 目标地址 -> 客户端地址
    let clientAddr = null;

    udp.on('error', () => {
      try {
        socket.destroy();
      } catch {
        /* 忽略 */
      }
    });

    // 收到客户端发来的 UDP 数据（带 SOCKS5 UDP 头）
    udp.on('message', (msg, rinfo) => {
      if (!clientAddr) clientAddr = rinfo;
      else if (rinfo.address !== clientAddr.address || rinfo.port !== clientAddr.port) return;

      const target = parseUdpHeader(msg);
      if (!target) return;
      const key = `${target.host}:${target.port}`;
      if (!pending.has(key)) pending.set(key, rinfo);
      udp.send(target.payload, target.port, target.host, () => {});
    });

    udp.bind(0, () => {
      const port = udp.address().port;
      reply(socket, REP_SUCCESS, '0.0.0.0', port);
      // 目标回包转发回客户端（带 SOCKS5 UDP 头）
      udp.on('message', (msg, rinfo) => {
        if (clientAddr && rinfo.address === clientAddr.address && rinfo.port === clientAddr.port) return;
        const client = pending.get(`${rinfo.address}:${rinfo.port}`);
        if (!client) return;
        const header = buildUdpHeader(rinfo.address, rinfo.port);
        udp.send(Buffer.concat([header, msg]), client.port, client.address, () => {});
      });
    });

    socket.on('close', () => udp.close());
    socket.on('error', () => udp.close());
  }

  /** SOCKS5 回复 */
  function reply(socket, rep, bndAddr = '0.0.0.0', bndPort = 0) {
    // BND.ADDR 使用 IPv4 形式
    const buf = Buffer.alloc(10);
    buf[0] = VERSION;
    buf[1] = rep;
    buf[2] = 0x00;
    buf[3] = ATYP_IPV4;
    const parts = String(bndAddr || '0.0.0.0').split('.').map((v) => parseInt(v, 10) || 0);
    buf.writeUInt32BE(((parts[0] || 0) << 24) | ((parts[1] || 0) << 16) | ((parts[2] || 0) << 8) | (parts[3] || 0), 4);
    buf.writeUInt16BE(bndPort || 0, 8);
    socket.write(buf);
  }

  /** 解析 SOCKS5 UDP 数据头：RSV(2) FRAG(1) ATYP(1) DST.ADDR DST.PORT DATA */
  function parseUdpHeader(msg) {
    if (msg.length < 4) return null;
    if (msg[2] !== 0) return null; // 不支持分片
    const atyp = msg[3];
    let host;
    let offset;
    if (atyp === ATYP_IPV4) {
      if (msg.length < 10) return null;
      host = [...msg.subarray(4, 8)].join('.');
      offset = 8;
    } else if (atyp === ATYP_DOMAIN) {
      const dl = msg[4];
      if (msg.length < 5 + dl + 2) return null;
      host = msg.subarray(5, 5 + dl).toString('utf8');
      offset = 5 + dl;
    } else if (atyp === ATYP_IPV6) {
      if (msg.length < 22) return null;
      host = formatIPv6(msg.subarray(4, 20));
      offset = 20;
    } else {
      return null;
    }
    const port = msg.readUInt16BE(offset);
    return { host, port, payload: msg.subarray(offset + 2) };
  }

  /** 构造 SOCKS5 UDP 数据头（目标地址以域名形式编码，客户端普遍兼容） */
  function buildUdpHeader(host, port) {
    const hostBuf = Buffer.from(host, 'utf8');
    const header = Buffer.alloc(4 + 1 + hostBuf.length + 2);
    header[2] = 0x00; // FRAG
    header[3] = ATYP_DOMAIN;
    header[4] = hostBuf.length;
    hostBuf.copy(header, 5);
    header.writeUInt16BE(port, 5 + hostBuf.length);
    return header;
  }

  /** 将 16 字节 IPv6 地址格式化为可读字符串 */
  function formatIPv6(buf) {
    const groups = [];
    for (let i = 0; i < 16; i += 2) {
      groups.push(buf.readUInt16BE(i).toString(16));
    }
    return groups.join(':').replace(/(^|:)0+(?=[0-9a-f])/g, '$1');
  }

  server.on('error', (err) => {
    if (logger) logger.warn(`SOCKS5 代理异常: ${err.message}`);
  });
  return server;
}

module.exports = { createSocks5Server };
