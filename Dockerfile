# ============================================================
# SubBridge Docker 镜像
# 单阶段构建即可（无编译步骤），适合各种 PaaS / VPS / Docker 部署
# ============================================================
FROM node:22-alpine

# 元信息
LABEL org.opencontainers.image.title="subbridge"
LABEL org.opencontainers.image.description="通用订阅转换与节点转发服务"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# 先拷贝依赖清单以利用构建缓存
COPY package.json package-lock.json ./
# 生产模式安装（npm ci 失败时回退 npm install）
RUN npm ci --omit=dev || npm install --omit=dev

# 拷贝源码
COPY . .

# 运行时数据目录（配置覆盖、模板覆盖持久化）
RUN mkdir -p /app/data

# 端口与数据卷
EXPOSE 8080
VOLUME ["/app/data"]

# 健康检查（需要 wget/busybox，alpine 自带 wget）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ping >/dev/null 2>&1 || exit 1

# 启动
CMD ["node", "app.js"]

# 提示：如需启用 CF 隧道，请把 cloudflared 二进制挂载进容器并配置
#   -v /path/to/cloudflared:/usr/local/bin/cloudflared
# 然后在「服务配置 → CF 隧道」中启用（cf_tunnel.enabled=true）。
