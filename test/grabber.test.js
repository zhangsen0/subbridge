'use strict';

/**
 * 抓取中心单元测试
 * 覆盖：文本自动识别（行式链接 / base64 / 文本来源标注）、
 *      网页递归发现订阅链接、站点适配器（vpngate）解析、来源标注。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchSource, isHtml, extractLinks, looksLikeSubLink } = require('../src/core/grabber');
const vpngate = require('../src/grabbers/vpngate');

/** 构造一个简单的模拟抓取器 */
function mockFetcher(routes) {
  return {
    async fetchMeta(url) {
      const hit = routes[url];
      if (!hit) throw new Error(`404 Not Found: ${url}`);
      return typeof hit === 'string' ? { text: hit, status: 200, bytes: hit.length, contentType: '' } : hit;
    },
  };
}

test('文本自动识别：行式分享链接并标注来源', async () => {
  const text = 'ss://YWVzLTI1Ni1nY206cGFzczFAZXhhbXBsZS5jb206ODM4OA==#示例';
  const { nodes, kind } = await fetchSource(text, { fetcher: mockFetcher({}), config: {} });
  assert.equal(kind, 'text');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].source, '文本输入');
});

test('文本自动识别：整体 base64 订阅', async () => {
  const inner = 'ss://YWVzLTI1Ni1nY206cGFzczFAZXhhbXBsZS5jb206ODM4OA==#示例';
  const { nodes } = await fetchSource(Buffer.from(inner).toString('base64'), { fetcher: mockFetcher({}), config: {} });
  assert.ok(nodes.length >= 1, 'base64 解码后应解析出节点');
});

test('订阅链接：解析并标注来源域名', async () => {
  const subUrl = 'https://sub.example.com/api/v1/client/subscribe?token=x';
  const content = 'ss://YWVzLTI1Ni1nY206cGFzczFAZXhhbXBsZS5jb206ODM4OA==#示例';
  const { nodes, kind } = await fetchSource(subUrl, {
    fetcher: mockFetcher({ [subUrl]: content }),
    config: {},
  });
  assert.equal(kind, 'subscription');
  assert.equal(nodes[0].source, subUrl);
});

test('网页抓取：递归发现订阅链接并合并节点', async () => {
  const pageUrl = 'https://site.example.com/links';
  const subUrl = 'https://site.example.com/sub?token=abc';
  const page = `<html><body><a href="${subUrl}">订阅</a></body></html>`;
  const subContent = 'ss://YWVzLTI1Ni1nY206cGFzczFAZXhhbXBsZS5jb206ODM4OA==#来自子订阅';
  const fetcher = mockFetcher({ [pageUrl]: page, [subUrl]: subContent });

  const { nodes, kind } = await fetchSource(pageUrl, { fetcher, config: { grab: { max_depth: 2, max_links: 5, link_keywords: ['sub', 'subscribe'] } } });
  assert.equal(kind, 'web');
  assert.ok(nodes.length >= 1, '网页递归应解析出子订阅节点');
  // 子订阅节点应标注真实来源（子订阅地址）
  assert.ok(nodes.some((n) => n.source === subUrl), '子订阅节点来源应为子订阅地址');
});

test('网页抓取：深度限制生效', async () => {
  const a = 'https://a.example.com/';
  const b = 'https://b.example.com/sub';
  const fetcher = mockFetcher({
    [a]: `<html><a href="${b}">x</a></html>`,
    [b]: `<html><a href="${a}">y</a></html>`,
  });
  // 深度 1：只解析 a，发现 b 但不再深入
  const history = [];
  await fetchSource(a, { fetcher, config: { grab: { max_depth: 1, max_links: 5, link_keywords: ['sub'] } }, history });
  const fetched = history.filter((h) => h.url).map((h) => h.url);
  assert.ok(fetched.includes(a) && fetched.includes(b), `深度 1 应抓 a 与 b：${fetched.join(',')}`);
  assert.equal(fetched.length, 2, '深度 1 不应再深入 a 的二次抓取');
});

test('isHtml / extractLinks / looksLikeSubLink 基础判断', () => {
  assert.ok(isHtml('<html><body>x</body></html>'));
  assert.ok(!isHtml('ss://abc#x'));
  const links = extractLinks('访问 https://a.com/sub?t=1 或 https://b.com/x。');
  assert.deepEqual(links, ['https://a.com/sub?t=1', 'https://b.com/x']);
  assert.ok(looksLikeSubLink('https://x.com/api/v1/client/subscribe', ['sub', 'subscribe']));
  assert.ok(!looksLikeSubLink('https://x.com/page', ['sub']));
});

test('vpngate 适配器：matches / normalizeUrl / parse', () => {
  assert.ok(vpngate.matches('www.vpngate.net'));
  assert.ok(vpngate.matches('vpngate.net'));
  assert.ok(!vpngate.matches('example.com'));
  assert.equal(vpngate.normalizeUrl('https://www.vpngate.net/cn/'), 'https://www.vpngate.net/api/iphone/');

  const sample = [
    '*VPN Gate Client Experiment',
    'host1.softether.net,1.2.3.4,123,45,987654,Japan,JP,0,123456,7,1234567,1,Operator,Message,U09NRV9CQVNFNjQ=',
  ].join('\n');
  const { nodes, format } = vpngate.parse(sample);
  assert.equal(format, 'vpngate');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, 'openvpn');
  assert.equal(nodes[0].server, '1.2.3.4');
  assert.equal(nodes[0].port, 1194);
  assert.equal(nodes[0].configBase64, 'U09NRV9CQVNFNjQ=');
});

test('站点适配器：vpngate 页面地址自动归一化并解析', async () => {
  const pageUrl = 'https://www.vpngate.net/cn/';
  const apiUrl = 'https://www.vpngate.net/api/iphone/';
  const apiContent = [
    '*VPN Gate Client Experiment',
    'host2.softether.net,5.6.7.8,88,30,500000,Japan,JP,0,999,7,888,1,Op,Msg,QkFTRTY0X0NPTkZJRw==',
  ].join('\n');
  const fetcher = mockFetcher({ [apiUrl]: apiContent });

  const { nodes, kind } = await fetchSource(pageUrl, { fetcher, config: {} });
  assert.equal(kind, 'site');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].server, '5.6.7.8');
  assert.equal(nodes[0].source, pageUrl);
});
