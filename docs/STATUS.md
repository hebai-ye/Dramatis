# 当前状态

> 记录「此刻在哪里」，供新会话快速接上。完整计划见 [ROADMAP.md](./ROADMAP.md)，验证方法见 [EVAL.md](./EVAL.md)。

## 文档地图（先读哪份）

| 想知道什么 | 读哪份 |
| --- | --- |
| 现在做到哪了、下一步做什么 | **本文（STATUS.md）** |
| 下一批具体动手的清单 | [TASKS.md](./TASKS.md) |
| 长期路线、优先级、风险 | [ROADMAP.md](./ROADMAP.md) |
| 用户要的界面长什么样、怎么动 | [LAYOUT.md](./LAYOUT.md) |
| 怎么验证它能用、真模型跑出来的结论 | [EVAL.md](./EVAL.md) |
| 账号与同步怎么定、协议长什么样 | [SYNC.md](./SYNC.md) |
| 架构与数据模型的原始设计 | [DESIGN.md](./DESIGN.md) |
| 每个文件是什么时候加的 | [FILE-LOG.md](./FILE-LOG.md) |
| 项目对外介绍与快速开始 | [../README.md](../README.md) |

## 一句话

Dramatis 是一个多角色扮演酒馆，兼容 SillyTavern 资产格式。**P0（9 项）全部完成，P1 全部收口（11/11，P1-11 以评测结论收口：证据不支持上向量）；P2 已完成响应式 / PWA / 存储持久化 / 封存导出；界面改版三批（A/B/C）全部完成；P1-10 七轮真模型验证 + 六次评测回归跑完**，441 个测试通过；**P2-6 已上线**：数据层 / 加密 / 同步循环 / 服务端 / 界面全部交付，并已部署在用户自己的腾讯云 Ubuntu 24.04 上（systemd + SQLite + 每 6 小时备份，冒烟测试通过）。**当前接续点：域名审核中 → 等 A 记录后签证书 + nginx 8443（同源托管网页），再切 443**。

**下一批做什么看 [TASKS.md](./TASKS.md)**：账号与同步**选型已定**（[SYNC.md](./SYNC.md)：
同步空间 + 同步密码、AES-GCM 端到端加密、协议先行 + 可替换后端；用户 id 改成「用户自己填」，
见该文档 §3.1 修订），**P2-6 前四步已完成**——
`Scene`/`Message`/`MemoryEvent`/`ChapterSummary` 补齐 `updatedAt`、全套 `deletedAt` 软删除、
本机 `deviceId` 与消息 `localSeq`（三个提交 + 三条迁移，真机验证过老库升级与导出导入）。
加密工具（`core/crypto`：折 id、PBKDF2 派生、AES-GCM 记录加解密、两种凭证与恢复码、
主密钥封装）与**同步循环**（`core/sync`：可注入的 `SyncTransport`、内存服务端、
推 → 拉 → 合并 → 推进游标）也已完成，两者都在真浏览器里自测过。
服务端侧（`core/sync/server.ts` + `http.ts`，一份逻辑三个宿主；开发后端挂在 vite 的 `/sync/*`，本机就能两台浏览器同步）也已完成，并真的走 HTTP 在浏览器里验过。
下一步是 Cloudflare Worker 参考实现 + 把同步接进界面（设置里填 id 与密码）。
另有 T3 剩下的一半（记忆合并成粗粒度印象）可以随时插进来。

## 已完成

