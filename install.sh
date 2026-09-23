#!/usr/bin/env bash
# =============================================================
# SubBridge 一键部署与运维脚本
# 支持平台：Linux (x86_64 / arm64 / armv7) · macOS (Intel / Apple Silicon)
# 支持模式：① 本机直跑（自动装 Node、依赖、可选 systemd 服务）
#           ② Docker 运行（--docker）
# 参数全配置化；未传参数时自动生成安全随机值。中文注释，符合项目规范。
# 运行 `bash install.sh help` 查看完整帮助。
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
  cat <<'EOF'
SubBridge 一键部署与运维脚本

【安装部署】
  curl -fsSL https://raw.githubusercontent.com/zhangsen0/subbridge/main/install.sh | bash
  bash install.sh [参数...]

  参数（均可省略，省略时自动生成安全随机值）：
    --port <端口>         Web 端口，默认 8080
    --token <令牌>        访问令牌（订阅/API 鉴权），默认自动生成 UUID
    --admin <用户名>      管理员账号，默认 admin
    --password <密码>     管理员密码，默认自动生成
    --docker              用 Docker 运行（自动拉取镜像）
    --no-service          跳过 systemd 服务（用 nohup 后台运行）
    --dir <目录>          部署目录，默认当前目录
    -h, --help, help      显示本帮助

【运维子命令】（首个参数）
  bash install.sh restart          重启服务
  bash install.sh start            启动服务
  bash install.sh stop             停止服务
  bash install.sh status           查看运行状态
  bash install.sh logs [-f] [行数]  查看日志（-f 跟踪输出，默认 100 行）
  bash install.sh update           更新代码到最新版并重启（git pull + 装依赖）
  bash install.sh doctor           环境自检（Node/依赖/端口/配置/数据/服务/日志）
  bash install.sh backup           导出数据备份（含节点池，JSON 文件）
  bash install.sh storage [驱动]    查看/一键切换存储驱动（file|sqlite，自动备份迁移数据）
  bash install.sh help             显示本帮助

【环境变量】（与参数等价，优先读取）
  PORT  HOST  SUBBRIDGE_API_TOKEN  SUBBRIDGE_ADMIN_USERNAME
  SUBBRIDGE_ADMIN_PASSWORD  SUBBRIDGE_DIR  NODE_BIN

【示例】
  bash install.sh                                   # 默认一键部署
  bash install.sh --port 9090 --token mytoken       # 自定义端口与令牌
  bash install.sh restart                           # 重启服务
  bash install.sh logs -f                           # 跟踪查看日志
  bash install.sh doctor                            # 排查部署问题
  bash install.sh update                            # 升级到最新版
EOF
}

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

