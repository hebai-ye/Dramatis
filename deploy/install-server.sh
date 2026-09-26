#!/usr/bin/env bash
# 服务器侧安装脚本（幂等，可以反复跑）。
#
# 它只做本机的事：建用户与目录、装 systemd 单元、设权限、起服务。
# **它不联网、不装 Node、不写你的地址**——那两件事它只打印出来让你自己决定。
#
# 用法（把仓库里的 deploy/ 拷到服务器任意位置，然后）：
#   sudo bash install-server.sh
#
# 前置：已经跑过
#   rsync -av --delete tools/sync-server/ root@服务器:/opt/dramatis-sync/
#   rsync -av --delete apps/web/dist/    root@服务器:/var/www/dramatis/

set -euo pipefail

SERVICE_USER="${DRAMATIS_USER:-dramatis}"
APP_DIR="/opt/dramatis-sync"
DATA_DIR="/var/lib/dramatis-sync"
WEB_DIR="/var/www/dramatis"
UNIT_PATH="/etc/systemd/system/dramatis-sync.service"

if [[ "${EUID}" -ne 0 ]]; then
  echo "请用 sudo 运行：sudo bash install-server.sh" >&2
  exit 1
fi

echo "== 1/5 检查 Node =="
if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node。请先安装 Node 22.5 或更新（这一步留给你自己决定用哪种方式）："
  echo "  a) NodeSource：curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
  echo "  b) 官方 tarball：https://nodejs.org/dist/  (解压后把 bin 加进 PATH)"
  echo "装好后重新跑这个脚本。"
  exit 1
fi
NODE_BIN="${DRAMATIS_NODE:-$(command -v node)}"
# systemd 的 ExecStart 要绝对路径，而且解析掉符号链接，免得 PATH 里换了个 node 悄悄换版本
NODE_BIN="$(readlink -f "${NODE_BIN}")"
if [[ "${NODE_BIN}" != /* || ! -x "${NODE_BIN}" ]]; then
  echo "node 路径无效：${NODE_BIN}（可以用 DRAMATIS_NODE=/绝对路径/node 指定）" >&2
  exit 1
fi
NODE_VERSION="$("${NODE_BIN}" -v)"
echo "  发现 node ${NODE_VERSION}（${NODE_BIN}）"
"${NODE_BIN}" -e 'const [maj,min]=process.versions.node.split(".").map(Number); if (maj<22||(maj===22&&min<5)) { console.error("需要 Node >= 22.5（内置 node:sqlite）"); process.exit(1);}'
case "${NODE_BIN}" in
  /home/*|/root/*)
    echo "  node 在家目录里（${NODE_BIN}）。服务开了 ProtectHome，读不到那里；请装到 /usr 或 /opt 下再跑。" >&2
    exit 1
    ;;
esac

echo "== 2/5 检查文件是否已拷好 =="
[[ -f "${APP_DIR}/start.mjs" ]] || { echo "缺少 ${APP_DIR}/start.mjs（先把 tools/sync-server/ 拷过去）" >&2; exit 1; }
[[ -d "${APP_DIR}/dist" ]] || { echo "缺少 ${APP_DIR}/dist（先在开发机跑 pnpm build:sync-server 再拷）" >&2; exit 1; }
[[ -f "${WEB_DIR}/index.html" ]] || echo "  提示：${WEB_DIR} 里还没有网页（只做同步 API 时可以先不管；要邀请朋友就需要它）"

echo "== 3/5 建用户与目录 =="
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --home "${DATA_DIR}" --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
  echo "  已创建系统用户 ${SERVICE_USER}"
else
  echo "  用户 ${SERVICE_USER} 已存在"
fi

mkdir -p "${DATA_DIR}" "${WEB_DIR}"
# 审计 B19：代码归 root、服务用户只读——服务被攻破也改不了自己的代码来持久化。
# 只有数据目录归服务用户可写。
chown -R root:root "${APP_DIR}"
chmod -R u=rwX,go=rX "${APP_DIR}"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}"
chmod 700 "${DATA_DIR}"

echo "== 4/5 装 systemd 单元 =="
cat > "${UNIT_PATH}" <<UNIT
[Unit]
Description=Dramatis sync server (end-to-end encrypted, ciphertext only)
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
Environment=DRAMATIS_SYNC_DATA=${DATA_DIR}/sync.db
Environment=DRAMATIS_SYNC_HOST=127.0.0.1
Environment=DRAMATIS_SYNC_PORT=8787
# 同源部署（网页与 API 同一个域名）时不需要跨源白名单；
# 如果你把网页放到别处，再在这里加 DRAMATIS_SYNC_ORIGINS=https://...
Environment=DRAMATIS_SYNC_ORIGINS=
ExecStart=${NODE_BIN} --no-warnings ${APP_DIR}/start.mjs
Restart=always
RestartSec=3
# 加固（审计 B19）：整个文件系统只读，只有数据目录可写；看不到家目录与物理设备
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictSUIDSGID=true
LockPersonality=true
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now dramatis-sync

echo "== 5/5 检查 =="
sleep 1
systemctl --no-pager --lines=5 status dramatis-sync || true
echo
if curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1; then
  echo "✅ 服务已在 127.0.0.1:8787 上跑起来"
else
  echo "⚠️  本地健康检查没过，看日志：journalctl -u dramatis-sync -n 50"
fi

cat <<'NEXT'

接下来（二选一）：

· 只给自己用（不需要域名/备案）：
    在服务器上装 Tailscale，然后
      tailscale serve --bg --https 443 http://127.0.0.1:8787
    手机与电脑装 Tailscale 客户端加入同一个 tailnet，用 tailnet 里的 https 地址访问。

· 给朋友用（需要域名）：
    已备案 → 用 deploy/Caddyfile.example（自动证书，80/443）
    没备案 → 用 deploy/nginx-8443.conf.example（DNS-01 证书 + 8443）
    两者都要把网页放在 /var/www/dramatis，并让应用里的服务端地址填同源的 /sync。

备份（建议放进 crontab）：
    node --no-warnings /opt/dramatis-sync/backup.mjs /var/lib/dramatis-sync/sync.db /var/backups/dramatis 30
NEXT