| 批次 | 内容 |
| --- | --- |
| 1 | 本地持久化、会话恢复、多服务商配置、工程基线（Biome + CI） |
| 2 | 多角色同场、发言调度、视角化上下文、场景控制、重抽与编辑 |
| 3 | 记忆抽取、视角化存储、混合召回、记忆面板 |
| 4 | 情绪与关系推演、抗漂移、统一后台队列（部分） |
| — | 查漏补缺：级联删除、世界书入口、后台模型配置 UI |
| — | 界面改版：侧边栏＝设定，主区＝对话，运行时面板独立 |
| A | 界面规格落地：顶栏折叠、主区标题栏、`#` 动作分段、输入区按钮与对话模式、右栏角色栏、左栏三段 |
| B | 世界 → 多对话的层级；归档＝状态快照回滚 + 按对话撤销记忆 |
| C | 副对话（世界管理员）与三个工具的真实调用，草稿由用户决定去留 |
| — | P1-10 真模型验证两轮（网页版探针 + API 端到端），抓出并修掉八处问题 |
| — | P3-7 起步：真实 token 用量统计（每条回复 + 后台合计）；修掉场外角色上台的结构性问题 |
| — | T1 动作分段成立（引号内是对白、引号外是动作，`#` 仍优先）；T2a 追问延续；设置面板改为草稿式保存 |
| — | T4 五十回合长跑（长线不塌、记忆 188 条、长程召回全中）；T18 语音归属检测 + 一键改归属 |
| — | T17 换场「这次带谁走」+ T10 名单与存在状态对齐（名单是权威，presence 跟着名单走） |
| — | T2 意图先行：规则信号全部落地 + 推理流当盘算（声明式实测 0/4，已记录）；动作轮不吃冷却 |
| — | T2c 生成前意图调用：抽取与推演合并成一次后台调用腾出预算，意图作为建议驱动角色落笔（真机 3 轮验证） |
| — | T7 用量账单落盘：单开只增不改的流水，按用途 / 角色 / 模型统计，单价换算成钱（脚本化浏览器回归） |
| — | T3 分层摘要：场景场记 + 章节回顾，游标只压一次、原文一个字不删；真机 3 轮验证（含修掉重复触发） |
| — | T19 调用熔断：到上限只停后台调用、回复照常；T20 动作主语改用角色名字（用户提出） |
| — | T21 召回评测：合成题库 + 真实数据探针（214 条记忆），结论是暂不做向量、改做去重 |
| — | T23 滚动归属：修掉「窄窗口把整页拉长」的遗留 bug，外壳固定、对话区自己滚（用户提出） |
| — | T22 记忆预算的兜底上限：实测推翻「噪音是重复」的猜测，改成限制无关条目，相关条目 4.0 → 5.1 |
| — | T9 封存导出 / 导入（P2-4）：一个世界存成一个文件、导入永远新建一条线，id 与引用全量重映射 |
| — | T8a 响应式：手机把左栏收成抽屉、角色栏让位；T8b PWA（manifest + 离线外壳 + 存储持久化面板） |
| — | T6 选型（P2-5）：账号＝同步空间 + 同步密码、后端可替换、AES-GCM 端到端；数据层要补什么也盘清了 |
| — | P2-6 第一步（数据层前置）：四类实体补 `updatedAt`、全套 `deletedAt` 软删除、本机 `deviceId` + 消息 `localSeq`；三条迁移 + 真机验证（老库 v2→v6、导出导入、离线、手机视口） |
| — | P2-6 第二步（加密工具）：`core/crypto`——折 id、PBKDF2、AES-GCM + AAD 绑坐标、两种凭证、恢复码、主密钥封装；真浏览器 19 项自测（含「恢复码解出同一把主密钥」） |
| — | P2-6 第三步（同步循环）：`core/sync`——`SyncTransport`（head / push / pull）+ 内存服务端 + 合并规则（LWW、墓碑、记忆全留、消息按时间交错）+ 本地游标；真浏览器两台设备全链路 13 项自测 |
| — | P2-6 第四步（上，服务端侧）：`core/sync/server.ts` + `http.ts`（一份逻辑、三个宿主）+ 开发后端（vite `/sync/*`，本机就能同步）+ fetch 传输层；真浏览器走 HTTP 的两台设备验证 13 项 |
| — | **P2-6 落地部署（2026-09-20）**：用户自己的腾讯云服务器（Ubuntu 24.04 + Node 22 + systemd + SQLite + 每 6 小时备份），先用 Tailscale 内网 HTTPS 过渡（用户之后放弃该方案）、改走「域名 + HTTPS」；服务器地址 / SSH / 域名等私有信息在 `deploy/LOCAL-NOTES.md`（**已 gitignore**） |
| — | P2-6 界面接线：设置里「同步（多设备）」（地址 + 用户 id + 密码/恢复码 + 保存方式 + 上次结果）；两个独立浏览器端到端验证 |
| — | P2-6 第四步（下，部署件）：`packages/core/src/sync/sqlite.ts`（SQLite 存储 + 7 条单测）+ `tools/sync-server/`（独立服务端 / systemd / 在线备份 / 部署手册）+ CORS；跨源真机验证 13 项；**方案答卷见 [SYNC-DEPLOY.md](./SYNC-DEPLOY.md)** |

