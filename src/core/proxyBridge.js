'use strict';

/**
 * 协议桥（ProxyBridge）
 *
 * 目标："拉取外部节点时，节点池里所有协议类型的节点都可以作为抓取中转代理"。
 * 对节点池选中的任意协议节点，在本机起一个本地 HTTP 代理（127.0.0.1:随机端口），
 * 该代理收到 CONNECT / 普通请求后，用节点自身协议建立到目标 host:port 的加密隧道，
 * 从而实现"ss / vless / trojan / socks 等节点 → HTTP 上游代理"的通用中转能力。
 *
 * 支持的节点协议：
 *   - http / https：直接使用（无需本地桥）
 *   - socks4 / socks5：通过 socks 库建立隧道
 *   - ss：Shadowsocks（AEAD：aes-128-gcm / aes-256-gcm / chacha20-ietf-poly1305 / xchacha20-ietf-poly1305；
 *           legacy：aes-128-cfb / aes-256-cfb / rc4-md5）
 *   - trojan：TLS + trojan 协议头
 *   - vless：TLS + vless 协议头（TCP 直连模式）
 * 暂不支持（抓取时自动跳过并提示）：vmess（协议细节繁杂且缺真实节点验证）、
 *   ws 传输模式、hysteria2 / tuic（QUIC，纯 Node 无客户端）。
 *
 * 全部参数来自节点对象字段（server / port / username / password / uuid / sni /
 *   method / network 等），不写死；桥实例带 TTL 缓存复用，避免每次抓取重建。
 */

const http = require('http');
const net = require('net');
const { EventEmitter } = require('events');
const tls = require('tls');
const crypto = require('crypto');
const { Duplex } = require('stream');
const { SocksClient } = require('socks');
const WebSocket = require('ws');

/* ------------------------------------------------------------------ */
/* 工具函数                                                             */
/* ------------------------------------------------------------------ */

/** 把主机名与端口编码为代理协议通用目标地址头（ATYP + ADDR + PORT） */
/** SOCKS5 / SS / Trojan 地址类型常量 */
const SOCKS_ATYP = { ipv4: 0x01, domain: 0x03, ipv6: 0x04 };
/** VLESS 地址类型常量（与 SOCKS5 不同：域名=0x02、IPv6=0x03） */
const VLESS_ATYP = { ipv4: 0x01, domain: 0x02, ipv6: 0x03 };

/**
 * 构造地址头（ATYP + 地址 + 端口，端口在前由调用方拼装）
 * @param {string} host 目标主机（IPv4 / IPv6 / 域名）
 * @param {number} port 目标端口
 * @param {string} [style] 地址类型风格：'socks'（SS/Trojan/SOCKS5，默认）或 'vless'
 */
function buildAddrHead(host, port, style) {
  const atyp = (style || '').toLowerCase() === 'vless' ? VLESS_ATYP : SOCKS_ATYP;
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port, 0);
  if (net.isIPv4(host)) {
    const b = Buffer.alloc(7);
    b[0] = atyp.ipv4;
    b.write(host.split('.').map((x) => String.fromCharCode(Number(x))).join(''), 1, 4, 'binary');
    return Buffer.concat([b.subarray(0, 5), p]);
  }
  if (net.isIPv6(host)) {
    const b = Buffer.alloc(1 + 16 + 2);
    b[0] = atyp.ipv6;
    // ipv6 解析为 16 字节
    const parts = host.split(':');
    let idx = 1;
    for (const part of parts) {
      if (part === '') continue;
      const n = parseInt(part || '0', 16);
      b.writeUInt16BE(n, idx);
      idx += 2;
    }
    return Buffer.concat([b.subarray(0, 17), p]);
  }
  const hb = Buffer.from(host, 'utf8');
  const b = Buffer.alloc(1 + 1 + hb.length + 2);
  b[0] = atyp.domain;
  b[1] = hb.length;
  hb.copy(b, 2);
  b.writeUInt16BE(port, 2 + hb.length);
  return b;
}

/**
 * 解析地址头：返回 host + port
 * @param {Buffer} buf 地址头数据
 * @param {number} offset 起始偏移
 * @param {string} [style] 'socks'（默认）或 'vless'
 */
