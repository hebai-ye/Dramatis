# 同步服务端（独立部署版）

把 Dramatis 的同步后端跑在**你自己的机器**上（腾讯云 / 家里的 NAS / 任意一台装了 Node 的机器）。

它做的事：实现 `head / push / pull` 三个接口 + 建空间 / 取空间元数据两个接口，
把记录（**密文**）存进一个 SQLite 文件。

它**不知道**：你的对话内容、角色设定、记忆、同步密码。
库里只有坐标、密文、两份凭证哈希、两份主钥匙封装；日志里不记录凭证与请求体。

---

## 0. 你需要什么

| 项 | 要求 | 怎么确认 |
| --- | --- | --- |
| Node | **22.5 或更新**（用到内置的 `node:sqlite`） | `node -v` |
| 磁盘 | 几十 MB 起（一个世界约 1 MB） | — |
| 网络 | 能让你手机/电脑访问到（见第 4 节） | — |

## 1. 构建（在你的开发机上做）

```bash
pnpm build:sync-server     # 把 core + 服务端编译到 tools/sync-server/dist
```

## 2. 拷到服务器

```bash
# 只拷需要的东西（dist 里已经含 core，服务器上不需要 pnpm install）
rsync -av --delete tools/sync-server/ user@你的服务器:/opt/dramatis-sync/
# 或者
scp -r tools/sync-server user@你的服务器:/opt/
```

服务器上最终应该有：

```
/opt/dramatis-sync/
  start.mjs            # 入口：node start.mjs
  backup.mjs           # 备份脚本
  dist/                # 编译产物（含 core）
  .env.example         # 配置模板（不含任何机密）
  systemd/dramatis-sync.service
```

### 更新一个已经在跑的服务器（**顺序错了会把服务打没**）

顺序 16 那天就是这么把服务端弄停四分钟的：`cp 旧 → 备份 && rm -rf dist && mv 新的 dist`
——第三步的「新的」还没传上去（`scp` 刚被 SSH 拒过），于是 `rm` 之后什么都没了，
服务反复重启报「还没有编译产物」。安全的顺序是**先确认新的真的在本地**，再动旧的：

```bash
# 1) 上传到一个独立名字，别直接覆盖在跑的目录
scp -r tools/sync-server/dist 服务器:/tmp/sync-server-dist

# 2) 在服务器上：先确认它真的到了、而且结构与 start.mjs 期待的一致
ls /tmp/sync-server-dist/tools/sync-server/src/main.js

# 3) 换目录（旧的一律保留成带时间戳的备份，不做删除）
sudo mv /opt/dramatis-sync/dist      /opt/dramatis-sync/dist.bak-$(date +%Y%m%d-%H%M%S)
sudo mv /tmp/sync-server-dist        /opt/dramatis-sync/dist

# 4) 权限：从 Windows scp 过来的目录是 700，服务用户（dramatis）读不到——
#    少了这一步就是「文件在、服务说找不到」
sudo chown -R root:root /opt/dramatis-sync/dist
sudo chmod -R a+rX      /opt/dramatis-sync/dist

# 5) 重启并当场确认（三个都要看）
sudo systemctl restart dramatis-sync
systemctl is-active dramatis-sync                                   # active
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/health    # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/spaces/foo # 404（说明业务路由活着）
```

回滚就是把 `dist` 和某个 `dist.bak-*` 换个名字再重启（备份一直都在，别删）。

## 3. 先手工试跑一次

```bash
mkdir -p /var/lib/dramatis-sync
cd /opt/dramatis-sync
DRAMATIS_SYNC_DATA=/var/lib/dramatis-sync/sync.db \
DRAMATIS_SYNC_HOST=127.0.0.1 \
DRAMATIS_SYNC_PORT=8787 \
node start.mjs
```

看到「Dramatis 同步服务端已启动」之后，另开一个终端：

```bash
curl -s localhost:8787/health          # {"ok":true,...}
curl -s localhost:8787/spaces/foo      # 404 {"error":{"code":"space-not-found",...}}
```

## 4. 让手机/电脑能连上（三条路，选一条）

> **重要**：浏览器只有在 **HTTPS** 或 **localhost** 下才提供端到端加密所需的 WebCrypto。
> 所以「手机直接访问 `http://公网IP`」这条路是走不通的——应用里的加密会直接报错。

| 方式 | 怎么配 | 适用 |
| --- | --- | --- |
| **A. Tailscale（最省事，推荐）** | 服务器与你的设备都装 Tailscale；服务仍监听 `127.0.0.1`，用 `tailscale serve https / http://127.0.0.1:8787` 暴露给 tailnet | 不需要域名、不需要备案，外人也访问不到 |
| **B. Caddy 反代 + 域名** | 域名解析到服务器 → Caddy 自动申请 Let's Encrypt 证书 → 反代到 `127.0.0.1:8787` | 想要一个正经网址；国内服务器用 80/443 **需要 ICP 备案** |
| **C. 自签证书（应急）** | 配 `DRAMATIS_SYNC_TLS_CERT` / `DRAMATIS_SYNC_TLS_KEY`，服务自己跑 https | 只有你能接受浏览器证书告警时；手机端体验差 |