# 读取 .env 中的配置项（仅导出已定义的键）
load_env() {
  if [[ -f "$INSTALL_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$INSTALL_DIR/.env"
    set +a
  fi
}

# ---------- Docker 模式（优先、最省心） ----------
docker_start() {
  command -v docker >/dev/null 2>&1 || fail "未检测到 Docker，请先安装 Docker 或改用本机直跑模式。"
  TOKEN="${TOKEN:-$(gen_token)}"
  ADMIN_PASS="${ADMIN_PASS:-$(gen_token | tr -d '-' | head -c 12)}"
  log "Docker 一键启动（端口 ${PORT}）..."
  docker rm -f subbridge >/dev/null 2>&1 || true
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
}

# ---------- 运维命令 ----------
service_cmd() {
  # 子命令：restart / start / stop / status / logs / update / doctor / backup
  local cmd="${1:-help}"
  case "$cmd" in
    restart|start|stop|status)
      if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files subbridge.service >/dev/null 2>&1; then
        systemctl "$cmd" subbridge
        if [[ "$cmd" == "status" ]]; then
          systemctl is-active subbridge || true
          systemctl status subbridge --no-pager | tail -8 || true
        else
          sleep 2
          systemctl is-active subbridge >/dev/null 2>&1 \
            && log "服务已${cmd}，健康检查: $(curl -s -m 5 "http://127.0.0.1:${PORT}/ping" 2>/dev/null || echo 超时)" \
            || warn "服务状态异常，请用 journalctl -u subbridge 排查"
        fi
      else
        # 无 systemd：nohup 模式（记录 PID）
        local pid_file="$INSTALL_DIR/.subbridge.pid"
        case "$cmd" in
          start)
            if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
              warn "服务已在运行（PID $(cat "$pid_file")）"
            else
              load_env
              local node_bin
              node_bin="$(command -v node)"
              [[ -x "$INSTALL_DIR/runtime/bin/node" ]] && node_bin="$INSTALL_DIR/runtime/bin/node"
              cd "$INSTALL_DIR"
              nohup env "$(grep -v '^#' .env 2>/dev/null | xargs)" "${node_bin}" app.js > app.log 2>&1 &
              echo $! > "$pid_file"
              disown || true
              sleep 2
              log "服务已后台启动，健康检查: $(curl -s -m 5 "http://127.0.0.1:${PORT}/ping" 2>/dev/null || echo 超时)"
            fi
            ;;
          stop)
            if [[ -f "$pid_file" ]]; then
              kill "$(cat "$pid_file")" 2>/dev/null || true
              rm -f "$pid_file"
              log "服务已停止"
            else
              pkill -f "node app.js" 2>/dev/null || true
              log "已尝试停止 node app.js 进程"
            fi
            ;;
          restart)
            bash "$0" stop || true
            sleep 1
            bash "$0" start
            ;;
          status)
            if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
              log "服务运行中（PID $(cat "$pid_file")）"
            else
              warn "服务未运行"
            fi
            ;;
        esac
      fi
      ;;
    logs)
      # 排查问题：查看日志；-f 跟踪
      if command -v journalctl >/dev/null 2>&1 && systemctl list-unit-files subbridge.service >/dev/null 2>&1; then
        if [[ "${2:-}" == "-f" ]]; then journalctl -u subbridge -f; else journalctl -u subbridge -n "${3:-100}" --no-pager; fi
      else
        local log_file="$INSTALL_DIR/app.log"
        [[ -f "$log_file" ]] || fail "未找到日志文件 $log_file（服务未以 nohup 模式运行过）"
        if [[ "${2:-}" == "-f" ]]; then tail -f "$log_file"; else tail -n "${3:-100}" "$log_file"; fi
      fi
      ;;
    update)
      # 更新代码：git pull → 依赖 → 重启
      cd "$INSTALL_DIR"
      [[ -d .git ]] || fail "未找到 git 仓库，无法自动更新。请手动覆盖代码或重新部署。"
      command -v git >/dev/null 2>&1 || fail "需要 git 才能更新。"
      log "拉取最新代码..."
      git pull --rebase || git fetch origin main && git reset --hard origin/main
      log "安装依赖..."
      npm install --omit=dev --no-audit --no-fund
      local node_major
      node_major="$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
      if [[ "$node_major" -lt 18 ]]; then
        log "Node <18：固定 undici@5.28.4（v6+ 需 Node18+）..."
        npm install undici@5.28.4 --save-exact --omit=dev --no-audit --no-fund
      fi
      log "重启服务..."
      bash "$0" restart
      log "更新完成！"
      ;;
    doctor)
      # 全站自检：Node / 依赖 / 端口 / 配置 / 数据目录 / 服务状态 / 常见问题
      echo "========== SubBridge 环境自检 =========="
      echo "[1/7] Node 版本: $(command -v node >/dev/null 2>&1 && node -v || echo 未安装)"
      if [[ -x "$INSTALL_DIR/runtime/bin/node" ]]; then echo "      独立 runtime: $($INSTALL_DIR/runtime/bin/node -v)"; fi
      echo "[2/7] 依赖检查:"
      cd "$INSTALL_DIR"
      for dep in undici ws js-yaml fastify sql.js better-sqlite3; do
        if [[ -d "node_modules/$dep" ]]; then
          local ver
          ver="$(node -e "console.log(require('./node_modules/$dep/package.json').version)" 2>/dev/null || echo ?)"
          echo "      ✓ $dep@$ver"
        else
          echo "      ✗ $dep 未安装"
        fi
      done
      echo "[3/7] 端口占用: $(curl -s -m 3 "http://127.0.0.1:${PORT}/ping" 2>/dev/null && echo '服务可访问' || echo '未响应（可能未启动或端口不对）')"
      echo "[4/7] 配置文件: $([[ -f "$INSTALL_DIR/.env" ]] && echo "存在 ($INSTALL_DIR/.env)" || echo '不存在（首次部署会自动生成）')"
      echo "[5/7] 数据目录: $([[ -d "$INSTALL_DIR/data" ]] && echo "$(du -sh "$INSTALL_DIR/data" 2>/dev/null | cut -f1) ($INSTALL_DIR/data)" || echo '不存在（启动后自动创建）')"
      if [[ -f "$INSTALL_DIR/data/subbridge.sqlite" ]]; then echo "      SQLite 数据: $(du -h "$INSTALL_DIR/data/subbridge.sqlite" | cut -f1)"; fi
      echo "[6/7] 服务状态:"
      if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files subbridge.service >/dev/null 2>&1; then
        systemctl is-active subbridge || true
      else
        [[ -f "$INSTALL_DIR/.subbridge.pid" ]] && echo "      nohup 模式 PID: $(cat "$INSTALL_DIR/.subbridge.pid")"
      fi
      echo "[7/7] 最近日志:"
      if command -v journalctl >/dev/null 2>&1 && systemctl list-unit-files subbridge.service >/dev/null 2>&1; then
        journalctl -u subbridge -n 5 --no-pager | tail -5 || true
      elif [[ -f "$INSTALL_DIR/app.log" ]]; then
        tail -5 "$INSTALL_DIR/app.log"
      fi
      echo "========================================"
      echo "常见问题排查提示："
      echo "  1) 服务无法启动 → bash install.sh logs  查看日志"
      echo "  2) 端口被占用   → 修改 PORT 后 bash install.sh restart"
      echo "  3) 页面打不开   → 确认防火墙放行 ${PORT} 端口"
      echo "  4) 抓取全部超时 → 生产若无法直连境外，在后台「全站参数→抓取」配置池内节点抓取或上游代理"
      ;;
    backup)
      # 导出备份（含节点池）：调用 /api/backup
      load_env
      local token="${SUBBRIDGE_API_TOKEN:-}"
      [[ -z "$token" ]] && fail "未找到 SUBBRIDGE_API_TOKEN，请在 .env 中配置或先部署一次。"
      local out="$INSTALL_DIR/subbridge-backup-$(date +%Y%m%d-%H%M%S).json"
      curl -s -m 30 -H "X-API-Token: ${token}" "http://127.0.0.1:${PORT}/api/backup" -o "$out"
      if head -c 1 "$out" | grep -q '{' 2>/dev/null; then
        log "备份完成：$out（$(du -h "$out" | cut -f1)）"
      else
        rm -f "$out"
        fail "备份失败，请确认服务运行与令牌正确。"
      fi
      ;;
    storage|db)
      # 一键切换存储驱动（file ↔ sqlite），自动备份 → 切换 → 重启 → 恢复数据 → 验证
      # 用法：bash install.sh storage [file|sqlite]（不带参数则显示当前驱动）
      load_env
      local want="${2:-}"
      local cur="$(grep -oE '^SUBBRIDGE_STORAGE_DRIVER=(.*)$' "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2 | tail -1)"
      cur="${cur:-file}"
      if [[ -z "$want" ]]; then
        log "当前存储驱动：${cur}（切换用法：bash install.sh storage file|sqlite）"
        return 0
      fi
      [[ "$want" != "file" && "$want" != "sqlite" ]] && fail "未知驱动：${want}（可选 file / sqlite）"
      if [[ "$want" == "$cur" ]]; then
        log "已是 ${want} 驱动，无需切换"
        return 0
      fi
      local token="${SUBBRIDGE_API_TOKEN:-}"
      [[ -z "$token" ]] && fail "未找到 SUBBRIDGE_API_TOKEN，请在 .env 中配置（切换需要调用备份/恢复接口迁移数据）。"
      # 1. 健康检查
      curl -s -m 5 "http://127.0.0.1:${PORT}/ping" >/dev/null 2>&1 || fail "服务未运行，请先启动（bash install.sh start）。"
      # 2. 备份当前数据
      local bak="$INSTALL_DIR/subbridge-migrate-backup.json"
      curl -s -m 30 -H "X-API-Token: ${token}" "http://127.0.0.1:${PORT}/api/backup" -o "$bak"
      if ! head -c 1 "$bak" | grep -q '{' 2>/dev/null; then
        rm -f "$bak"
        fail "备份失败，切换已中止。"
      fi
      log "已备份当前数据（$(du -h "$bak" | cut -f1)）"
      # 3. 切换配置（.env 的 SUBBRIDGE_STORAGE_DRIVER；file 为默认，删除该行即回退）
      if [[ "$want" == "sqlite" ]]; then
        if grep -q '^SUBBRIDGE_STORAGE_DRIVER=' "$INSTALL_DIR/.env" 2>/dev/null; then
          sed -i 's/^SUBBRIDGE_STORAGE_DRIVER=.*/SUBBRIDGE_STORAGE_DRIVER=sqlite/' "$INSTALL_DIR/.env"
        else
          echo 'SUBBRIDGE_STORAGE_DRIVER=sqlite' >> "$INSTALL_DIR/.env"
        fi
      else
        sed -i '/^SUBBRIDGE_STORAGE_DRIVER=/d' "$INSTALL_DIR/.env"
      fi
      log "存储驱动配置已切换为 ${want}"
      # 4. 重启服务
      if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files subbridge.service >/dev/null 2>&1; then
        systemctl restart subbridge
      else
        [[ -f "$INSTALL_DIR/.subbridge.pid" ]] && kill "$(cat "$INSTALL_DIR/.subbridge.pid")" 2>/dev/null || true
        sleep 1
        local node_bin
        node_bin="$(command -v node)"
        [[ -x "$INSTALL_DIR/runtime/bin/node" ]] && node_bin="$INSTALL_DIR/runtime/bin/node"
        cd "$INSTALL_DIR"
        nohup env "$(grep -v '^#' .env 2>/dev/null | xargs)" "${node_bin}" app.js > app.log 2>&1 &
        echo $! > "$INSTALL_DIR/.subbridge.pid"
        disown || true
      fi
      sleep 5
      curl -s -m 8 "http://127.0.0.1:${PORT}/ping" >/dev/null 2>&1 || fail "重启后健康检查失败，请用 bash install.sh logs 排查。"
      # 5. 恢复数据（写入新驱动）
      curl -s -m 60 -X POST -H "Content-Type: application/json" -H "X-API-Token: ${token}" \
        -d @"$bak" "http://127.0.0.1:${PORT}/api/restore" >/dev/null
      log "数据已恢复到 ${want} 驱动"
      # 6. 验证
      local total
      total="$(curl -s -m 10 -H "X-API-Token: ${token}" "http://127.0.0.1:${PORT}/api/pool?page=1&pageSize=1" | grep -oE '"total":[0-9]+' | head -1 | cut -d: -f2)"
      if [[ "$want" == "sqlite" ]]; then
        [[ -f "$INSTALL_DIR/data/subbridge.sqlite" ]] && log "SQLite 数据库文件已生成：$INSTALL_DIR/data/subbridge.sqlite"
      fi
      if [[ -n "$total" && "$total" != "0" ]]; then
        log "切换完成：存储驱动=${want}，节点池=${total} 个节点，源与配置均已迁移"
        rm -f "$bak"
      else
        warn "切换完成但节点池为空，请检查恢复结果（bash install.sh logs）"
      fi
      ;;
    help|-h|--help) usage ;;
    *) warn "未知运维命令：$cmd"; usage; exit 1 ;;
  esac
}