function parseAddrHead(buf, offset = 0, style) {
  const atyp = (style || '').toLowerCase() === 'vless' ? VLESS_ATYP : SOCKS_ATYP;
  const b = buf[offset];
  let host;
  let portOff;
  if (b === atyp.ipv4) {
    host = `${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}.${buf[offset + 4]}`;
    portOff = offset + 5;
  } else if (b === atyp.domain) {
    const len = buf[offset + 1];
    host = buf.subarray(offset + 2, offset + 2 + len).toString('utf8');
    portOff = offset + 2 + len;
  } else if (b === atyp.ipv6) {
    const chunks = [];
    for (let i = 0; i < 8; i++) chunks.push(buf.readUInt16BE(offset + 1 + i * 2).toString(16));
    host = chunks.join(':');
    portOff = offset + 17;
  } else {
    throw new Error('不支持的地址类型: ' + b);
  }
  return { host, port: buf.readUInt16BE(portOff) };
}

/** 建立 TCP 连接（带超时） */
function tcpConnect(host, port, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`连接超时 ${host}:${port}`));
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Shadowsocks 客户端（AEAD + legacy）                                  */
/* ------------------------------------------------------------------ */

const AEAD_METHODS = {
  'aes-128-gcm': { keyLen: 16, cipher: 'aes-128-gcm' },
  'aes-256-gcm': { keyLen: 32, cipher: 'aes-256-gcm' },
  'chacha20-ietf-poly1305': { keyLen: 32, cipher: 'chacha20-poly1305' },
  'chacha20-poly1305': { keyLen: 32, cipher: 'chacha20-poly1305' },
  'xchacha20-ietf-poly1305': { keyLen: 32, cipher: 'chacha20-poly1305' },
};
const LEGACY_METHODS = {
  'aes-128-cfb': { keyLen: 16, cipher: 'aes-128-cfb' },
  'aes-256-cfb': { keyLen: 32, cipher: 'aes-256-cfb' },
  'rc4-md5': { keyLen: 16, cipher: 'rc4' },
};

/** EVP_BytesToKey（与 ss 标准一致：MD5 迭代派生） */
function evpBytesToKey(password, keyLen) {
  const pwd = Buffer.from(password, 'utf8');
  const m = crypto.createHash('md5');
  m.update(pwd);
  let d = m.digest();
  let data = d;
  while (data.length < keyLen) {
    const mm = crypto.createHash('md5');
    mm.update(d);
    mm.update(pwd);
    d = mm.digest();
    data = Buffer.concat([data, d]);
  }
  return data.subarray(0, keyLen);
}

/** AEAD 子密钥（HKDF-SHA1，固定信息 "ss-subkey"） */
function ssHkdf(master, salt, keyLen) {
  return crypto.hkdfSync('sha1', master, salt, Buffer.from('ss-subkey'), keyLen);
}

/** 构造 AEAD nonce：前 4 字节大端序号 + 后 8 字节零 */
function buildAeadNonce(seq) {
  const n = Buffer.alloc(12);
  n.writeUInt32BE(seq, 0);
  return n;
}

/**
 * AEAD 加密隧道流：负责 chunk 化加解密。
 * 用法与 socket 类似（write / on('data') / end / destroy）。
 */
class SSAeadStream extends EventEmitter {
  constructor(socket, subkey, cipherName) {
    super();
    this.socket = socket;
    this.subkey = subkey;
    this.cipherName = cipherName;
    this.sendSeq = 0;
    this.recvSeq = 0;
    this.recvBuf = Buffer.alloc(0);
    this.ended = false;
    this._bindRead();
  }

  /** 写入明文（自动分块加密，SIP022 AEAD：长度与载荷各自独立 AEAD 加密） */
  write(buf) {
    if (this.ended) return;
    const plain = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    for (let off = 0; off < plain.length; off += 0x3fff) {
      const chunk = plain.subarray(off, off + 0x3fff);
      this.socket.write(this._encryptChunk(chunk));
    }
  }

  /** 加密单个 chunk：enc(length)|enc(payload)，各用独立递增 nonce */
  _encryptChunk(plain) {
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(plain.length, 0);
    const encLen = this._aeadEncrypt(lenBuf, this.sendSeq++);
    const encPayload = this._aeadEncrypt(plain, this.sendSeq++);
    return Buffer.concat([encLen, encPayload]);
  }

