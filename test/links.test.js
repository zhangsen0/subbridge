'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { convertLinks } = require('../src/converters/links');

function node(over = {}) {
  return Object.assign({
    name: '测试节点',
    type: 'vless',
    server: 'example.com',
    port: 443,
    uuid: '00000000-0000-0000-0000-000000000000',
  }, over);
}

test('convertLinks：http/socks5 无 raw 生成标准链接', () => {
  const out = convertLinks([
    node({ type: 'http', server: '1.2.3.4', port: 8080, username: 'u', password: 'p' }),
    node({ type: 'socks5', server: '5.6.7.8', port: 1080 }),
  ]);
  assert.ok(out.includes('http://u:p@1.2.3.4:8080'));
  assert.ok(out.includes('socks5://5.6.7.8:1080'));
});

test('convertLinks：vless 无 raw 生成 vless:// 标准链接', () => {
  const out = convertLinks([node({
    type: 'vless', uuid: 'abc', tls: true, network: 'ws', wsPath: '/path', wsHost: 'h.com', sni: 'h.com',
  })]);
  assert.ok(out.includes('vless://abc@example.com:443'));
  assert.ok(out.includes('encryption=none'));
  assert.ok(out.includes('type=ws'));
  assert.ok(out.includes('path=%2Fpath'));
});

test('convertLinks：trojan 无 raw 生成 trojan:// 标准链接', () => {
  const out = convertLinks([node({ type: 'trojan', password: 'pw', tls: true, sni: 't.com' })]);
  assert.ok(out.includes('trojan://pw@example.com:443'));
  assert.ok(out.includes('sni=t.com'));
});

test('convertLinks：ss 无 raw 生成 ss:// base64 链接', () => {
  const out = convertLinks([node({ type: 'ss', cipher: 'aes-128-gcm', password: 'pw', port: 8388 })]);
  const expected = Buffer.from('aes-128-gcm:pw@example.com:8388').toString('base64');
  assert.ok(out.includes(`ss://${expected}`));
});

test('convertLinks：vmess 无 raw 生成 vmess:// base64 JSON', () => {
  const out = convertLinks([node({ type: 'vmess', uuid: 'id', cipher: 'auto' })]);
  const decoded = Buffer.from(out.split('vmess://')[1], 'base64').toString('utf8');
  const obj = JSON.parse(decoded);
  assert.equal(obj.add, 'example.com');
  assert.equal(obj.id, 'id');
});

test('convertLinks：hysteria2 无 raw 生成 hysteria2:// 链接', () => {
  const out = convertLinks([node({ type: 'hysteria2', password: 'pw', sni: 'h.com', skipCertVerify: true })]);
  assert.ok(out.includes('hysteria2://pw@example.com:443'));
  assert.ok(out.includes('sni=h.com'));
  assert.ok(out.includes('insecure=1'));
});

test('convertLinks：有 raw 优先原样输出，支持混合列表', () => {
  const raw = 'vless://raw@1.1.1.1:443?encryption=none#原始';
  const out = convertLinks([
    node({ raw }),
    node({ type: 'http', server: '9.9.9.9', port: 80 }),
  ]);
  const lines = out.split('\n');
  assert.equal(lines[0], raw);
  assert.ok(lines[1].includes('http://9.9.9.9:80'));
});