# ---------- 参数解析（先收集参数，再判断是否为运维命令） ----------
# 若第一个参数是运维命令（restart/start/stop/status/logs/update/doctor/backup/help），走运维分支
OPS_CMD="${1:-}"
case "$OPS_CMD" in
  restart|start|stop|status|logs|update|doctor|backup|storage|db|help|-h|--help)
    service_cmd "$@"
    exit 0
    ;;
esac

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

# ---------- Docker 模式 ----------
if [[ "$USE_DOCKER" == "1" ]]; then
  docker_start
  exit 0
fi

# ---------- 本机直跑模式（首次安装 / 重新部署） ----------
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

# 安装依赖（含版本兼容：旧 Node 自动降级关键依赖）
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
log "安装依赖（npm install --omit=dev）..."
npm install --omit=dev --no-audit --no-fund

# ---------- 版本兼容（保证老系统也能跑，全部可配置） ----------
# undici：Node<18 用 5.28.4（v6+ 要求 Node18+），否则用默认
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  log "Node <18：固定 undici@5.28.4（v6+ 需 Node18+）..."
  npm install undici@5.28.4 --save-exact --omit=dev --no-audit --no-fund
fi
# SQLite：内置 sql.js（纯 WASM，零原生编译，Node 14-22 全平台通用）。
# 无需 better-sqlite3 / python3 / gcc，老系统（CentOS7+Node16）开箱即用。

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
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable subbridge >/dev/null 2>&1 || true
  systemctl restart subbridge
  sleep 2
  systemctl is-active subbridge >/dev/null 2>&1 \
    && log "systemd 服务已启动" \
    || warn "systemd 服务启动失败，请用 bash install.sh logs 排查"
else
  log "后台启动服务（nohup，PID 记录到 .subbridge.pid）..."
  nohup env "$(cat .env | xargs)" "${NODE_BIN}" app.js > app.log 2>&1 &
  echo $! > .subbridge.pid
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
echo " 常用运维命令（本脚本）："
echo "  bash install.sh restart   # 重启服务"
echo "  bash install.sh status    # 查看状态"
echo "  bash install.sh logs      # 查看日志（排查问题）"
echo "  bash install.sh update    # 更新代码并重启"
echo "  bash install.sh doctor    # 环境自检"
echo "  bash install.sh backup    # 导出数据备份"
echo "--------------------------------------------------------------"
echo " 订阅链接（登录后驾驶舱顶部可复制）：http://127.0.0.1:${PORT}/sub?token=${TOKEN}"
echo "================================================================"
echo
warn "如果服务器有公网 IP，请登录后台把「本地节点」的公网地址改为实际 IP/端口，或配置 CF 隧道对外提供 HTTPS。"