  _aeadEncrypt(plain, seq) {
    const c = crypto.createCipheriv(this.cipherName, this.subkey, buildAeadNonce(seq));
    // Node GCM：认证 tag 需 getAuthTag 单独获取并追加到密文尾部
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  }

  /** AEAD 解密：拆出尾部 16 字节 tag 后 setAuthTag 校验 */
  _aeadDecrypt(enc, seq) {
    const tag = enc.subarray(enc.length - 16);
    const data = enc.subarray(0, enc.length - 16);
    const d = crypto.createDecipheriv(this.cipherName, this.subkey, buildAeadNonce(seq));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]);
  }

  _bindRead() {
    this.socket.on('data', (d) => {
      this.recvBuf = Buffer.concat([this.recvBuf, d]);
      this._drain();
    });
    this.socket.on('error', (e) => this.emit && this.emit('error', e));
    this.socket.on('close', () => this.emit && this.emit('close'));
    this.socket.on('end', () => this.emit && this.emit('end'));
  }

  _drain() {
    // SIP022 读方向：每 chunk = AEAD 密文长度(2B+16B tag) + AEAD 密文载荷(len+16B tag)
    while (this.recvBuf.length >= 2 + 16) {
      const encLen = this.recvBuf.subarray(0, 2 + 16);
      let len;
      try {
        len = this._aeadDecrypt(encLen, this.recvSeq++).readUInt16BE(0);
      } catch (err) {
        if (this.emit) this.emit('error', new Error('AEAD 长度解密失败: ' + err.message));
        return;
      }
      if (this.recvBuf.length < 2 + 16 + len + 16) break;
      const encPayload = this.recvBuf.subarray(2 + 16, 2 + 16 + len + 16);
      this.recvBuf = this.recvBuf.subarray(2 + 16 + len + 16);
      let plain;
      try {
        plain = this._aeadDecrypt(encPayload, this.recvSeq++);
      } catch (err) {
        if (this.emit) this.emit('error', new Error('AEAD 解密失败: ' + err.message));
        return;
      }
      if (this.emit) this.emit('data', plain);
    }
  }

  pipe(dest) {
    this.on('data', (d) => dest.write(d));
    this.on('end', () => dest.end && dest.end());
    this.on('error', () => {});
    if (dest.pipe && typeof dest.pipe === 'function') {
      // 上游往本流写
      dest.pipe(this);
    }
    return dest;
  }

  end() {
    this.ended = true;
    this.socket.end();
  }

  destroy() {
    this.ended = true;
    this.socket.destroy();
  }
}

/** legacy 加密隧道流（CFB / rc4）：整流加解密，无需分块 */
class SSLegacyStream extends EventEmitter {
  constructor(socket, cipherName, key) {
    super();
    this.socket = socket;
    this.enc = crypto.createCipheriv(cipherName, key, crypto.randomBytes(16));
    this.recvBuf = Buffer.alloc(0);
    this.recvIvRead = false;
    this.dec = null;
    this._bindRead();
  }

  /** 首次调用前需先发 iv（由 buildLegacy 处理），此处仅加密写入 */
  write(buf) {
    const out = this.enc.update(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    if (out && out.length) this.socket.write(out);
  }

  _bindRead() {
    this.socket.on('data', (d) => {
      this.recvBuf = Buffer.concat([this.recvBuf, d]);
      this._drain();
    });
    this.socket.on('error', (e) => this.emit && this.emit('error', e));
    this.socket.on('close', () => this.emit && this.emit('close'));
    this.socket.on('end', () => this.emit && this.emit('end'));
  }

  _drain() {
    if (!this.recvIvRead) {
      if (this.recvBuf.length < 16) return;
      const iv = this.recvBuf.subarray(0, 16);
      this.recvBuf = this.recvBuf.subarray(16);
      try {
        this.dec = crypto.createDecipheriv(this.cipherName, this.decKey, iv);
      } catch (e2) {
        if (this.emit) this.emit('error', e2);
        return;
      }
      this.recvIvRead = true;
    }
    if (this.recvBuf.length) {
      try {
        const out = this.dec.update(this.recvBuf);
        this.recvBuf = Buffer.alloc(0);
        if (out && out.length && this.emit) this.emit('data', out);
      } catch (err) {
        if (this.emit) this.emit('error', new Error('legacy 解密失败: ' + err.message));
      }
    }
  }

  pipe(dest) {
    this.on('data', (d) => dest.write(d));
    this.on('end', () => dest.end && dest.end());
    this.on('error', () => {});
    if (dest.pipe && typeof dest.pipe === 'function') dest.pipe(this);
    return dest;
  }

  end() { this.socket.end(); }
  destroy() { this.socket.destroy(); }
}

/**
 * Shadowsocks 客户端
 * @param {{server: string, port: number, password: string, method: string}} opts
 */
class ShadowsocksClient {
  constructor(opts) {
    this.server = opts.server;
    this.port = Number(opts.port);
    this.password = opts.password || '';
    this.method = (opts.method || 'aes-256-gcm').toLowerCase();
    this.keyLen = (AEAD_METHODS[this.method] || LEGACY_METHODS[this.method] || {}).keyLen || 32;
    this.cipher = (AEAD_METHODS[this.method] || LEGACY_METHODS[this.method] || {}).cipher || 'aes-256-gcm';
    this.isAead = Boolean(AEAD_METHODS[this.method]);
  }