## 仓库结构速查

```
packages/core            平台无关内核，零运行时依赖
  model/                 Card / Instance / Room / Scene / Message / Persona / Provider
  model/conversation.ts  Conversation：主副对话、会话级模式、归档用的状态快照
  compat/sillytavern/    PNG 解析、角色卡 V1–V3、世界书导入与关键词匹配
  memory/                抽取、视角化落库、混合召回、情绪关系、抗漂移
  prompt/                分块装配、预算守卫、按视角裁剪历史
  director/              发言调度（纯规则，可解释）
  render/                `#` 动作分段与拆气泡、场景切换的旁白句式
  admin/                 世界管理员：三个工具的声明、参数校验、工具调用循环
  session/setup.ts       世界 / 对话 / 场景 / 实例的构造器
  storage/               仓储层、版本化迁移
  platform/              EntityStore / KeyStore / FileIO / BackgroundRunner
  eval/                  长跑基线与抽取提示词参考
apps/web                 React + Vite
tools/desktop/           桌面启动器（零依赖，Chromium --app 模式）
```

## 不可回退的设计决定

这些是踩过坑之后定下来的，改动前先看 [ROADMAP.md](./ROADMAP.md) 里的实现说明。

1. **Card 与 Instance 分离** —— 角色卡可以反复迭代，已有世界线的记忆与关系不受影响。
2. **消息带 `audience` 字段** —— 角色看不到自己不在场时发生的事，且不消耗额外模型调用；同时是记忆该写给谁的依据。
3. **客观记忆与视角记忆分开存**，且不做一致性校验 —— 同一件事在不同角色记忆里矛盾是特性。
4. **后台任务负载只存 id** —— 消息内容执行时现取，重试与跨会话恢复不依赖负载新鲜度。
5. **情绪褪色也写进历史** —— 否则重抽无法精确还原，会单向漂移。
6. **`core` 保持零运行时依赖** —— 各端复用与长期可维护性的前提。
7. **Web 用 IndexedDB 而非 SQLite WASM** —— 理由见 ROADMAP 的 P0-1 实现说明。

## 待办

**P1 全部收口（11/11）**：P1-11 以**评测结论**收口（T21）——真实长跑数据（214 条记忆、
3 个角色）上关键词召回没有漏召回，漏的是精度；按 ROADMAP 的约定**暂不做向量检索**，
触发条件写死在 EVAL 第五节。T22（记忆预算的兜底上限）已交付。

**已完成**：P1-1~P1-4 记忆、P1-5 分层摘要（T3，遗忘机制另半留下）、P1-6 意图先行调度（T2c）、
P1-7/P1-8 情绪与抗漂移、P1-9 调用预算与熔断（T19）、P1-10 七轮真模型验证 + 两次工程回归。

**P1-10 的真实模型验证已经跑完六轮（2026-09-16 ~ 09-19，DeepSeek）**，完整记录见
[EVAL.md](./EVAL.md) 第二节：

- 第一轮用**网页版**当提示词探针（四条提示词 + 工具声明），发现并修掉：改世界书丢原有
  设定、`set_scene` 顺手改入场策略、多行字段被写成数组会被静默丢弃。回答原样记在
  `packages/core/src/eval/real-model-responses.ts`，由解析断言守着。
- 第二轮走**真实 API 端到端**：三张卡同场聊 12 回合，穿插视角裁剪、记忆干预、重抽、
  副对话工具调用与归档。九项能力全部通过——**视角裁剪**（小满离场期间的事她确实不知道）
  与**记忆干预**（手改的记忆下一轮被她自己说出来）是最关键的两条证据。
- 这一轮抓到并修掉五个问题（自报家门、动作与对白同行、抄走别人的名字、**重抽导致该轮
  记忆永久消失**、调度不延续追问），都已变成回归断言。
- 第三轮解决**动作分段**：六种「要求模型加标记」的办法全部失败，改成「对白带引号、
  引号外算动作」立刻成立。
- 第四轮是 **T4 五十回合长跑**：三人同场跑满 50 回合，长线不塌、记忆 188 条、
  长程召回全中、情绪关系分化且未失控、性格没趋同、视角边界成立；顺带修掉
  「转写标记自我强化」与「一句提两人时冷却决定谁答」。仍留下两条已登记的问题：
  **语音归属错位（约 8%）** 与 **换场会带走整个名单**。
- 第五轮证明「让模型自己写 `意图：` 行」不成立（4 回合 0 次遵守），
  于是改走推理流当盘算 + 动作轮不吃冷却。
- 第六轮是 **T2c 生成前意图调用**：把抽取与推演合并成一次后台调用腾出预算，
  生成前用便宜模型问「这一轮谁开口、他想做什么」，**角色真的照着自己的打算落笔**
  （三轮证据见 EVAL）。每回合额外调用仍是 2 次，意图调用也被计入「额外调用」。

**那之后补上的**：全程 token 账单（T7：账单落盘的流水，跨重载不丢）、
分层摘要（T3）、调用熔断（T19）、召回评测（T21/T22）、封存导出（T9）、
响应式与 PWA（T8）。**仍然缺的**只有语音归属错位（T18 只能事后检测与一键改归属，
模型侧没根治）与「记忆合并成粗粒度印象」（T3 的一半）。

**界面改版已收尾**：草图里那两个待确认的问题都已定稿（右缘那条竖线是真实的角色栏；
运行时面板默认折叠，由主区标题栏的「面板」按钮开关），三批全部完成，
差异表与实现取舍见 [LAYOUT.md](./LAYOUT.md)。

等域名审核通过后：**A 记录 → DNS-01 证书 → nginx 8443 同源托管「网页 + /sync」→
应用里把服务端地址换成 `https://sync.<域名>:8443` → 两台设备复验 → 并行推备案 → 备案下来切 443**。
之后还剩：手机装 PWA、本机每日拉备份到 `D:\dramatis-backup`、每轮对话结束自动同步、
记录分块与坏记录隔离、Cloudflare Worker 参考实现（可选）。

