# 部署模板（腾讯云 / 任意一台 Linux 服务器）

这里的文件都是**模板**：里面没有、也不该有你的地址、id、密码与证书。
你的真实值只写进服务器上的配置文件（不在仓库里）。

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
- CSP 默认是 **Report-Only**：只在浏览器控制台报违规，不拦。把各功能走一遍、观察几天没报错，
  再按 `nginx-security-headers.conf` 顶部的步骤切成正式的 `Content-Security-Policy`。

## 证书

| 情况 | 怎么拿证书 |
| --- | --- |
| 域名 + 443（已备案） | Caddy 自动申请与续期（用 `Caddyfile.example` 即可） |
| 域名 + 8443（未备案） | 80/443 用不了，所以用 **DNS-01**：`acme.sh --issue --dns dns_dp -d sync.你的域名`（腾讯云 DNSPod），证书放到 `/etc/ssl/dramatis/` |
| 只给自己用 | 不用证书：Tailscale 那边自带 HTTPS |

## 别忘了

- 防火墙只开需要的端口：SSH + 443（或 8443）；**不要**把 8787 直接开到公网；
- `.env`、证书、`*.db`、`backups/` 都不进仓库（`.gitignore` 已经挡住）；
- 备份见 [../tools/sync-server/README.md](../tools/sync-server/README.md) 第 6 节。