  /**
   * 建立到目标 host:port 的加密隧道
   * @returns {Promise<SSAeadStream|SSLegacyStream>} 已发送目标地址头的双工流
   */
  async connect(host, port) {
    const socket = await tcpConnect(this.server, this.port);
    const addrHead = buildAddrHead(host, port);
    const master = evpBytesToKey(this.password, this.keyLen);
    if (this.isAead) {
      const salt = crypto.randomBytes(Math.max(32, this.keyLen));
      const subkey = ssHkdf(master, salt, this.keyLen);
      const stream = new SSAeadStream(socket, subkey, this.cipher);
      socket.write(salt);
      stream.write(addrHead);
      return stream;
    }
    // legacy：发送 iv + 加密的目标地址头；读方向先取服务器 iv 再解密
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.cipher, master, iv);
    socket.write(Buffer.concat([iv, cipher.update(addrHead)]));
    const stream = new SSLegacyStream(socket, this.cipher, master);
    stream.cipherName = this.cipher;
    stream.decKey = master;
    return stream;
  }
}

/* ------------------------------------------------------------------ */
/* Trojan / Vless 客户端                                                */
/* ------------------------------------------------------------------ */

/** TLS 连接（校验关闭，SNI 取 sni 或服务器地址） */
function tlsConnect(opts, host, port) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({
      host,
      port,
      servername: opts.sni || host,
      rejectUnauthorized: !opts.allowInsecure,
      ALPNProtocols: ['http/1.1'],
    });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`TLS 连接超时 ${host}:${port}`));
    }, 10000);
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Trojan 客户端：TLS + 密码 hex + 目标地址头 */
class TrojanClient {
  constructor(opts) {
    this.server = opts.server;
    this.port = Number(opts.port);
    this.password = opts.password || opts.uuid || '';
    this.sni = opts.sni || '';
    this.allowInsecure = !!opts.allowInsecure;
  }

  async connect(host, port) {
    const socket = await tlsConnect(this, this.server, this.port);
    // trojan 协议：hex(SHA224(密码)) + CRLF + command(1=TCP) + SOCKS5 地址头 + CRLF
    const passHash = crypto.createHash('sha224').update(this.password, 'utf8').digest('hex');
    const head = Buffer.concat([
      Buffer.from(passHash + '\r\n', 'utf8'),
      Buffer.from([0x01]), // command：1=TCP
      buildAddrHead(host, port),
      Buffer.from('\r\n', 'utf8'),
    ]);
    socket.write(head);
    return socket;
  }
}

/**
 * 构造 vless 协议头（版本 + uuid + 附加信息 + 命令 + ATYP + 地址 + 端口）
 * @param {string} uuid 节点 uuid
 * @param {string} host 目标主机
 * @param {number} port 目标端口
 * @returns {Buffer} vless 请求头
 */
