#!/usr/bin/env bash
# =============================================================
# SubBridge 一键部署脚本
# 支持平台：Linux (x86_64 / arm64 / armv7) · macOS (Intel / Apple Silicon)
# 支持模式：① 本机直跑（自动装 Node、依赖、可选 systemd 服务）
#           ② Docker Compose（--docker）
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/zhangsen0/subbridge/main/install.sh | bash
#   bash install.sh [--port 8080] [--token <令牌>] [--admin <用户名>] [--password <密码>] [--docker] [--no-service]
# 参数全配置化；未传参数时自动生成安全随机值。中文注释，符合项目规范。
# =============================================================
set -euo pipefail

# ---------- 参数解析（全部可配置，不写死） ----------
PORT="${PORT:-8080}"
HOST="${HOST:-0.0.0.0}"
TOKEN="${SUBBRIDGE_API_TOKEN:-}"
ADMIN_USER="${SUBBRIDGE_ADMIN_USERNAME:-admin}"
ADMIN_PASS="${SUBBRIDGE_ADMIN_PASSWORD:-}"
USE_DOCKER=0
USE_SERVICE=1
INSTALL_DIR="${SUBBRIDGE_DIR:-$(pwd)}"

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --admin) ADMIN_USER="$2"; shift 2 ;;
    --password) ADMIN_PASS="$2"; shift 2 ;;
    --docker) USE_DOCKER=1; shift ;;
    --no-service) USE_SERVICE=0; shift ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1"; usage; exit 1 ;;
  esac
done

# ---------- 工具函数 ----------
log()  { echo -e "\033[1;32m[SubBridge]\033[0m $*"; }
warn() { echo -e "\033[1;33m[警告]\033[0m $*"; }
fail() { echo -e "\033[1;31m[错误]\033[0m $*" >&2; exit 1; }

gen_token() {
  # 生成 UUID 作为默认令牌（macOS 无 /proc/sys/kernel/random/uuid 时用 node/python 兜底）
  if [[ -f /proc/sys/kernel/random/uuid ]]; then
    cat /proc/sys/kernel/random/uuid
  elif command -v uuidgen >/dev/null 2>&1; then
    uuidgen
  elif command -v node >/dev/null 2>&1; then
    node -e "console.log(require('crypto').randomUUID())"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import uuid; print(uuid.uuid4())"
  else
    echo "subbridge-$(date +%s)-$RANDOM"
  fi
}

detect_arch() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    armv7l|armv6l) echo "armv7" ;;
    *) echo "unknown" ;;
  esac
}

# ---------- Docker 模式（优先、最省心） ----------
if [[ "$USE_DOCKER" == "1" ]]; then
  command -v docker >/dev/null 2>&1 || fail "未检测到 Docker，请先安装 Docker 或改用本机直跑模式。"
  TOKEN="${TOKEN:-$(gen_token)}"
  ADMIN_PASS="${ADMIN_PASS:-$(gen_token | tr -d '-' | head -c 12)}"
  log "Docker 一键启动（端口 ${PORT}）..."
  docker run -d --name subbridge --restart unless-stopped \
    -p "${PORT}:8080" \
    -e PORT=8080 \
    -e SUBBRIDGE_API_TOKEN="${TOKEN}" \
    -e SUBBRIDGE_ADMIN_USERNAME="${ADMIN_USER}" \
    -e SUBBRIDGE_ADMIN_PASSWORD="${ADMIN_PASS}" \
    -v subbridge-data:/data \
    ghcr.io/zhangsen0/subbridge:latest 2>/dev/null \
    || docker run -d --name subbridge --restart unless-stopped \
      -p "${PORT}:8080" \
      -e PORT=8080 \
      -e SUBBRIDGE_API_TOKEN="${TOKEN}" \
      -e SUBBRIDGE_ADMIN_USERNAME="${ADMIN_USER}" \
      -e SUBBRIDGE_ADMIN_PASSWORD="${ADMIN_PASS}" \
      -v subbridge-data:/data \
      zhangsen0/subbridge:latest
  log "Docker 启动完成！"
  echo
  echo "  管理后台 : http://127.0.0.1:${PORT}"
  echo "  登录账号 : ${ADMIN_USER}"
  echo "  登录密码 : ${ADMIN_PASS}"
  echo "  访问令牌 : ${TOKEN}"
  exit 0
fi

# ---------- 本机直跑模式 ----------
cd "$INSTALL_DIR"
if [[ ! -f package.json ]]; then
  log "未找到 package.json，正在克隆项目..."
  command -v git >/dev/null 2>&1 || fail "需要 git，请先安装（如 apt install git / yum install git）。"
  git clone --depth 1 https://github.com/zhangsen0/subbridge.git . \
    || git clone --depth 1 https://ghproxy.com/https://github.com/zhangsen0/subbridge.git .
fi

