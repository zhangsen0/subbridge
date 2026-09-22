'use strict';

/**
 * 抓取代理回退链测试：
 *   优先级「先本机直连 → 直连失败回退节点池代理」。
 *   - 直连成功时不使用池代理
 *   - 直连失败时回退到池代理并成功（Fetcher 内部候选链）
 *   - 显式配置 upstream_proxy 时不叠加回退链
 *   - effectiveFetcherConfig 决策：池有代理→设 fallback_proxy；池空+禁直连→blocked；
 *     默认池空→允许直连（不阻塞）
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { Fetcher } = require('../src/core/fetcher');
const { effectiveFetcherConfig } = require('../src/server/convert');

const SUB_TEXT = 'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQxQGpwMS50ZXN0LmV4YW1wbGUuY29tOjgzODgjTm9kZTE=';

/** 订阅目标服务：返回订阅文本 */
function startTarget() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(SUB_TEXT);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** 最小 HTTP 正向代理：CONNECT 隧道固定转发到 targetPort（undici ProxyAgent 走 CONNECT） */
function startHttpProxy(targetPort) {
  return new Promise((resolve) => {
    const net = require('node:net');
    const server = http.createServer((req, res) => {
      res.writeHead(400);
      res.end('需要 CONNECT');
    });
    server.on('connect', (req, socket) => {
      // 固定转发到 targetPort（模拟"经池代理访问外部源"）
      const upstream = net.connect(targetPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => { socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); socket.end(); });
      socket.on('error', () => { upstream.destroy(); });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('抓取回退链：直连失败后回退池代理成功', async () => {
  const target = await startTarget();
  const proxy = await startHttpProxy(target.port);
  const fetcher = new Fetcher({
    fetcher: {
      block_private: false,
      upstream_proxy: '',
      fallback_proxy: `http://127.0.0.1:${proxy.port}`,
      retries: 0,
      timeout_seconds: 3,
    },
  });
  // 目标端口无人监听（127.0.0.1:1）：直连必然失败 → 回退池代理（固定转发到 target）成功
  const meta = await fetcher.fetchMeta('http://127.0.0.1:65530/sub.txt');
  assert.ok(meta.text.includes('ss://'), '回退后应抓到订阅文本');
  assert.ok(meta.proxyUsed.includes(String(proxy.port)), '应记录使用的回退代理');
  target.server.close();
  proxy.server.close();
});

test('抓取回退链：直连成功时不使用池代理', async () => {
  const target = await startTarget();
  const proxy = await startHttpProxy(target.port);
  const fetcher = new Fetcher({
    fetcher: {
      block_private: false,
      upstream_proxy: '',
      fallback_proxy: `http://127.0.0.1:${proxy.port}`,
      retries: 0,
      timeout_seconds: 3,
    },
  });
  // 目标本机可达：直连成功，不应回退到池代理
  const meta = await fetcher.fetchMeta(`http://127.0.0.1:${target.port}/sub.txt`);
  assert.ok(meta.text.includes('ss://'), '直连应成功');
  assert.strictEqual(meta.proxyUsed, '', '直连成功时不应使用回退代理');
  target.server.close();
  proxy.server.close();
});

test('抓取回退链：显式 upstream_proxy 时不叠加回退链', async () => {
  const fetcher = new Fetcher({
    fetcher: {
      block_private: false,
      upstream_proxy: 'http://user:pass@127.0.0.1:8080',
      fallback_proxy: 'http://127.0.0.1:8081',
      retries: 0,
      timeout_seconds: 2,
    },
  });
  assert.ok(fetcher.agent, '主候选代理应创建');
  assert.ok(!fetcher.fallbackAgent, '显式代理时不应创建回退代理');
});

test('抓取回退链：生效配置决策（池代理 / 池空禁直连 / 默认直连）', async () => {
  // 池中有 http 代理节点 → fallback_proxy 应设置为池代理，主候选为直连
  const nodePool = {
    async list() {
      return [
        {
          type: 'http', server: '192.0.2.1', port: 3128, enabled: true,
          username: 'u', password: 'p',
          probe: { alive: true, latencyMs: 50 },
        },
      ];
    },
  };
  const cfg1 = await effectiveFetcherConfig({ fetcher: { proxy_from_pool: true } }, { nodePool });
  assert.strictEqual(cfg1.upstream_proxy, undefined, '主候选应为直连（不设 upstream_proxy）');
  assert.ok(cfg1.fallback_proxy && cfg1.fallback_proxy.includes('3128'), '回退代理应来自节点池');
  assert.ok(!cfg1.pool_empty_blocked, '池有代理不应阻塞');

  // 池空 + 禁止直连 → blocked
  const cfg2 = await effectiveFetcherConfig(
    { fetcher: { proxy_from_pool: true, pool_empty_fallback_direct: false } },
    { nodePool: { async list() { return []; } } },
  );
  assert.strictEqual(cfg2.pool_empty_blocked, true, '池空且禁直连应标记阻塞');

  // 池空 + 默认 → 允许直连（不阻塞）
  const cfg3 = await effectiveFetcherConfig(
    { fetcher: { proxy_from_pool: true } },
    { nodePool: { async list() { return []; } } },
  );
  assert.ok(!cfg3.pool_empty_blocked, '默认池空应允许直连回退');
});