function buildVlessHead(uuid, host, port) {
  const uuidHex = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(uuidHex)) throw new Error('vless uuid 格式不正确: ' + uuid);
  const addrHead = buildAddrHead(host, port, 'vless');
  const uuidBuf = Buffer.from(uuidHex, 'hex');
  return Buffer.concat([
    Buffer.from([0x00]), // 版本 0
    uuidBuf,
    Buffer.from([0x00]), // 附加信息长度 0
    Buffer.from([0x01]), // 命令：1=TCP 连接
    addrHead.subarray(addrHead.length - 2), // 端口（2 字节）
    Buffer.from([addrHead[0]]), // ATYP
    addrHead.subarray(1, addrHead.length - 2), // 地址
  ]);
}

/**
 * 把 WebSocket 会话包装成双工流（TCP 隧道语义）。
 * @param {import('ws').WebSocket} ws 已建立的 ws 连接
 * @param {number} [skipFirstBytes] 跳过首帧前 N 字节（vless 服务端响应头）
 * @param {() => void} [onClose] 关闭回调
 * @returns {import('stream').Duplex} 可 pipe 的双工流
 */
function wsToDuplex(ws, skipFirstBytes, onClose) {
  const skip = Math.max(0, Number(skipFirstBytes) || 0);
  let first = true;
  const duplex = new Duplex({
    read() {
      // 数据由 message 事件推入，无需主动读取
    },
    write(chunk, enc, cb) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk, (err) => cb(err || undefined));
      } else {
        cb(new Error('ws 已关闭'));
      }
    },
    final(cb) {
      try { ws.close(); } catch (e) { /* ignore */ }
      cb();
    },
    destroy(err, cb) {
      try { ws.terminate(); } catch (e) { /* ignore */ }
      cb(err);
    },
  });
  ws.on('message', (data) => {
    let buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (first && skip > 0) {
      first = false;
      buf = buf.subarray(skip); // 丢弃 vless 响应头字节，保留剩余数据
      if (buf.length === 0) return;
    }
    duplex.push(buf);
  });
  ws.on('close', () => {
    if (onClose) onClose();
    duplex.push(null);
  });
  ws.on('error', (err) => duplex.destroy(err));
  return duplex;
}

/**
 * 把 TCP 隧道包装成双工流，可跳过首帧前 N 字节（vless/trojan 响应头）。
 * @param {import('net').Socket} socket 已建立并写入协议头的 socket
 * @param {number} [skipFirstBytes] 首帧需跳过的字节数
 * @returns {import('stream').Duplex}
 */
function socketToDuplex(socket, skipFirstBytes) {
  const skip = Math.max(0, Number(skipFirstBytes) || 0);
  let first = true;
  const duplex = new Duplex({
    read() {
      // 数据由 socket data 事件推入
    },
    write(chunk, enc, cb) {
      if (!socket.destroyed) {
        socket.write(chunk, cb);
      } else {
        cb(new Error('隧道已关闭'));
      }
    },
    final(cb) {
      try { socket.end(); } catch (e) { /* ignore */ }
      cb();
    },
    destroy(err, cb) {
      try { socket.destroy(); } catch (e) { /* ignore */ }
      cb(err);
    },
  });
  socket.on('data', (buf) => {
    if (first && skip > 0) {
      first = false;
      buf = buf.subarray(skip);
      if (buf.length === 0) return;
    }
    duplex.push(buf);
  });
  socket.on('close', () => duplex.push(null));
  socket.on('error', (err) => duplex.destroy(err));
  return duplex;
}

/** Vless 客户端：TLS + 版本 + uuid + 命令 + 目标地址头（支持 TCP 直连与 ws 传输） */
class VlessClient {
  constructor(opts) {
    this.server = opts.server;
    this.port = Number(opts.port);
    this.uuid = opts.uuid || opts.password || '';
    this.sni = opts.sni || '';
    this.network = (opts.network || 'tcp').toLowerCase();
    this.wsPath = opts.wsPath || '/';
    this.allowInsecure = !!opts.allowInsecure;
  }

  /** 建立到目标 host:port 的 vless 隧道（TCP 直连或 ws 传输） */
  async connect(host, port) {
    const head = buildVlessHead(this.uuid, host, port);
    if (this.network === 'ws') {
      return this._connectWs(head);
    }
    const socket = await tlsConnect(this, this.server, this.port);
    // TCP 模式同样有 1 字节响应头：先建双工流（注册 data 监听，避免首帧丢失）再写协议头
    const duplex = socketToDuplex(socket, 2);
    socket.write(head);
    return duplex;
  }