# 检测 / 安装 Node.js（>=16；自动下载 Node18 LTS 到本地 runtime，不污染系统）
NODE_BIN="${NODE_BIN:-}"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  if [[ "$NODE_MAJOR" -lt 16 ]]; then
    warn "系统 Node 版本过低（$(node -v)），将安装独立 Node18。"
    NODE_BIN=""
  else
    NODE_BIN="$(command -v node)"
  fi
fi

if [[ -z "$NODE_BIN" ]]; then
  local_arch="$(detect_arch)"
  [[ "$local_arch" == "unknown" ]] && fail "无法识别架构：$(uname -m)"
  case "$(uname -s)" in
    Linux)  os="linux" ;;
    Darwin) os="darwin" ;;
    *) fail "不支持的系统：$(uname -s)" ;;
  esac
  if [[ "$os" == "darwin" ]]; then local_arch="x64"; [[ "$(uname -m)" == "arm64" ]] && local_arch="arm64"; fi
  if [[ ! -x ./runtime/bin/node ]]; then
    log "下载 Node 18 LTS（${os}-${local_arch}）..."
    mkdir -p runtime && cd runtime
    curl -fsSL "https://nodejs.org/dist/v18.20.4/node-v18.20.4-${os}-${local_arch}.tar.gz" -o node.tgz
    tar xzf node.tgz --strip-components=1
    rm -f node.tgz
    cd ..
  fi
  NODE_BIN="$(pwd)/runtime/bin/node"
  export PATH="$(pwd)/runtime/bin:$PATH"
fi
log "使用 Node：$($NODE_BIN -v)"

# 安装依赖（Node<18 时固定 undici 5.28.4 以兼容）
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
log "安装依赖（npm install --omit=dev）..."
npm install --omit=dev --no-audit --no-fund
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  log "Node <18，固定 undici@5.28.4 ..."
  npm install undici@5.28.4 --save-exact --omit=dev --no-audit --no-fund
fi

# 生成 .env（参数全配置化；已存在则保留用户配置）
TOKEN="${TOKEN:-$(gen_token)}"
ADMIN_PASS="${ADMIN_PASS:-$(gen_token | tr -d '-' | head -c 12)}"
if [[ ! -f .env ]]; then
  cat > .env <<EOF
PORT=${PORT}
HOST=${HOST}
SUBBRIDGE_API_TOKEN=${TOKEN}
SUBBRIDGE_ADMIN_USERNAME=${ADMIN_USER}
SUBBRIDGE_ADMIN_PASSWORD=${ADMIN_PASS}
SUBBRIDGE_DATA_DIR=$(pwd)/data
EOF
  log "已生成 .env（数据目录：$(pwd)/data）"
else
  warn ".env 已存在，保留原配置（未覆盖）。如需重置请删除 .env 后重跑。"
fi

# systemd 服务（Linux + systemd 时默认启用；--no-service 跳过）
start_cmd="${NODE_BIN} app.js"
if [[ "$USE_SERVICE" == "1" ]] && command -v systemctl >/dev/null 2>&1; then
  log "安装 systemd 服务（subbridge）..."
  cat > /etc/systemd/system/subbridge.service <<EOF
[Unit]
Description=SubBridge 抓取中心服务
After=network.target

[Service]
Type=simple
WorkingDirectory=$(pwd)
EnvironmentFile=$(pwd)/.env
ExecStart=${start_cmd}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable subbridge >/dev/null 2>&1 || true
  systemctl restart subbridge
  sleep 2
  systemctl is-active subbridge >/dev/null 2>&1 \
    && log "systemd 服务已启动" \
    || warn "systemd 服务启动失败，请查看 journalctl -u subbridge"
else
  log "后台启动服务（nohup）..."
  nohup env "$(cat .env | xargs)" "${NODE_BIN}" app.js > app.log 2>&1 &
  disown || true
  sleep 2
fi

# 输出访问信息
PING="$(curl -s -m 5 "http://127.0.0.1:${PORT}/ping" 2>/dev/null || echo 超时)"
echo
echo "================================================================"
log "部署完成！"
echo "  管理后台 : http://127.0.0.1:${PORT}"
echo "  健康检查 : ${PING}"
echo "  登录账号 : ${ADMIN_USER}"
echo "  登录密码 : ${ADMIN_PASS}"
echo "  访问令牌 : ${TOKEN}"
echo "  数据目录 : $(pwd)/data"
echo "  日志文件 : $(pwd)/app.log"
echo "--------------------------------------------------------------"
echo " 订阅链接（登录后驾驶舱顶部可复制）：http://127.0.0.1:${PORT}/sub?token=${TOKEN}"
echo "================================================================"
echo
warn "如果服务器有公网 IP，请登录后台把「本地节点」的公网地址改为实际 IP/端口，或配置 CF 隧道对外提供 HTTPS。"
