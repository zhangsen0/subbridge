'use strict';

/**
 * 协议桥（ProxyBridge）单元测试
 * 覆盖：地址头编解码、类型判断、不支持类型提示、socks5 桥真实转发、
 *       本地 HTTP 桥（CONNECT + 普通请求）经 undici ProxyAgent 抓取。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const { ProxyAgent } = require('undici');

const {
  buildAddrHead,
  parseAddrHead,
  isSupportedProxyType,
  unsupportedReason,
  startBridge,
  closeAllBridges,
  ShadowsocksClient,
  VlessClient,
  buildVlessHead,
} = require('../src/core/proxyBridge');

test('buildAddrHead / parseAddrHead 域名与 IPv4 编解码', () => {
  const head = buildAddrHead('example.com', 443);
  const parsed = parseAddrHead(head);
  assert.strictEqual(parsed.host, 'example.com');
  assert.strictEqual(parsed.port, 443);

  const head4 = buildAddrHead('1.2.3.4', 8080);
  const parsed4 = parseAddrHead(head4);
  assert.strictEqual(parsed4.host, '1.2.3.4');
  assert.strictEqual(parsed4.port, 8080);
});

test('isSupportedProxyType 与 unsupportedReason', () => {
  assert.ok(isSupportedProxyType('http'));
  assert.ok(isSupportedProxyType('socks5'));
  assert.ok(isSupportedProxyType('ss'));
  assert.ok(isSupportedProxyType('trojan'));
  assert.ok(isSupportedProxyType('vless'));
  assert.ok(!isSupportedProxyType('vmess'));
  assert.ok(!isSupportedProxyType('hysteria2'));
  assert.ok(!isSupportedProxyType('tuic'));
  assert.ok(unsupportedReason({ type: 'vmess' }).includes('vmess'));
  assert.ok(unsupportedReason({ type: 'hysteria2' }).includes('QUIC'));
  // vless + ws 传输已支持（CF 中转节点常用），不再拒绝
  assert.ok(unsupportedReason({ type: 'vless', network: 'ws' }).includes('协议 vless 暂不支持'));
  assert.ok(unsupportedReason({ type: 'trojan', network: 'ws' }).includes('trojan ws'));
});

test('ShadowsocksClient 参数校验（方法解析）', () => {
  const c1 = new ShadowsocksClient({ server: 'x.com', port: 443, password: 'p', method: 'aes-256-gcm' });
  assert.strictEqual(c1.isAead, true);
  assert.strictEqual(c1.keyLen, 32);
  const c2 = new ShadowsocksClient({ server: 'x.com', port: 443, password: 'p', method: 'aes-128-cfb' });
  assert.strictEqual(c2.isAead, false);
  assert.strictEqual(c2.keyLen, 16);
  const c3 = new ShadowsocksClient({ server: 'x.com', port: 443, password: 'p' });
  assert.strictEqual(c3.isAead, true);
});

/** 本地起一个最小的 SOCKS5 服务器：把 CONNECT 转发到目标 */
function startSocks5Server() {
  return new Promise((resolve) => {
    const server = net.createServer((client) => {
      let stage = 0;
      let target = null;
      client.on('data', (d) => {
        if (stage === 0) {
          // 方法协商：版本 + nmethods
          client.write(Buffer.from([0x05, 0x00]));
          stage = 1;
          return;
        }
        if (stage === 1) {
          // CONNECT 请求：VER CMD RSV ATYP ADDR PORT
          const atyp = d[3];
          let host;
          let portOff;
          if (atyp === 0x01) {
            host = `${d[4]}.${d[5]}.${d[6]}.${d[7]}`;
            portOff = 8;
          } else if (atyp === 0x03) {
            const len = d[4];
            host = d.subarray(5, 5 + len).toString('utf8');
            portOff = 5 + len;
          } else {
            client.destroy();
            return;
          }
          const port = d.readUInt16BE(portOff);
          target = net.connect({ host, port }, () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            // 仅用 pipe 双向转发（避免与 data 事件重复写）
            client.pipe(target).pipe(client);
          });
          target.on('error', () => client.destroy());
          stage = 2;
          return;
        }
        // 已建立（数据由 pipe 转发，无需在此处理）
      });
      client.on('error', () => { if (target) target.destroy(); });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('socks5 节点经协议桥转成本地 http 上游，可成功抓取目标内容', async (t) => {
  // 本地目标服务器
  const target = http.createServer((req, res) => {
    res.end('bridge-ok:' + req.url);
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const targetPort = target.address().port;

  // 本地 socks5 服务器
  const socks = await startSocks5Server();
  const socksPort = socks.address().port;

  const node = { type: 'socks5', server: '127.0.0.1', port: socksPort, enabled: true };

  try {
    const bridge = await startBridge(node, { ttlMs: 60000 });
    assert.ok(bridge && bridge.url, '桥应创建成功');
    assert.ok(bridge.url.startsWith('http://127.0.0.1:'), '桥 URL 应为本地 http 代理');

    // 用 undici ProxyAgent 走桥抓取
    const agent = new ProxyAgent(bridge.url);
    const res = await fetch(`http://127.0.0.1:${targetPort}/hello`, { dispatcher: agent });
    const text = await res.text();
    const statusCode = res.status;
    assert.strictEqual(statusCode, 200);
    assert.strictEqual(text, 'bridge-ok:/hello');
    agent.close();

    // 复用：第二次 startBridge 应返回同一 URL（TTL 内缓存）
    const bridge2 = await startBridge(node, { ttlMs: 60000 });
    assert.strictEqual(bridge2.url, bridge.url);
  } finally {
    target.close();
    socks.close();
  }
});

test('本地桥 CONNECT 隧道可用（https 目标走 CONNECT）', async (t) => {
  // 用一个 http 服务器模拟（CONNECT 隧道直接转发字节）
  const echo = net.createServer((sock) => {
    // 只回显一次（自环会无限回显）
    sock.once('data', (d) => sock.write(d));
  });
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const socks = await startSocks5Server();
  const socksPort = socks.address().port;
  const node = { type: 'socks5', server: '127.0.0.1', port: socksPort, enabled: true };

  try {
    const bridge = await startBridge(node, { ttlMs: 60000 });
    // 手工 CONNECT 到 echo 端口，验证隧道建立 + 回显
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: Number(new URL(bridge.url).port),
        method: 'CONNECT',
        path: `127.0.0.1:${echo.address().port}`,
      });
      req.on('connect', (res, socket) => {
        if (res.statusCode === 200) {
          socket.write('ping');
          let buf = '';
          socket.on('data', (d) => { buf += d.toString(); });
          setTimeout(() => { socket.destroy(); resolve(buf); }, 300);
        } else {
          resolve('status:' + res.statusCode);
        }
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(result, 'ping');
  } finally {
    echo.close();
    socks.close();
  }
});

test('不支持的协议 startBridge 返回 null', async () => {
  const bridge = await startBridge({ type: 'vmess', server: 'x.com', port: 443 });
  assert.strictEqual(bridge, null);
});

test('closeAllBridges 幂等可调用', () => {
  closeAllBridges();
  closeAllBridges();
  assert.ok(true);
});

test('buildVlessHead 头结构（版本+uuid+命令+ATYP+地址+端口）', () => {
  const head = buildVlessHead('90cd4a77-141a-43c9-991b-08263cfe9c10', '162.159.198.1', 8443);
  assert.strictEqual(head[0], 0x00);       // 版本 0
  assert.strictEqual(head.length, 1 + 16 + 1 + 1 + 2 + 1 + 4); // 版本+uuid+附加+命令+端口+ATYP+IPv4
  assert.strictEqual(head.toString('hex', 1, 17), '90cd4a77141a43c9991b08263cfe9c10'); // uuid
  assert.strictEqual(head[18], 0x01);      // 命令 TCP
  assert.ok(head.readUInt16BE(19) === 8443); // 端口
  assert.strictEqual(head[21], 0x01);      // ATYP IPv4
});

test('VlessClient ws 传输参数解析（network/wsPath）', () => {
  const c = new VlessClient({ server: '162.159.198.1', port: 8443, uuid: 'x', network: 'ws', wsPath: '/' });
  assert.strictEqual(c.network, 'ws');
  assert.strictEqual(c.wsPath, '/');
  const c2 = new VlessClient({ server: 's', port: 443, uuid: 'x' });
  assert.strictEqual(c2.network, 'tcp');
});