## 怎么继续

```bash
pnpm install
pnpm desktop        # 起本地服务并用应用窗口打开
pnpm test           # 441 个测试
pnpm typecheck
pnpm lint
pnpm build          # 生产构建（PWA 的 Service Worker 只在这个产物里注册）
```

真机验证的三条路径：

```bash
# 1) 应用里直接聊（Key 存在浏览器配置里；模型调用会真的花钱，别乱跑）
# 2) 取样提示词，贴进 DeepSeek 网页版，再把回答贴回来
pnpm --filter @dramatis/core test prompt-samples --silent=false --disableConsoleIntercept
# 3) 召回探针（读本机真实记忆，用同一套内核跑评测）
#    http://127.0.0.1:5273/tools/recall-probe.html
```

工作约定：每个批次结束时都必须能构建、能测试、能提交；提交信息带任务编号；实现与计划有偏差时写进 ROADMAP 而不是悄悄改掉。

### 部署线（搁置中，等域名审核通过再接）

这一条不属于「下一轮要做的事」，但别丢：域名审核通过后，用下面这段开一条单独的会话。

```text
接着做 Dramatis 的部署收尾（P2-6 的部署线）。先读 docs/STATUS.md、docs/SYNC-DEPLOY.md 与
deploy/LOCAL-NOTES.md（服务器私有信息在这里，已 gitignore，别提交）。

现状：同步服务已经跑在用户自己的腾讯云上（Ubuntu 24.04 + systemd + SQLite + 每 6 小时备份），
界面「设置 → 同步」已完成并真机验证；只差「用域名访问」这一步。

这次要做：
1) 用户给一个已解析到服务器的域名（A 记录 sync → 服务器 IP）；
2) 用 DNS-01 签证书（80/443 未备案会被拦），需要给用户一条 _acme-challenge 的 TXT 记录；
3) 配 nginx：https://sync.<域名>:8443 同时提供网页（apps/web/dist）与 /sync 反代（同源免 CORS）；
4) 应用里换地址并两台设备复验；并行推备案，通过后切 443。

要求同上：能构建/测试/提交；真机验证；私有信息不进仓库。
```
## 下一轮怎么开（给新会话的提示词）

