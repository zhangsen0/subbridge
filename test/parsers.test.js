'use strict';

/**
 * 解析器单元测试
 * 覆盖：ss/ssr/vmess/vless/trojan/hysteria/hysteria2/tuic 分享链接、
 *       Clash YAML、V2RayN JSON、订阅格式自动探测。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const share = require('../src/parsers/share');
const clashParser = require('../src/parsers/clash');
const v2rayParser = require('../src/parsers/v2ray');
const { parseSubscription } = require('../src/parsers');
const { encodeBase64UrlSafe, decodeBase64 } = require('../src/core/util');

// 测试辅助：构建 base64（标准编码）
function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

test('decodeBase64 兼容 URL-safe 与无 padding', () => {
  assert.equal(decodeBase64('YWVzLTI1Ni1nY206cGFzc3dvcmQ'), 'aes-256-gcm:password');
  assert.equal(decodeBase64('YWVzLTI1Ni1nY206cGFzc3dvcmQ='), 'aes-256-gcm:password');
  // URL-safe 变体
  const urlSafe = b64('aes-128-gcm:pw/ab+').replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(decodeBase64(urlSafe), 'aes-128-gcm:pw/ab+');
  assert.equal(decodeBase64('!!!invalid'), null);
});

test('ss 传统格式解析', () => {
  const link = `ss://${b64('aes-256-gcm:password@example.com:8388')}#%E6%B5%8B%E8%AF%95%E8%8A%82%E7%82%B9`;
  const node = share.parseShareLink(link);
  assert.ok(node, '应解析成功');
  assert.equal(node.type, 'ss');
  assert.equal(node.server, 'example.com');
  assert.equal(node.port, 8388);
  assert.equal(node.cipher, 'aes-256-gcm');
  assert.equal(node.password, 'password');
  assert.equal(node.name, '测试节点');
});

test('ss SIP002 格式解析', () => {
  const link = `ss://${b64('aes-256-gcm:password')}@example.com:8388?plugin=obfs-local%3Bobfs%3Dhttp#sip002`;
  const node = share.parseShareLink(link);
  assert.ok(node);
  assert.equal(node.type, 'ss');
  assert.equal(node.server, 'example.com');
  assert.equal(node.port, 8388);
  assert.equal(node.password, 'password');
  assert.ok(node.extras.plugin.includes('obfs'));
});

test('ssr 解析', () => {
  const payload =
    'example.com:8388:origin:aes-256-cfb:plain:YWJjZGVm' +
    '?remarks=' + encodeBase64UrlSafe('测试节点') +
    '&group=' + encodeBase64UrlSafe('测试组');
  const link = 'ssr://' + encodeBase64UrlSafe(payload);
  const node = share.parseShareLink(link);
  assert.ok(node, '应解析成功');
  assert.equal(node.type, 'ssr');
  assert.equal(node.server, 'example.com');
  assert.equal(node.port, 8388);
  assert.equal(node.protocol, 'origin');
  assert.equal(node.cipher, 'aes-256-cfb');
  assert.equal(node.name, '测试节点');
  assert.equal(node.group, '测试组');
});

test('vmess 解析', () => {
  const obj = {
    v: '2', ps: 'HK-01', add: '1.2.3.4', port: '443',
    id: '11111111-2222-3333-4444-555555555555', aid: '0',
    net: 'ws', type: 'none', host: 'cdn.example.com', path: '/ws',
    tls: 'tls', sni: 'cdn.example.com', fp: 'chrome',
  };
  const link = 'vmess://' + b64(JSON.stringify(obj));
  const node = share.parseShareLink(link);
  assert.ok(node, '应解析成功');
  assert.equal(node.type, 'vmess');
  assert.equal(node.server, '1.2.3.4');
  assert.equal(node.port, 443);
  assert.equal(node.uuid, obj.id);
  assert.equal(node.network, 'ws');
  assert.equal(node.tls, true);
  assert.equal(node.sni, 'cdn.example.com');
  assert.equal(node.wsPath, '/ws');
  assert.equal(node.wsHost, 'cdn.example.com');
});

test('vless 解析（含 reality）', () => {
  const link = 'vless://11111111-2222-3333-4444-555555555555@example.com:443?encryption=none&security=reality&sni=www.example.com&fp=chrome&type=ws&path=%2Fws&host=www.example.com&pbk=abc&sid=123&spx=%2F#VLESS';
  const node = share.parseShareLink(link);
  assert.ok(node, '应解析成功');
  assert.equal(node.type, 'vless');
  assert.equal(node.server, 'example.com');
  assert.equal(node.port, 443);
  assert.equal(node.uuid, '11111111-2222-3333-4444-555555555555');
  assert.equal(node.tls, true);
  assert.equal(node.sni, 'www.example.com');
  assert.equal(node.network, 'ws');
  assert.equal(node.extras.reality.publicKey, 'abc');
  assert.equal(node.extras.reality.shortId, '123');
});

test('trojan 解析', () => {
  const link = 'trojan://mypassword@example.com:443?sni=example.com&allowInsecure=1#Trojan';
  const node = share.parseShareLink(link);
  assert.ok(node);
  assert.equal(node.type, 'trojan');
  assert.equal(node.password, 'mypassword');
  assert.equal(node.sni, 'example.com');
  assert.equal(node.skipCertVerify, true);
});

test('hysteria2 解析', () => {
  const link = 'hysteria2://pass@example.com:443?sni=example.com&insecure=1&obfs=salamander&obfs-password=xyz#HY2';
  const node = share.parseShareLink(link);
  assert.ok(node);
  assert.equal(node.type, 'hysteria2');
  assert.equal(node.password, 'pass');
  assert.equal(node.sni, 'example.com');
  assert.equal(node.obfs, 'salamander');
  assert.equal(node.obfsPassword, 'xyz');
  assert.equal(node.skipCertVerify, true);
});

test('tuic 解析', () => {
  const link = 'tuic://11111111-2222-3333-4444-555555555555:pass@example.com:443?sni=example.com&alpn=h3&congestion_control=bbr#TUIC';
  const node = share.parseShareLink(link);
  assert.ok(node);
  assert.equal(node.type, 'tuic');
  assert.equal(node.uuid, '11111111-2222-3333-4444-555555555555');
  assert.equal(node.password, 'pass');
  assert.equal(node.alpn, 'h3');
  assert.equal(node.congestionControl, 'bbr');
});

test('hysteria v1 解析', () => {
  const link = 'hysteria://authkey@example.com:443?up=20&down=100&sni=example.com&insecure=1#Hysteria';
  const node = share.parseShareLink(link);
  assert.ok(node);
  assert.equal(node.type, 'hysteria');
  assert.equal(node.auth, 'authkey');
  assert.equal(node.up, '20');
  assert.equal(node.down, '100');
  assert.equal(node.sni, 'example.com');
});

test('Clash YAML 订阅解析', () => {
  const yaml = `
proxies:
  - name: ss-node
    type: ss
    server: example.com
    port: 8388
    cipher: aes-256-gcm
    password: secret
  - name: vmess-node
    type: vmess
    server: 1.2.3.4
    port: 443
    uuid: 11111111-2222-3333-4444-555555555555
    alterId: 0
    cipher: auto
    tls: true
    servername: cdn.example.com
    network: ws
    ws-opts:
      path: /ws
      headers:
        Host: cdn.example.com
`;
  const nodes = clashParser.parse(yaml);
  assert.ok(nodes && nodes.length === 2);
  assert.equal(nodes[0].type, 'ss');
  assert.equal(nodes[0].server, 'example.com');
  assert.equal(nodes[1].type, 'vmess');
  assert.equal(nodes[1].tls, true);
  assert.equal(nodes[1].wsPath, '/ws');
});

test('V2RayN JSON 订阅解析', () => {
  const arr = [
    { v: '2', ps: 'json-node', add: '5.6.7.8', port: 443, id: '11111111-2222-3333-4444-555555555555', aid: 0, net: 'tcp', tls: '' },
  ];
  const nodes = v2rayParser.parse(JSON.stringify(arr));
  assert.ok(nodes && nodes.length === 1);
  assert.equal(nodes[0].name, 'json-node');
  assert.equal(nodes[0].server, '5.6.7.8');
});

test('订阅格式自动探测：明文链接', () => {
  const content = [
    `ss://${b64('aes-256-gcm:password@example.com:8388')}#node1`,
    'vless://11111111-2222-3333-4444-555555555555@example.org:443?security=tls#node2',
    '这不是一条链接',
  ].join('\n');
  const { nodes, format } = parseSubscription(content);
  assert.equal(format, 'links');
  assert.equal(nodes.length, 2);
});

test('订阅格式自动探测：base64 订阅', () => {
  const links = [
    `ss://${b64('aes-256-gcm:password@example.com:8388')}#node1`,
    'trojan://pass@example.net:443#node2',
  ].join('\n');
  const { nodes, format } = parseSubscription(encodeBase64UrlSafe(links));
  assert.equal(format, 'base64-links');
  assert.equal(nodes.length, 2);
  assert.ok(nodes.some((n) => n.type === 'trojan'));
});

test('订阅格式自动探测：Clash YAML', () => {
  const content = 'proxies:\n  - name: a\n    type: ss\n    server: 1.2.3.4\n    port: 8388\n    cipher: aes-256-gcm\n    password: x\n';
  const { nodes, format } = parseSubscription(content);
  assert.equal(format, 'clash');
  assert.equal(nodes.length, 1);
});

test('未知内容返回空节点', () => {
  const { nodes, format } = parseSubscription('hello world');
  assert.equal(nodes.length, 0);
  assert.equal(format, 'unknown');
});
