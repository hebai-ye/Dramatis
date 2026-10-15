# Linux 部署模板（可选新节点）

这里的文件都是**模板**：里面没有、也不该有你的地址、id、密码与证书。
你的真实值只写进服务器上的配置文件（不在仓库里）。

这份 README 的 `systemd`、Linux 路径和安装脚本供新建 Linux 节点使用。当前网页、同步与管理宿主按 [现行运维入口](../docs/SYNC-DEPLOY.md#当前运维入口2026-10-03-文档校正) 的 Windows/Caddy/WinSW 记录处理，旧 Linux 机承担入口与隧道。模板中的 `app.example.com` 是占位符。

完整构建使用 Node **22.13.0 以上的 22.x 或 24.x**，与根 `engines.node` 一致；新节点部署前核对版本。

## 一条重要的架构选择：应用与 API 同源

同步服务端只提供 API；**朋友要用这个项目，还需要有人提供网页**（就是 `apps/web` 的构建产物）。
把两者放在**同一个域名、同一个端口**下有四个好处：

1. 不需要 CORS（少一类配置错误）；
2. 一张证书管到底；
3. PWA 能装到手机桌面（要求 HTTPS）；
4. 朋友只需要记一个网址。

```
https://你的地址/            → 静态文件（apps/web/dist）
https://你的地址/sync/*      → 反代到 127.0.0.1:8787（同步服务端）
```

## 三条路，按你的情况选

| 路 | 需要域名 | 需要备案 | 大陆访问 | 用哪个模板 |
| --- | --- | --- | --- | --- |
| **1. 只给自己用（Tailscale）** | 不要 | 不要 | 好 | 不用反代：服务只监听 `127.0.0.1`，用 `tailscale serve` 暴露给 tailnet |
| **2. 给朋友用，域名 + 443** | 要 | 要（国内服务器） | 最好 | `Caddyfile.example` |
| **3. 给朋友用，域名 + 8443（备案没下来之前）** | 要 | 不要（绕开 80/443） | 好 | `nginx-8443.conf.example` |

> 关于第 3 条：技术上可行、也很常见，但严格说属于**灰色地带**——国内服务器对外提供
> 网站服务按规矩需要备案，被抽查到可能被要求整改。自己人和少数朋友用风险不大，
> 但不是"合规"方案；长期还是走备案（第 2 条）。如果不打算备案，把服务放到境外
> （香港/新加坡）反而是更干净的选择。

## 安装（三种路都先做这一步）

```bash
# 1) 开发机：编译同步服务端，并构建网页
pnpm build:sync-server
pnpm build                       # 产出 apps/web/dist

# 2) 拷到服务器（示例路径，按需改）
rsync -av --delete tools/sync-server/ root@服务器:/opt/dramatis-sync/
rsync -av --delete apps/web/dist/ root@服务器:/var/www/dramatis/
rsync -av --delete deploy/ root@服务器:/opt/dramatis-sync/deploy/

# 3) 服务器上：建目录、起服务
sudo bash /opt/dramatis-sync/deploy/install-server.sh   # 幂等，可重复跑
```

`install-server.sh` 只做本机的事（建用户与目录、装 systemd 单元、给权限），
**不会**替你去网上装 Node、也不会写你的地址——那两条它只打印给你看。

它会把 `/opt/dramatis-sync` 设成 root 所有、服务用户只读，只有 `/var/lib/dramatis-sync` 可写；
systemd 单元开了 `ProtectSystem=strict`、`ProtectHome` 等隔离，`ExecStart` 写的是解析后的 node 绝对路径
（node 不能装在家目录里；要指定别的 node 用 `DRAMATIS_NODE=/usr/local/bin/node`）。
以后 rsync 更新代码要用 root（或 sudo）执行。

## 安全响应头（HSTS / CSP 等）

- nginx：先 `sudo cp deploy/nginx-security-headers.conf /etc/nginx/snippets/dramatis-security-headers.conf`，
  `nginx-8443.conf.example` 里已经 include 它（`location = /sw.js` 里也 include 了一次，因为 nginx 的
  `add_header` 在 location 里不继承）。
- Caddy：`Caddyfile.example` 里直接写了 `header { ... }`。
- CSP 默认是 **Report-Only**，正式强制**待验证（归 Codex）**。必须先在隔离环境实际启用
  `Content-Security-Policy`，用真浏览器完整验收真实 BYOK（保存配置、请求、流式响应、工具续传）
  与自定义 HTTPS 模型来源，以及聊天、同步、导入卡、背景和本地模型；记录响应头与控制台违规。
  验收通过后才可提交并推广正式 CSP，无法验证就继续 Report-Only。假模型通过或观察几天无报错
  均不能替代验收；具体步骤见 `nginx-security-headers.conf`，清单见 [验证计划](../docs/VALIDATION-2026-10-03.md)。

## 证书

| 情况 | 怎么拿证书 |
| --- | --- |
| 域名 + 443（已备案） | Caddy 自动申请与续期（用 `Caddyfile.example` 即可） |
| 域名 + 8443（未备案） | 80/443 用不了，所以用 **DNS-01**：`acme.sh --issue --dns dns_dp -d sync.你的域名`（腾讯云 DNSPod），证书放到 `/etc/ssl/dramatis/` |
| 只给自己用 | 不用证书：Tailscale 那边自带 HTTPS |

## 别忘了

- 防火墙只开需要的端口：SSH + 443（或 8443）；**不要**把 8787 直接开到公网；
- `.env`、证书、`*.db`、`backups/` 都不进仓库（`.gitignore` 已经挡住）；
- 备份与恢复先看 [现行运维入口](../docs/SYNC-DEPLOY.md#当前运维入口2026-10-03-文档校正)：只运输完成的一致性快照，切换前停止或隔离全部持库服务；Linux 脚本用法另见 [服务端 README](../tools/sync-server/README.md) 第 6 节。