> 直接复制下面这段作为新会话的第一条消息：

```text
接着做 Dramatis（多角色扮演酒馆）。先读 docs/STATUS.md（接续点）、docs/TASKS.md（工作清单）、
docs/ROADMAP.md 的 P2-9 / P2-10（桌面壳与安卓壳的触发条件）与 docs/LAYOUT.md（界面规格）。

现状（2026-09-20）：P2-6 账号与同步**已经全部落地**——数据层（updatedAt / deletedAt / deviceId /
localSeq）、加密工具（core/crypto）、同步循环（core/sync）、独立服务端（tools/sync-server + SQLite）、
界面「设置 → 同步」都完成并真机验证过；同步服务已部署在用户自己的腾讯云上（Ubuntu 24.04 + systemd +
SQLite + 每 6 小时备份），两台设备验证通过。
**部署那条线（域名 + HTTPS + 备案）暂时搁置**，等域名审核通过再继续；服务器私有信息在
deploy/LOCAL-NOTES.md（已 gitignore，不要提交）。

这一轮做【项目主体 + 桌面版 + 安卓软件】，按这个顺序推进：

1) 项目主体：从 docs/TASKS.md 里挑当前最影响体验的 2~3 项（候选：T11 记忆面板的对话维度、
   T12 归档的可发现性与导出、T13 世界管理员工具的体验、T3 剩下的「记忆合并成粗粒度印象」、
   每轮对话结束自动同步、记录分块与坏记录隔离）。**先用真实数据或真机复现问题再动手**，
   每项都拆成能构建 / 能测试 / 能提交的小步。
2) 桌面版：现状是 tools/desktop/launch.mjs（零依赖：起 vite/preview + Chromium --app 窗口），
   不是真正的壳；ROADMAP P2-9 说 Tauri 是「条件触发」。所以先把「PWA 在桌面上到底缺什么」
   列成清单并给出证据（标签页回收导致后台任务中断？OS 级密钥存储？本地模型？文件夹监控？），
   再决定是补强现有启动器还是上 Tauri；上 Tauri 前先确认本机有没有 Rust 工具链。
3) 安卓版：现状是可安装的 PWA（manifest + Service Worker）。两条路：
   · **Capacitor 壳**（.gitignore 已预留 apps/android/android/、*.keystore、local.properties）——
     WebView 里的源是 https://localhost，属于安全上下文，**不依赖外部域名**，可以马上做；
   · TWA（Bubblewrap）—— 最轻，但需要已部署的 HTTPS 域名 + assetlinks.json，得等域名那条线。
   先做 Capacitor：把 apps/web/dist 包进去，逐项验证 **IndexedDB 持久化、文件导入导出、
   同步可用、后台队列在切后台后的行为**，并在安卓真机上跑一遍。

要求：每一小步都能构建/测试/提交；提交信息带任务编号；实现与计划有偏差写进文档；
真机验证（浏览器 / 桌面窗口 / 安卓真机）；**任何用户私有信息（域名/IP/凭据）都不进仓库**。
```