  /** ws 传输：wss 握手 + vless 头经二进制帧发送，包装为双工流 */
  _connectWs(head) {
    return new Promise((resolve, reject) => {
      const wsUrl = `wss://${this.server}:${this.port}${this.wsPath.startsWith('/') ? this.wsPath : '/' + this.wsPath}`;
      const ws = new WebSocket(wsUrl, {
        headers: {
          Host: this.sni || this.server,
          Origin: `https://${this.sni || this.server}`,
        },
        // servername 必须用 SNI（CF 中转节点按 SNI 路由，用 IP 会被拒绝）
        servername: this.sni || this.server,
        rejectUnauthorized: !this.allowInsecure,
        handshakeTimeout: 10000,
      });
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch (e) { /* ignore */ }
        reject(new Error(`vless ws 握手超时 ${this.server}:${this.port}`));
      }, 12000);
      ws.once('open', () => {
        clearTimeout(timer);
        // 先建双工流（注册 message 监听）再发协议头，保证首帧（vless 响应头）不丢失
        const duplex = wsToDuplex(ws, 2);
        try {
          ws.send(head, { binary: true });
        } catch (e) {
          reject(e);
          return;
        }
        resolve(duplex);
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.once('unexpected-response', (req, res) => {
        clearTimeout(timer);
        res.resume();
        reject(new Error(`vless ws 握手失败 HTTP ${res.statusCode}`));
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* 本地 HTTP 桥                                                         */
/* ------------------------------------------------------------------ */

/**
 * 把"能建立任意目标隧道"的连接函数包装成本地 HTTP 代理（127.0.0.1:0）。
 * @param {(host: string, port: number) => Promise<Duplex>} connectFn
 * @returns {Promise<{url: string, server: import('http').Server}>}
 */
function createLocalBridge(connectFn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('connect', (req, clientSocket, head) => {
      const [host, portStr] = req.url.split(':');
      const port = Number(portStr || 443);
      connectFn(host, port)
        .then((up) => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length) up.write(head);
          up.pipe(clientSocket).pipe(up);
          up.on('error', (e) => { console.error('[proxyBridge] 隧道错误:', e && e.message ? e.message : e); clientSocket.destroy(); });
          clientSocket.on('error', () => up.destroy());
        })
        .catch((err) => {
          console.error('[proxyBridge] 隧道建立失败:', err && err.message ? err.message : err);
          try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) { /* ignore */ }
          clientSocket.destroy();
        });
    });
    server.on('request', (req, res) => {
      let target;
      try {
        target = new URL(req.url);
      } catch (e) {
        res.statusCode = 400;
        res.end('bad url');
        return;
      }
      const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
      connectFn(target.hostname, port)
        .then((up) => {
          const skip = new Set(['host', 'proxy-connection', 'connection', 'proxy-authorization', 'proxy-authenticate']);
          const headers = Object.entries(req.headers)
            .filter(([k]) => !skip.has(k.toLowerCase()))
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
            .join('\r\n');
          const rawHead = `${req.method} ${target.pathname + target.search} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`;
          up.write(rawHead);
          up.pipe(res);
          req.pipe(up);
          up.on('error', () => res.destroy());
          res.on('close', () => up.destroy());
        })
        .catch(() => {
          res.statusCode = 502;
          res.end('bridge failed');
        });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

/* ------------------------------------------------------------------ */
/* 对外：按节点类型创建桥                                               */
/* ------------------------------------------------------------------ */

/** 判断节点协议是否支持作为抓取中转 */
function isSupportedProxyType(type) {
  return ['http', 'https', 'socks', 'socks4', 'socks5', 'ss', 'trojan', 'vless'].includes((type || '').toLowerCase());
}

/** 构造节点协议连接函数；不支持的协议返回 null */
function buildConnectFn(node) {
  const type = (node.type || '').toLowerCase();
  if (type === 'http' || type === 'https') {
    // 直接代理：由调用方直接构造 ProxyAgent URL
    return null;
  }
  if (type === 'socks' || type === 'socks4' || type === 'socks5') {
    const proxy = {
      host: node.server,
      port: Number(node.port),
      type: type === 'socks4' ? 4 : 5,
      userId: node.username || '',
      password: node.password || '',
    };
    return async (host, port) => {
      const info = await SocksClient.createConnection({
        proxy,
        command: 'connect',
        destination: { host, port },
        timeout: 10000,
      });
      return info.socket;
    };
  }
  if (type === 'ss') {
    const client = new ShadowsocksClient({
      server: node.server, port: node.port,
      password: node.password || node.uuid || '', method: node.method || 'aes-256-gcm',
    });
    return (host, port) => client.connect(host, port);
  }
  if (type === 'trojan') {
    const client = new TrojanClient({
      server: node.server, port: node.port,
      password: node.password || node.uuid || '', sni: node.sni || '',
      allowInsecure: !!node.allowInsecure,
    });
    return (host, port) => client.connect(host, port);
  }
  if (type === 'vless') {
    // 传输类型兼容两种写法：node.network 显式指定，或 node.ws=true（旧格式）
    const net = (node.network || '').toLowerCase() || (node.ws ? 'ws' : 'tcp');
    const client = new VlessClient({
      server: node.server, port: node.port,
      uuid: node.uuid || node.password || '', sni: node.sni || '',
      network: net, wsPath: node.wsPath || '/',
      allowInsecure: !!node.allowInsecure,
    });
    return (host, port) => client.connect(host, port);
  }
  return null;
}

/** 不支持原因（供提示） */
function unsupportedReason(node) {
  const type = (node.type || '').toLowerCase();
  if (type === 'vmess') return 'vmess 暂不支持自动中转（协议实现繁杂）';
  if (type === 'hysteria2' || type === 'hysteria' || type === 'tuic') return `${type} 基于 QUIC，暂不支持作为抓取中转`;
  if ((node.network || '').toLowerCase() === 'ws' && type === 'trojan') return 'trojan ws 传输暂不支持作为抓取中转';
  return `协议 ${node.type} 暂不支持作为抓取中转`;
}

/**
 * 为节点创建（或复用）本地 HTTP 桥。
 * @param {object} node 节点池节点对象
 * @param {{ttlMs?: number}} opts TTL 毫秒（默认 5 分钟）
 * @returns {Promise<{url: string, close: Function} | null>}
 *   - http/https 节点：直接返回代理 URL，close 为空操作
 *   - 桥复用：同节点在 TTL 内复用本地端口
 *   - 不支持类型：返回 null（调用方应跳过并提示）
 */
const bridgeCache = new Map();

async function startBridge(node, opts = {}) {
  if (!node || !node.server || !node.port) return null;
  const ttlMs = Number(opts.ttlMs) || 5 * 60 * 1000;
  const type = (node.type || '').toLowerCase();
  if (type === 'http' || type === 'https') {
    const auth = node.username && node.password
      ? `${encodeURIComponent(node.username)}:${encodeURIComponent(node.password)}@`
      : '';
    return { url: `${type}://${auth}${node.server}:${node.port}`, close: () => {} };
  }
  const key = `${type}|${node.server}|${node.port}|${node.uuid || ''}|${node.password || ''}|${node.sni || ''}|${node.method || ''}`;
  const makeClose = (server) => () => {
    try { server.close(); } catch (e) { /* ignore */ }
    bridgeCache.delete(key);
  };
  const hit = bridgeCache.get(key);
  if (hit && hit.expireAt > Date.now() && hit.server.listening) {
    return { url: hit.url, close: makeClose(hit.server) };
  }
  if (hit) {
    // 过期：关闭旧桥
    try { hit.server.close(); } catch (e) { /* ignore */ }
    bridgeCache.delete(key);
  }
  const connectFn = buildConnectFn(node);
  if (!connectFn) return null;
  const { url, server } = await createLocalBridge(connectFn);
  bridgeCache.set(key, { url, server, expireAt: Date.now() + ttlMs });
  return { url, close: makeClose(server) };
}

/** 关闭全部桥（测试 / 停机用） */
function closeAllBridges() {
  for (const [key, hit] of bridgeCache) {
    try { hit.server.close(); } catch (e) { /* ignore */ }
    bridgeCache.delete(key);
  }
}

module.exports = {
  isSupportedProxyType,
  unsupportedReason,
  startBridge,
  closeAllBridges,
  buildAddrHead,
  parseAddrHead,
  buildVlessHead,
  ShadowsocksClient,
  TrojanClient,
  VlessClient,
};
