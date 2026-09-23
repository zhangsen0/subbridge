'use strict';

/**
 * SubBridge 服务入口
 *
 * 启动流程：加载配置 -> 创建服务器 -> 监听端口 -> 注册优雅退出
 */

const { loadConfig } = require('./src/config/loader');
const { createServer } = require('./src/server/server');

async function main() {
  // 1. 加载配置（默认配置 + data/config.yaml + 环境变量）
  const config = await loadConfig();

  // 2. 创建 Fastify 实例
  const app = createServer(config);
  const port = config.server.port;
  const host = config.server.host;

  // 3. 监听端口
  await app.listen({ host, port });
  app.log.info(`SubBridge 已启动: http://${host}:${port}`);

  // 4. 优雅退出（Docker / PaaS 平台发送 SIGTERM 时平滑关闭）
  //    后台抓取/测速任务不再阻塞请求，close 只等 in-flight 请求；
  //    加 10s 超时兜底，防止个别长任务拖住收尾导致 systemd 卡在 stopping。
  const shutdown = async (signal) => {
    app.log.info(`收到信号 ${signal}，正在关闭服务...`);
    try {
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 10000))]);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('SubBridge 启动失败:', err);
  process.exit(1);
});