Caddy 的最小配置（方式 B）：

```
sync.你的域名 {
  reverse_proxy 127.0.0.1:8787
}
```

### 跨源（CORS）

如果应用页面不在同一个源上（比如应用开在 `http://127.0.0.1:5273`，服务在服务器上），
必须把应用来源写进 `DRAMATIS_SYNC_ORIGINS`（逗号分隔，**精确匹配**）：

```
DRAMATIS_SYNC_ORIGINS=http://127.0.0.1:5273,https://你的应用地址
```

没配就只允许同源——这是默认值，也是最安全的。

## 5. 装成开机自启的服务

```bash
sudo cp /opt/dramatis-sync/systemd/dramatis-sync.service /etc/systemd/system/
sudo nano /etc/systemd/system/dramatis-sync.service   # 改 User=/Group= 成你自己的用户名
sudo systemctl daemon-reload
sudo systemctl enable --now dramatis-sync
systemctl status dramatis-sync        # 看是否 active (running)
journalctl -u dramatis-sync -f        # 看日志
```

## 6. 备份（强烈建议）

```bash
# 手动试一次
node /opt/dramatis-sync/backup.mjs /var/lib/dramatis-sync/sync.db /var/backups/dramatis 30

# 加进 crontab（每 6 小时一次，保留 30 份）
crontab -e
0 */6 * * * /usr/bin/node /opt/dramatis-sync/backup.mjs /var/lib/dramatis-sync/sync.db /var/backups/dramatis 30
```

备份出来的是**密文**：拿到备份也解不开，但仍然建议别放在公网可读的地方。

## 7. 管理数据

```bash
# 看有哪些空间、各多少条记录（只读、随时可跑）
sqlite3 /var/lib/dramatis-sync/sync.db \
  "SELECT space_handle, COUNT(*) FROM records GROUP BY space_handle;"

# 删除某个空间（连同它的记录）
sqlite3 /var/lib/dramatis-sync/sync.db \
  "DELETE FROM records WHERE space_handle='<句柄>'; DELETE FROM heads WHERE space_handle='<句柄>'; DELETE FROM spaces WHERE space_handle='<句柄>';"

# 从备份恢复（先停服务）
sudo systemctl stop dramatis-sync
cp /var/backups/dramatis/sync.db.<时间戳>.bak /var/lib/dramatis-sync/sync.db
sudo systemctl start dramatis-sync
```

没有 `sqlite3` 命令也行：`node -e "…"` 用 `node:sqlite` 一样能查，或者把文件拷回本地用工具看。
**服务端没有明文**，你看到的会是一堆坐标与密文——这正是「服务端看不到内容」的实证。

## 8. 升级

```bash
pnpm build:sync-server                                  # 开发机
rsync -av --delete tools/sync-server/ user@服务器:/opt/dramatis-sync/
ssh user@服务器 'sudo systemctl restart dramatis-sync'
```

## 9. 排错

| 现象 | 先看什么 |
| --- | --- |
| 应用报「连不上同步服务」 | `curl -s http://127.0.0.1:8787/health`（在服务器上）；再看 `journalctl -u dramatis-sync` |
| 应用报 CORS / 403 | `DRAMATIS_SYNC_ORIGINS` 没写对（必须与应用页面的来源**完全一致**，含协议与端口） |
| 应用报「只允许 https 或 localhost」 | 应用页面本身不是安全上下文（见第 4 节），不是服务端的问题 |
| 手机连不上 | 手机与服务器不在同一个 tailnet / 域名没备案 / 防火墙没放行 |
| 端口占用了 | `ss -lntp \| grep 8787`，或改 `DRAMATIS_SYNC_PORT` |

## 10. 安全清单（照着打勾）

- [ ] 服务监听 `127.0.0.1`，对外由 Tailscale 或 Caddy 提供 HTTPS
- [ ] 手机/电脑上的应用地址是 **https**（或本地 localhost）
- [ ] `DRAMATIS_SYNC_ORIGINS` 只写自己的应用来源，写完不随便加 `*`
- [ ] systemd 用普通用户跑，不用 root
- [ ] `backup.mjs` 进了 crontab，并且备份目录不在公网可读的位置
- [ ] 服务器 SSH 只用密钥登录、只开必要端口
- [ ] 仓库里没有任何自己的 IP / 域名 / id / 密码（见 `docs/SYNC-DEPLOY.md` 的自查清单）