**环境与工具（这一轮踩过的，省得再摸一遍）**：

| 事项 | 怎么弄 |
| --- | --- |
| 起本地服务 | 在 `apps/web` 下 `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5273 --strictPort`。**必须沙箱外启动**，否则应用窗口连不上（沙箱内的服务自身能 200，浏览器却拒绝连接） |
| 真机验证（浏览器） | 用 `cua_repl` 驱动应用窗口；标签页卡在错误页就新开一个（旧的关掉）。通道偶尔整体不可用（报 auth 错），那就退到下面的无头方案 |
| 无头验证 | Playwright 用**系统 Chrome**：`chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' })`（Playwright 自带的 headless shell 没装）。模块路径 `C:\Users\35350\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules`，用 `createRequire` 加载 |
| PWA / Service Worker | 只在生产构建里注册：`pnpm build` 然后 `vite preview --port 4174`，用无头 Chrome 验。**别只清缓存不重装 SW**——脚本没变浏览器不会重新 install，缓存就一直是空的（我在这里绕过远路） |
| 召回探针 | `http://127.0.0.1:5273/tools/recall-probe.html`（读本机真实记忆、用同一套内核跑探针） |
| 加密探针 | `http://127.0.0.1:5273/tools/crypto-probe.html`（真浏览器跑一遍 PBKDF2 / AES-GCM / 恢复码，并打出耗时） |
| 同步探针 | `http://127.0.0.1:5273/tools/sync-probe.html`（两台设备 + 内存服务端跑完整链路：加入 / 离线各聊两轮 / 合并 / 删一条 / 幂等） |
| 同步探针（走 HTTP） | 需要带 `/sync` 后端的开发服务器（vite 插件）：另起一个端口（如 `--port 5275`）后打开 `http://127.0.0.1:5275/tools/sync-http-probe.html`。**原有的开发服务器要重启才有这个中间件**（vite 配置文件改了不会热更） |
| 部署服务器 | 用户自己的腾讯云（Ubuntu 24.04，`ssh dramatis`，sudo 免密）——**地址与凭据只在 `deploy/LOCAL-NOTES.md`（gitignore）**，不要写进任何仓库文件 |
| 服务器上的服务 | `systemctl status dramatis-sync`；`curl -s 127.0.0.1:8787/health`；`journalctl -u dramatis-sync`；数据在 `/var/lib/dramatis-sync/sync.db`，备份在 `/var/backups/dramatis` |
| 改完服务端怎么上线 | 本机 `pnpm build:sync-server` → `scp -r tools/sync-server/dist dramatis:/tmp/dist-new` → 服务器上 `sudo rm -rf /opt/dramatis-sync/dist && sudo mv /tmp/dist-new /opt/dramatis-sync/dist && sudo systemctl restart dramatis-sync` |
| SSH/SCP 的坑 | Windows 下私钥必须先 `icacls <key> /inheritance:r /grant:r "<账户>:(R)"`，否则 OpenSSH 报 "bad permissions" 直接忽略；`scp`/`ssh` 一律要用**提权**执行，否则读不到 `~/.ssh/config`（表现为 `Could not resolve hostname dramatis`） |
| 真模型验证 | 两条路：应用里直接聊（Key 在浏览器配置里），或 `pnpm --filter @dramatis/core test prompt-samples --silent=false --disableConsoleIntercept` 生成提示词、贴进 DeepSeek 网页版 |
