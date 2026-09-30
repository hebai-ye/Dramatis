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
| 默认系统提示（「基本规则」）与无限制模式固定正文的正文与改法 | [ROLEPLAY-PROMPT.md](./ROLEPLAY-PROMPT.md) |
| 账号与同步怎么定、协议长什么样 | [SYNC.md](./SYNC.md) |
| 服务器管理台怎么安全地管密文空间 | [ADMIN-CONSOLE.md](./ADMIN-CONSOLE.md) |
| 架构与数据模型的原始设计 | [DESIGN.md](./DESIGN.md) |
| 每个文件是什么时候加的 | [FILE-LOG.md](./FILE-LOG.md) |
| 新会话怎么接手（可直接贴的提示词） | [HANDOFF-PROMPT.md](./HANDOFF-PROMPT.md) |
| 项目对外介绍与快速开始 | [../README.md](../README.md) |

## 新会话从这里接（2026-09-23）

### 2026-09-30：顺序 77 重抽/改归属的一批写入事务化（未 push、未部署）

来源是 2026-09-26 深度审计的存储原子性条目，2026-09-30 在顺序 97 之后同一天做掉。动手前先只读勘查：全库只有一张 object store（`apps/web/src/lib/db.ts:543`，`keyPath: ['collection','id']`），逻辑集合靠 `collection` 字段区分（清单 `packages/core/src/storage/repository.ts:48-64`）；重抽与「改归属」各碰 4 个集合（messages / backgroundTasks / memories / instances），`EntityStore` 却只有单条 CAS、没有任何跨记录原语；同步没有 outbox，靠 `updatedAt > 水位线` 推，所以事务必须覆盖 `updatedAt` 盖章，否则改写会静默丢同步——**同步侧不用一起改**。

改法：`EntityStore` 新增**可选**成员 `transaction<T>(run: (scope: EntityStore) => Promise<T>)` 与 `withStoreTransaction`（`packages/core/src/platform/entity-store.ts:80` / `:109-113`，没实现就 `return run(store)`）；`apps/web/src/lib/db.ts` 的 `createIndexedDbEntityStore` 拆成「库连接来源」+「`createStoreFromSource(source, runTransaction?)`」，事务版开真 `readwrite` 事务、作用域内全走 `tx.store`、成功 `await tx.done`、出错 `tx.abort()`；`packages/core/src/platform/memory-store.ts:101-111` 的内存后端用快照回滚（注释写明不隔离并发事务）。新模块 `apps/web/src/lib/turn-write.ts` 把「改写消息 → 清这一轮任务幂等键 → 撤该轮记忆（软删 + `undoConsolidation`）→ 逐条还原情绪」收进一个事务，消息已不在库里时**什么都不撤**；`session.rewriteTurn` / `session.revertTurn` 走它并同时对齐界面快照。`useTurnRunner.ts` 的 `handleRegenerate` 与 `handleReassignMessage`（后者原来是**完全无 catch** 的三步写入）都换成这一个调用，只剩「重新排这一轮的分析」在事务外、失败发警告 `regenerate.rollback`；`rewriteTurn` 返回 `null` 才算整次失败。

测试新增 `apps/web/src/lib/turn-write.test.ts` 6 条（内存后端证明整批回滚、无 `transaction` 的后端退化成顺序执行、消息不存在时不动任何东西），`useTurnRunner.test.tsx` 夹具补 `session.rewriteTurn` 桩与 `analysisFails` / `rewriteReturnsNull` 开关。五项门禁：typecheck 0、lint `Checked 293 files` 0 error / 0 warning、test Core 73 文件 / 833 条 + Web 18 文件 / 82 条全过、build 0、build:sync-server 0。**IndexedDB 那段真事务在 Node 里没有测试基建（无 `indexedDB`、无 `fake-indexeddb`），浏览器里的原子性归 Codex 真机验**；本批**未 push、未部署**，细节与遗留见 [EVAL.md](./EVAL.md) 第八十九节。

### 2026-09-30：顺序 97 重抽只重生成被点的那一位（未 push、未部署）

用户 2026-09-30 拍板的语义：重抽**只换被点的那一位**，同一轮里其他角色的回复原样保留。以前（顺序 78 上线「一轮内多名角色作答」之后）一轮可以有两三个人接话，而重抽是「把这一轮的角色回复**全部**删掉再另起一条」——点最后一条会把前面那位刚说的话一起抹掉；而且那五步写入零事务、删除之后任何一步失败都不留退路，报错还会说成「重抽失败」，让用户以为回复没变。

改法（`apps/web/src/hooks/useTurnRunner.ts:977` 的 `handleRegenerate`）：`session.appendMessages` + 删除整轮 → **原地改写**那一条 `session.updateMessage(target.id, {…})`（`:1095`），id、位置、`createdAt` 都不变，只多一次 `updatedAt` 盖章供同步推送；同轮其他人的回复一个字不碰。重抽的那位拿到的历史与**发送路径完全一致**：`historyForTurn` = 这一轮之前的历史 + 同轮排在他前面的消息（`:1014-1019`），同轮已经有人说过话时 `playerInput` 留空（玩家那句已在历史里，不能塞两遍，`:1050`），`mentionText` 仍是玩家那一句。该轮的后台写入照旧全部重算（清任务幂等键 → 回滚记忆与情绪 → 重新排分析），但后三步改成逐步收账：失败时只报「新回复已经换好了，但这一轮的后台记录没收拾干净：…再点一次重抽会把这一轮重新算一遍」（警告码 `regenerate.rollback`，`:1142`），**不再冒充整次重抽失败**。入口限制不变——重抽按钮仍只挂在最后一条角色回复上，只是注释改成了准确理由（`apps/web/src/components/MainChat.tsx:486-490`）。**顺序 77 同日收口**：上面那句 `session.updateMessage` 与「后三步逐步收账」已经合并成 `session.rewriteTurn` 的**一个事务**，见上一节。

测试加在 `apps/web/src/hooks/useTurnRunner.test.tsx:480`（三条）：第二轮被重抽时第一条一个字没动且生成历史里看得到先开口的人；第一位被重抽时看不到同轮后面的人；回滚失败报警告而 `setError` 为空。五项门禁与真模型未验的边界见 [EVAL.md](./EVAL.md) 第八十八节。本批**未 push、未部署**。

### 2026-09-30：顺序 96 人设表达收敛（提示词层最小干预；未 push、未部署）

用户 2026-09-30 的反馈是两条**观察**（角色执着于人设、每轮都彰显；轮数越多越执着），所以先当假设查清再动手：只读分包审查 `packages/core/src/prompt/` 与 `packages/core/src/memory/`，加一份对 178 轮实录（上一次真实模型长跑的 transcript）的离线复算——纯文本分析、零模型调用，脚本在 `%TEMP%` 下、**不在仓库**。结论：① 人设确实每轮在场，而且是**唯一没有长度上限**的块（`description`/`personality` 全文进提示词）、`priority: 700` 只让位于规则层、预算榨干时才被压成 160 字——但缺口不是字数，而是**没有任何一条约束管「什么时候不该提人设」**（现有反重复只管动作／道具／同义句，跟人设有关的指令全是「加大力度」）；② 「记忆里不断强调人设」这一步不成立（抽取提示词的字段里没有性格／人设／态度／喜好／身份），但记忆回路确实自激（检索词含自己最近 6 条回复、视角条目逐轮回灌、`recallCount` 正反馈、`importance > 0.5` 永不参与合并）。

改动只碰提示词文字、三处：`packages/core/src/prompt/reply-style.ts` 新增 `PERSONA_RESTRAINT_RULE`（人设要挑场合／同一个设定点不要连着几轮反复说／不要为表现人设把话头从眼前的事上拽回自己）；`packages/core/src/prompt/assemble.ts` 把它并进 `reply-style` 块（label 改成「回答长度、反重复与人设收敛」），并在**不可丢弃**的指令块里紧跟「保持角色不跳出。」加一句同向的兜底；`packages/core/src/model/card.ts` 把卡预设那句「尽最大努力……疑问句上」降级成「需要玩家表态或做决定时才用问句，没什么可问的就自然收住」（保留「疑问句」「征求意见」两个词，顺序 89 的断言照旧）。测试加在 `packages/core/src/prompt/assemble.test.ts`（收敛规矩在块里 + 兜底句不可丢弃）与 `packages/core/src/model/card.test.ts`（含 `not.toContain('尽最大努力')`）。

顺带登记**顺序 97**：用户拍板重抽语义 = **只重生成被点的那一位、保留同轮其他人的回复**（现状会把同轮其他角色的回复删掉，`apps/web/src/hooks/useTurnRunner.ts:964`/`:988`/`:1066-1068`，且重抽按钮只挂在最后一条角色消息上）。

本批**未 push、未部署**（用户没要求）。五项门禁数字与「真模型、真机都没验」的边界见 [EVAL.md](./EVAL.md) 第八十七节。

### 2026-09-30：顺序 78 一轮内多名角色作答（已合入主线、已 push、已只重新部署前端）

顺序 78 的实现在分支 `codex/task-78-multi-speaker`（6 个提交 `f47a8fc` → `28282f4`，设计基线见 [TASK-78-MULTI-SPEAKER-DESIGN.md](./TASK-78-MULTI-SPEAKER-DESIGN.md)）上完成，2026-09-30 以 `--ff-only` 快进合入本分支（`637672f..28282f4`，27 文件 2396+/159-）。要点：合格名单仍由场景 `cast` + `presence: 'onstage'` + 角色卡决定（muted 不生成）；对话级「本轮最多回应人数」三档 1／2（默认）／3（`DEFAULT_MAX_SPEAKERS` / `HARD_MAX_SPEAKERS` / `speakerLimitOf`，老记录与脏值都退回 2，无需迁移）；句首称呼或 `@显示名` 的直接称呼必须参与，超过上限在玩家消息落盘**之前**明确拒绝（不截断、不静默漏人）；导演（`buildIntentPlanMessages` + `pickPlannedSpeakers`）一轮只调用一次并给有序名单，导演关闭／熔断／超时／空名单一律由 `selectTurnSpeakers` 退回规则保底，**任何路径都至少一位**；每人生成一次、各自记账、同 `turnId` 顺序落盘；顺序 91 的流式交接升级为按 messageId 的屏障（`waitForStreamHandoff` / `acknowledgeStreamHandoff`），多人连续流不会互相清掉；网页版桥接改成逐人贴回（首份有效回贴前不落半轮）；用量面板新增「最近一轮」。**本批已 push、已只重新部署前端**：`4ee7edd` 推到 `origin/main`（`637672f..4ee7edd`）；`git log 637672f..4ee7edd -- tools/ packages/core/src/sync/` 为空 ⇒ 同步服务端源码没变，只换网页。网页由那台 Windows 正式机的 Caddy 从 `D:\Dramatis\web\dist` 提供（腾讯云旧机只做 HTTPS 入口与隧道），换版后线上首页 200 / 1366 B 且引用 `assets/index-aDLBA72A.js`（200 / 676240 B，SHA-256 与本地构建逐字节相同）、`index-BDv279kC.css` 42459 B、`sw.js` 9071 B、`/sync/health` 200 `{"ok":true}`（同步服务未重启）；旧网页目录留成 `D:\Dramatis\web\dist.bak-20260930-005711`。真机与真实模型下的观感、成本与串线归 Codex，见 EVAL 第八十六节。

### 2026-09-27：顺序 91 两个体验反馈 bug 已修（已 push 并只重新部署前端）

用户 2026-09-26 反馈的两条都落地了。① 场景设定输入区在笔画输入法下逐笔落库：`SceneDialog.tsx` 那个 `textarea` 漏了顺序 63 的草稿 hook，现在改成 `useDraftField`（停手 300ms 或失焦才落库、输入法组合期一个字节都不写），关闭弹窗的每一条通路都先 `flush()`。② 流式结束到消息出现之间的空窗与卡顿：落盘后不再同步清掉流式副本，改成 `handoffStreamState('main', line.id)`，`StreamingBubble` 一直画到消息列表里真的出现这条消息，并在同一次提交里收掉自己；同时把 `busy` 从 `MessageList`/`MessageItem` 的 prop 改成 context（新增 `apps/web/src/lib/busy-context.ts`），开关翻转不再让整张消息表重画（顺序 62 量到的「一轮 4 次整表重画」里有两次是它）。五项门禁与未验证项见 EVAL 第八十五节。`cff5149` 已推送 `origin/main`（`f3be8c4..cff5149`）；本批没动 `tools/` 与 `packages/core/src/sync/`，所以**只重新部署前端**：线上首页 200 / 1366 B 且引用新的 `assets/index-C5Ydp3Hw.js`，该 JS 200 / 659406 B，`/sync/health` 200，旧目录留为 `/var/www/dramatis.bak-20260928-202632`，同步服务未重启。真机笔画输入法与真实模型观感仍归 Codex。

### 2026-09-27：顺序 95 手机桌面图标近景修正

用户在手机安装后发现图标主体过小。已确认上一版直接缩放整张 1254 × 1254 母版，且 maskable 又缩至 90%，导致角色在约 60 像素桌面图标里难以辨认。本轮改为从原图裁出 850 × 850 近景，母版保持不变；iPhone 使用新的 180 像素 Apple touch icon 路径，Android manifest 使用新的普通和 maskable 图标路径，Service Worker 升 v4。多组近景与圆形裁切预览已比较。修复提交 `8e16b90` 已推送 `origin/main` 并仅部署网页，旧目录留在 `/var/www/dramatis.bak-icon-focus-8e16b90`；公网首页、新图标、manifest、Service Worker 与同步健康接口均返回 200。真实手机删除旧快捷方式并重新添加后的桌面外观仍待用户核对；验收见 EVAL 第八十四节。

### 2026-09-27：顺序 94 用户定稿应用图标

用户选择自己提供的 1254 × 1254 PNG 作为最终应用图标。母版原样保存于 `apps/web/public/brand/icon-master.png`，普通尺寸、favicon 与 Android maskable 图标从它派生。maskable 只做启动器安全区域与白色边缘适配。Service Worker 缓存版本升为 v3，确保同路径旧图标被替换。`8e6551d` 已推送 `origin/main` 并仅部署网页静态产物；线上母版 SHA-256 与用户附件一致，首页、图标、Service Worker、同步健康接口均返回 200。旧网页留在 `/var/www/dramatis.bak-icon-8e6551d`，同步服务未更新。资源约定见 `docs/APP-ICON-SELECTED-2026-09-27.md`；门禁及真机验收边界见 EVAL 第八十三节。

### 2026-09-27：顺序 93 已推送并完成前端部署

用户批准的“叙事剧场”主阅读界面、SVG 图标与微动效，以及浅色/深色精修（各自主色调不变）已随 `84690e8` 推送并完成前端部署。整分支审阅随后发现深色亮蓝主按钮白字对比度不足；`8cf9419` 将该主题的按钮字改为深色，保留原蓝，复跑五项门禁后再次推送并仅替换线上网页静态产物；同步服务端未重启、未更新。最终线上首页、JS `index-B0wKkkiW.js`、CSS `index-BDv279kC.css` 与 `/sync/health` 均返回 200，首页引用与文件大小和本地构建一致。旧网页目录留作带时间戳的备份。线上浏览器已打开现有真实对话并观察主阅读布局、动作与角色消息；未修改用户数据或发起模型调用。五项本地门禁及尚待真机验证的项目见 EVAL 第八十二节。

### 2026-09-27：顺序 93 界面视觉优化启动（隔离分支，未上线）

用户已批准“叙事剧场”视觉方案与新增的 SVG 图标、微动效范围，并确认按实施计划推进。方案见 `docs/UI-VISUAL-OPTIMIZATION-PROPOSAL-2026-09-27.md`，逐批执行清单见 `docs/superpowers/plans/2026-09-27-ui-visual-refresh.md`。当前工作在隔离分支 `codex/ui-visual-refresh`，不影响 `main` 或线上。

基线 `pnpm test`：Core 70 文件 / 809 条、Web 13 文件 / 45 条全绿。本地 Vite 预览已在隔离工作区正常启动；浏览器检查了默认酒馆、浅色、深色主题，并创建了不含真实模型调用的“视觉验收样例”世界。第一批主题语义令牌、字级/焦点与共用 SVG 已提交（`d1c76c3`）。第二批输入区加号开合与菜单反馈已实现；键盘 Enter、Esc、焦点和 `aria-expanded`、桌面及 390px 浏览器布局已检查，门禁与提交结果见 EVAL 第八十二节。下一步制作主对话桌面/手机样例供用户审阅，然后推广到辅助界面。尚未 push、部署或做手机软键盘/安全区真机验收。

第三批主对话的桌面/390px 手机独立视觉样例已放在 `docs/visual-samples/main-chat-prototype.html`，可切换多人长对话、空状态、亮背景和输入焦点。浏览器预览检查与界限见 EVAL 第八十二节；**等待用户审阅样例**，然后再把阅读布局批量落到产品组件。第二批提交为 `73e2973`；本分支仍未 push 或部署。

用户已批准上述样例并要求本版本 push、部署，同时优化浅色和深色但保留主色调。主阅读界面现已把层级、消息、动作旁白、背景遮罩、输入区及空状态落实到产品；浅色 `--accent: #4564de`、深色 `--accent: #8fa8ff` 均未改。共用 SVG 已接入桌面栏开合、世界树、设置分类和运行时页签。浏览器已检查三主题空状态、390px 手机、768px 窄窗、1440px 桌面与 844×390 横屏的页面宽度和菜单位置，详见 EVAL 第八十二节；真实多人长对话、手机软键盘/安全区与真机触摸仍待实测。此段为**上线前状态**，推送和部署结果以本页后续记录为准。

### 2026-09-26：整批上线（push + 重新部署服务端与前端；用户裁定「连着一起上」）

本页下面各节里写的「未 push、未部署」「线上仍是旧服务端」**以本节为准**：到 `aa4f724` 为止的全部提交都已上线。

- **push**：`git push origin main` → `789f744..aa4f724`，之后 `git status -sb` 是 `## main...origin/main`（无差异）。
- **服务端**：`/opt/dramatis-sync/dist` 换成新构建（旧目录留成 `dist.bak-20260926-183042`），`backup.mjs` 换成带审计 C16 `keep >= 1` 校验的版本（`start.mjs` 与线上一致、没变），`deploy/` 目录刷新；
  跑 `deploy/install-server.sh` 把 systemd 单元换成加固版（新增 `ProtectSystem=strict`、`ProtectHome=true`、`PrivateDevices=true`、`ProtectKernelTunables/Modules/ControlGroups`、`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`、`RestrictSUIDSGID`、`LockPersonality`、`UMask=0077`；旧单元只有 `NoNewPrivileges/PrivateTmp/ProtectSystem=full`），
  `systemctl restart dramatis-sync` 后 `/health` 正常、日志无报错。
- **数据库迁移**（重启时自动、幂等）：`spaces` 多出 `epoch`（4 个空间都拿到 16 字节随机值），`heads` 多出 `record_count`/`byte_count` 并按 `records` 回填（40/104263、9/7599、9/7599、583/1228072）；
  **数据行数不变**（4 空间 / 641 记录）。
- **nginx**：装 `/etc/nginx/snippets/dramatis-security-headers.conf`（审计 A15：HSTS、`X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options`、`Permissions-Policy`、CSP **Report-Only** 灰度），server 级与 `location = /sw.js` 各 include 一次；
  `location /sync/` 加 `client_max_body_size 8m`；保留 `listen 8443 ssl http2;`（nginx 1.24 不认示例里的 `http2 on;`）。`nginx -t` 通过后 reload，线上 `/` 与 `/sw.js` 都能看到全套安全头。
- **网页**：`/var/www/dramatis` 换成新构建（旧目录留成 `dramatis.bak-20260926-183139`）：`assets/index-9bjwPXDa.js`（649.25 kB）、`assets/index-aDHWLtbR.css`、144 张立绘（`/portraits/`、`/portraits/thumbs/`、`/portraits/avatars/`）、`brand/icon-master.png`、新图标；
  `sw.js` 从 6284 B 换成 8852 B（`CACHE = 'dramatis-shell-v2'`、`STATIC_PREFIXES` 含 `/portraits/`、`/brand/`）。
- **备份**：部署前手动快照 `/var/backups/dramatis/sync.db.2026-09-26T10-29-24-733Z.bak`（1 814 528 B）；nginx 站点配置留了 `dramatis.bak-20260926-182924`（部署前）与 `dramatis.bak-headers-20260926-183113`（加安全头前）；每 6 小时的 cron 备份（`/etc/cron.d/dramatis-sync`，以 `dramatis` 用户跑）照旧。
- **没验的**：真机 / 真模型一律没动（归 Codex）；`manifest.webmanifest` 的 MIME 仍是 `application/octet-stream`（nginx 的 `mime.types` 里没有 `webmanifest`，本轮没改）；CSP 仍是 Report-Only，要灰度几天再切正式。
- **教训**：**别把 `deploy/` 整个 `scp` 上服务器**——本轮把 `deploy/LOCAL-NOTES.md`（本地私有、含敏感内容）一起拷上去了，发现后已从服务器删除，并把旧的 `deploy.old-*` 备份目录一并清掉。

### 2026-09-26：顺序 92 落进 main（无限制模式的正文改成「仓库里固定一份」——用户改口径）

- **来源**：用户当天改了口径。原话：「无限制模式的预设词是固定的，是我在文件中存储的，并非本机独有，是所有的无限制模式都是这一份词，如果你找不出那么便在一个新的地方存储他，为我指出应在文件的哪里复制粘贴。」先前（顺序 89/68a）把这份正文当**用户数据**存本机 `meta`，理由是「公开托管的静态站点，写进源码就等于公开」；用户这次明确要求它**是所有对话共用的一份固定正文**，并选了「仓库里指定一个文件给你粘（最省事，但会泄露）」这个方案——**接受正文进公开产物**，这是用户本人的新裁定。
- **先查再改**：全树（含 gitignore 的 `deploy/LOCAL-NOTES.md`）都搜不到这段正文；它此前只活在**浏览器自己的 IndexedDB** 的 `meta` 键 `modes.unlimitedPrompt` 里——所以换设备/清库就没了，恰恰不是用户说的「并非本机独有」。
- **正文位**：新建 **`apps/web/src/prompt/unlimited-preset.txt`**（**整份文件就是正文**，不加注释/标题行；本批落进 main 时是空文件，**用户当天稍后已粘上**：9059 B / 102 行、`trim()` 后 3325 字符，见下面「顺序 92 补」一节），`apps/web/src/prompt/unlimitedPreset.ts` 用 Vite 的 `?raw` 读成字符串导出 `UNLIMITED_PROMPT = raw.trim()`；`apps/web/tsconfig.json` 已有 `"types": ["vite/client"]`，`?raw` 自带类型。
- **两个入口都取同一常量**：`apps/web/src/App.tsx`（`useUnlimitedPrompt(db)` → `UNLIMITED_PROMPT`，菜单只用来判断「配没配好」）与 `apps/web/src/hooks/useTurnRunner.ts`（原来的 `await repository?.getMeta<string>(META_KEYS.unlimitedPrompt)` → `UNLIMITED_PROMPT`，再进 `AssembleInput.unlimitedPrompt`）。core 侧契约不变：`assemblePrompt` 只认调用方给的字符串，`buildUnlimitedModeBlock`（`UNLIMITED_BLOCK_ID = 'unlimited'`、priority `system`、`droppable: false`）照旧；模式关或正文空就不加块。
- **撤掉旧通路**：**删除** `apps/web/src/lib/useUnlimitedPrompt.ts`（连 `UnlimitedPromptApi`）；`packages/core/src/storage/repository.ts` 的 `META_KEYS.unlimitedPrompt`（值 `'modes.unlimitedPrompt'`）整条删掉——本机库里残留的值从本批起既不读也不写，只是无用数据（不做清理）。`useTurnRunner` 里那个只为它存在的 `repository` 变量与依赖数组项一并删掉（lint 的 `useExhaustiveDependencies` 会点出来）。
- **界面**：照旧只留**对话级**勾选框，不渲染正文、**不显示字数**、无编辑口；文案从「已配置（内容不在此显示，也不参与同步）」改成「已随应用一起固定提供（正文不在此显示）」，空正文时是「尚未配置（应用里那份正文还是空的）」。
- **文档改写**：`docs/ROLEPLAY-PROMPT.md` 的「当前对话的额外提示：无限制模式」一节按新事实重写（原文写着「只存在你自己的浏览器里」「别人打开这个站点看不到它」，与本批相反）；`packages/core/src/prompt/{unlimited,assemble}.ts` 与 `prompt/assemble.test.ts` 的注释改口；`docs/TASKS.md` 顺序 92 行 + 处理表，并给顺序 89 那条「换设备后无法再配置」的遗留标注**已解**。
- **五项门禁全绿**：typecheck ✓、lint ✓（281 文件，0 error / 0 warning）、test ✓（Core **70 文件 / 809 条**、Web 13 文件 / 45 条）、build ✓、build:sync-server ✓。第一轮 lint 报 1 个 `useTurnRunner.ts` 的 `useExhaustiveDependencies`（`repository` 成了多余依赖），删掉后重跑干净。
- **遗留**：① 正文会进公开产物 `assets/index-*.js`（实测过一次：填进去包体涨约 8.95 kB），是用户接受的取舍，要保密得走服务端下发或加密同步（TASKS 顺序 68b）；② 仓库里那份文件当时是空的（用户当天稍后已粘上，见下一节）；③ 老库里那份旧副本不被清理（无害）；④ 真机没验。**本批当时未上线**（要粘贴正文并重新构建后才谈上线）；push 状态见下面两节——到 `1cf1eab` 为止的 6 个提交都已 push。

### 2026-09-27：顺序 92 补——无限制模式正文粘贴完成、前端单独上线、**push 完成**（`a1dc78a..1cf1eab`）

- **改动**：用户把固定正文粘进 `apps/web/src/prompt/unlimited-preset.txt`（9059 B / 102 行，`trim()` 后 3325 字符）。它是 `?raw` 数据文件，没有代码语义改动，走的是同一批顺序 92 的通路：`apps/web/src/prompt/unlimitedPreset.ts` → `apps/web/src/App.tsx` 与 `apps/web/src/hooks/useTurnRunner.ts` → `AssembleInput.unlimitedPrompt`。
- **提交**：`14d1b96`「顺序 92 补：填入无限制模式的固定正文（用户粘贴完成）」（1 文件 / 102 行新增）。仓库 `.gitattributes` 是 `* text=auto eol=lf`，本机工作区那份是 CRLF（`git ls-files --eol` = `i/lf w/crlf`），与仓库里其它文本文件一致。
- **五项门禁全绿（重跑）**：typecheck ✓、lint ✓（281 文件，0 error / 0 warning）、test ✓（Core **70 文件 / 809 条**、Web 13 文件 / 45 条）、build ✓、build:sync-server ✓。构建产物 `apps/web/dist/assets/index-BBkcTtuN.js` **655.34 kB / gzip 209.43 kB**（顺序 90 的 `index-D2eEP_2v.js` 是 646.62 kB，差 +8.72 kB 就是这段正文），css 仍是 `index-CmI7ar9V.css` 38.28 kB；另外用「正文首行是否出现在产物里」核对过，`True`（没有把正文内容写进任何文档）。
- **上线范围**：**只重新部署前端**。`git log aa4f724..HEAD -- tools/ packages/core/src/sync/` 为空——自上次整批上线（`aa4f724`）以来同步服务端源码没动过，所以 `/opt/dramatis-sync/dist` 与服务不动（health 复查仍 `{"ok":true}`，uptime ≈ 6 天 10 小时）。网页 `scp -r apps/web/dist` 到 `/tmp/dist-web-new`（25 MB）后按「先确认新的到齐 → 把旧的改名 → 再换」换成 `/var/www/dramatis`（`chown root:root` + `chmod -R a+rX`），旧目录留成 `/var/www/dramatis.bak-20260927-005736`。
- **线上自查**（本机直连站点，`:8443`）：首页 200 / 1342 B 且引用 `assets/index-BBkcTtuN.js`；该 JS 200 / **655 347 B**（与本机构建一致）且**含正文首行**；`/sync/health` 200 `{"ok":true,"uptimeMs":23209408}`。真机 / 真模型仍未验（归 Codex）。
- **文档对账 + 提交**：上线后另起一个提交 `1cf1eab`「顺序 92 补：前端单独上线 + 文档对账」，只改文档 5 个文件（50+/14-：本页、EVAL 第八十一节、TASKS、FILE-LOG、ROLEPLAY-PROMPT）；五项门禁重跑全绿且**构建产物哈希可复现**（仍是 `index-BBkcTtuN.js`），所以文档提交**不需要重新部署**。
- **push 完成**：先后失败 3 次——`git push origin main` 报 `Failed to connect to github.com port 443 via 127.0.0.1`（`http.proxy`/`https.proxy` = `http://127.0.0.1:7897`，而本机 **Clash Verge 的 GUI 没在跑**，只有 `clash-verge-service` 服务进程），绕代理直连报 `Recv failure: Connection was reset`；我把 Clash Verge 从 `D:\Work\Clash Verge\clash-verge.exe` 拉起来（`verge-mihomo` 随之启动，7897 开始监听）后，普通 `git push` **还是** `Recv failure: Connection was reset`（但 `curl -x http://127.0.0.1:7897 https://github.com` 是 **200**、`git ls-remote origin` 是 **0**，说明代理和远端都通、卡在 push 的 HTTP 层），最后 `git -c http.version=HTTP/1.1 -c http.postBuffer=524288000 push origin main` **成功**：`a1dc78a..1cf1eab  main -> main`，`git rev-list --count origin/main..main` = **0**。已把 `http.version=HTTP/1.1` 写进本仓库本地配置（`git config --local`，未改全局）。**这一节的「push 完成」以本行为准**：自上次上线的 `a1dc78a` 起攒下的 6 个提交（`e63baf0`、`1a4779d`、`49804d7`、`00b8f5d`、`14d1b96`、`1cf1eab`）现在都已到远端；这次「改口」的提交（`4769268` 起）也跟着一起 push，**`origin/main` 以远端为准**（本机 `git rev-list --count origin/main..main` = 0）。



### 2026-09-26：顺序 90 落进 main（体验反馈第二批：删掉卡上的场景设定 / 开场白 / 高级字段 / 对话示例，「本场场记」整块撤下，编辑区不再滑动）

- **来源**：用户当天体验反馈第二批。原话要点：「请将开场白删除，将场景设定删除，高级字段(角色卡中的)以及对话示例删除。并且玩家可编辑的各区域(如角色卡的各种可编辑区域，不止角色卡)不可滑动」「面板中的本场场记如果展现出来过于繁杂请不显示」。三条裁定：字段裁剪 = **「彻底删除已有数据」**；不可滑动 = **「两个都要」**（编辑区随内容自动长高 **+** 拖动隔离）；本场场记 = **「整块不显示」**。世界书与各模式的高级字段**不在**删除清单里（用户明确写「角色卡中的」）。
- **卡上删掉 7 个字段**（`packages/core/src/model/card.ts`）：`scenario`、`firstMessage`、`alternateGreetings`、`exampleMessages`、`systemPrompt`、`postHistoryInstructions`、`creatorNotes`；`resolveCardSystemPrompt()` 一并删掉。剩下的名字 / 昵称 / 描述 / 性格 / 作者 / 版本 / 标签 / 世界书 / 来源照旧。「基本规则」那一块固定由 `DEFAULT_CARD_SYSTEM_PROMPT` 提供（顺序 89 换上的那套用户预设），**卡不再各带一份系统提示**——这正是「所有对话都强制用同一套预设」的落地方式。
- **消费端全部断开**：`session/turn.ts` 删掉整段自动开场（`MAX_AUTOMATIC_GREETING_LENGTH = 380`、`GREETING_FIELD_LABELS`、`normalizeGreetingLine`、`prepareAutomaticGreeting`、`createGreetingMessage`，文件从 ~290 行缩到 205 行），`apps/web/src/lib/session.ts` 删掉 `buildGreetings` 与两处调用——新对话不再自动生成角色开场消息，白纸由用户先开口；`render/segments.ts` 删掉 `normalizeCardExample()`、`SPEAKER_LABEL`、`normalizeGreetingBreaks()`；`prompt/assemble.ts` 的人物块不再拼「对话风格示例」；`session/setup.ts` 的世界场景摘要改成空串。
- **彻底删除已有数据**：`SCHEMA_VERSION` 12 → **13**，迁移遍历 `cards` 用 `stripRemovedCardFields`（新增在 `model/card.ts`，配 `REMOVED_CARD_FIELDS`）剥掉 7 个键，**有意不盖 `updatedAt`**——那不是「用户改过这张卡」，盖上本机时间会让 LWW 把一份废弃数据当成新改动推给别的设备；`stripRemovedCardFields` 对「本来就没有这些键」的记录返回 `null`，迁移据此跳过写入（幂等）。
- **三条复活通路一起堵**：① 写卡唯一通道 `repository.saveCard`（界面编辑、管理员草稿采纳、封存导入都走它）；② 同步落库口 `putSyncRecord`（对面那台没升级的设备推来的老卡）；③ 同步出口 `listSyncRecords`（保证含废弃字段的卡不再被推到服务端）。导入层 `compat/sillytavern/card.ts` 的 `KNOWN_DATA_KEYS` 里那 7 个 key **必须留着**——删了反而会把原值扫进 `extensions`「复活」。
- **界面**：`CardDesigner.tsx` 删掉场景设定 / 开场白 / 备选开场白 / 对话示例 / 系统提示 / 后置指令与整个「展开高级字段」折叠块（作者 / 版本 / 标签 / 来源改为直接可见）；`CastDetail.tsx` 删「场景：」一行；`SideChat.tsx` 草稿预览从「开场白」改成看「设定」（`description`）；`ScenePanel.tsx` 把「本场场记」整块撤下（`.recap`/`.recap-text` 样式一并删）——**场记仍在后台照常整理、仍进提示词**，「场记覆盖后收起远处原文」那个模式开关也照旧。
- **可编辑区域不再滑动（两个都要）**：`apps/web/src/styles.css` 的全局 `textarea` 改成 `field-sizing: content`（随内容长高）+ `overflow: hidden`（不出现内滚动条）+ `resize: none`，拖动隔离用 `overscroll-behavior: contain` + `touch-action: pan-y`；聊天输入框是唯一例外（高度由组件按 `scrollHeight` 量、到 200px 上限要能内滚），在那条规则里退回 `field-sizing: fixed`。
- **测试**：core 侧改了 21 个文件（12 个新增/改写用例文件 + 9 个夹具删行）；新增 16 条：`model/card.test.ts` 断言 7 个字段都不在卡上、`compat/sillytavern/card.test.ts`（带全部 7 键的卡解析后 `extensions` 仍是 `{}`）、`admin/tools.test.ts`（5 个字段不再进工具声明、模型还在传会被点名为「不认得的参数」）、`storage/repository.test.ts` +5（v13 迁移剥字段且其余原样、`saveCard` 剥、`putSyncRecord` 剥、`listSyncRecords` 剥、干净新卡不被无谓重写）。
- **五项门禁全绿**：typecheck ✓、lint ✓（281 文件，0 error / 0 warning）、test ✓（Core **70 文件 / 809 条**、Web 13 文件 / 45 条；比顺序 89 少 11 条是删掉了开场白相关用例、多 5 条是 v13）、build ✓（`dist/assets/index-D2eEP_2v.js` 646.62 kB / gzip 204.15 kB、css `index-CmI7ar9V.css` 38.28 kB）、build:sync-server ✓。（第一轮 lint 出 5 个 format error + 4 个 warning，全在本批改过的行上，`biome check --write` 就地修好。）
- **遗留**：① 更早版本导入的卡可能把同名副本留在 `extensions` 里，v13 只剥顶层键、没动 `extensions` 内部；② 管理员工具不再收这 5 个字段，模型再传会被回显为「不认得的参数」（旧草稿里的字段在采纳时被 `saveCard` 顺手剥掉、不报错）；③ 导入老卡后新对话是空白的（用户要的正是删开场白，属预期）；④ `field-sizing: content` 需要 Chrome 123+，不支持的浏览器只是「不自动长高」；⑤ 顺序 89 的四条遗留仍在（无限制提示词换设备后无法重配、负好感不能拖、迁移只提「未动过」的关系边、真机没验）。**本批未 push、未部署**（内核 + 界面改动，已部署的旧产物不受影响，跟着下次上线走）。

### 2026-09-26：顺序 89 落进 main（用户体验反馈第一批：初始好感 40% + 手动滑杆 + 各模式真的落到提示词 + 默认系统提示换成用户的系统预设）

- **来源**：用户当天的一批体验反馈。原话要点：「角色对用户初始好感为零（增加好感较困难），交流充满敌意」→ 要**初始好感 40**、且**用户能手动调整好感**；「加号里的各种模式无作用」→ 模式要真的落到 prompt 里，「尤其是无限制模式」；无限制模式的词用户**已经设定好**，要求**不可更改**、**不可阅读（商业机密）**。两条相关裁定：老对话里的好感**也要**一起提上来（自填「也要」）；默认系统提示换成用户的系统预设时「**保留引擎写法，预设其余内容照收**」。
- **好感 0.4 一处常量、三处同一口径**：`packages/core/src/model/instance.ts:37` 新增 `INITIAL_PLAYER_AFFINITY = 0.4`；`session/setup.ts` 建实例时给玩家的关系边用它；`memory/affect.ts` 的 `ensureRelationship` 补边时 `target === PLAYER ? 0.4 : 0`（**只有对玩家**）；迁移 **v12**（`SCHEMA_VERSION` 11 → 12）只动 `target === player && affinity === 0 && history.length === 0` 的边——涨过、跌过、被拖过滑杆的都有 history，所以一次升级不会抹平用户自己养出来的关系；改动会盖 `updatedAt`（同步集合按 LWW 比时间戳）并追加一条可撤销的 history（理由写明「顺序 89：初始好感由 0 提到 40」）。
- **手动调整**：`memory/affect.ts` 新增 `setRelationshipField(instance, field, value, meta)`——按维度夹紧（`tension`/`fear` → `[0,1]`，其余 → `[-1,1]`）、**不受单轮 `MAX_DELTA_PER_TURN` 约束**、写一条「手动调整」的 history、**值没变就返回同一个对象**（调用方据此跳过写库与重建快照）；web 侧新增 `session.setRelationship`，角色详情面板加一根 0–100% 滑杆（拖动只改草稿、停手 300ms 落库一次）。界面按百分比显示（0.4 → 40%）。
- **各模式落到提示词**：`prompt/assemble.ts` 的 `describeModes` 补齐。无限制模式开着时先出一条「上面那段无限制提示词是本轮的最高约束，与其它模式和旧规则冲突时以它为准」，并且**`playerFirst`/`silent` 两条本轮不再输出**（「静默＝不要说话」与「主动推进剧情」互相矛盾，两条一起发等于让模型抽签）；`historyMode` 为 `recap-aware` 时新增一条「场记」指令。`replyLength` 已有自己的 `reply-style` 块、`intentFirst` 是生成前那次便宜调用而非给模型的约束，两者**故意不重复**。
- **默认系统提示换成用户的系统预设**：`packages/core/src/model/card.ts` 的 `DEFAULT_CARD_SYSTEM_PROMPT` 整段替换（它是「基本规则」块的内容来源，直接决定每轮语气与格式）。**唯一改动**是格式段按引擎写法（动作行以 `#` 开头、对白不加引号），其余逐条照收。预设里那句「在本次对话中，对于空毁灭世界的描写多一些」判定为**误贴进预设的示例**，没有收进默认提示词。
- **无限制模式只留开关**：`MainChat.tsx` 删掉粘贴框、「保存提示词」按钮与本地草稿 state，**连字数也不显示**，只说明「已配置（内容不在此显示，也不参与同步）/ 尚未配置」。正文照旧由 `App` 从本机库（`META_KEYS.unlimitedPrompt`）读出后注入装配（`UNLIMITED_BLOCK_ID`、priority `system`、`droppable: false`）——它从来没进过代码或网页包，「不可阅读」本来就成立，本批把界面显示口子也堵掉。顺手改正了那句过时注释（写成「提示词住在代码里的常量」，实际是用户本机数据）。
- **测试**：新增 **19 条**——`memory/affect.test.ts` +7（补边对玩家 0.4、对别人仍是 0、手动调整写记录且不受单轮上限、四维夹紧、值没变返回同一对象、好感不参与情绪褪色、手动调整可撤销）；`session/setup.test.ts` **新增** 2 条；`storage/repository.test.ts` +4（v12 三种情况 + 重复跑不越提越高，并把钉死迁移清单的断言补成 `[10, 11, 12]`）；`model/card.test.ts` +3；`prompt/assemble.test.ts` +3（含「新实例的初始好感真的进到提示词」）。
- **五项门禁全绿**：typecheck ✓、lint ✓（281 文件，0 error / 0 warning）、test ✓（Core **70 文件 / 815 条**、Web 13 文件 / 45 条）、build ✓（`dist/assets/index-BKXw5gyp.js` 653.78 kB / gzip 206.43 kB、css `index-aDHWLtbR.css` 38.39 kB，500 kB 警告是既有项）、build:sync-server ✓。（第一轮跑出 4 个 lint error，全在本批改过的行上：两处 import 排序、两处行宽，`biome check --write` 就地修好。）
- **遗留**：① 换设备或清库后**没有入口再配置无限制提示词**（入口按用户要求撤掉，而正文只在本机 IndexedDB、不参与同步）——要不要临时加回等拍板；② 负好感只能看不能拖（滑杆 0–100%，剧情推到负数时标签显示负数、滑杆停在 0）；③ 迁移只提「从未动过」的关系边；④ 真机/真模型没验（新预设与 0.4 起点的实际效果）归 Codex。**本批未 push、未部署**（内核 + 界面改动，已部署的旧产物不受影响，跟着下次上线走）。

### 2026-09-26：顺序 88 落进 main（审计 B10 流式失败边角 —— 58 条里最后一条 ⬜）

- **来源与处理**：B10 在顺序 86 时故意不碰（`a6adfa` 的 worktree 里有未提交的 `packages/core/src/provider/openai-compatible.ts` + 未跟踪的新测试）。那条分支的提交已随顺序 82 进 main（`5014509`），脏改动一直没提交；顺序 84/85 合完、整批上线之后挡它的条件解除，本批把**那两份文件取回 main**（不是 merge，那条分支上没有这次提交），逐条对照审计的 5 个点审校，并补了 4 条测试。
- **改法**：非流式回退改成先 `res.text()` 再 `JSON.parse`（非 JSON 与 `{error:…}` 体都抛 `ProviderError`，200 但 `choices[0]` 缺失也算失败、不落空回复）；`assertComplete` 只拦 `length`/`max_tokens`/`content_filter`/`insufficient_system_resource`/`aborted`（比较前统一小写去空白），其余 `finish_reason`（`eos`/`end_turn`/大写 `STOP` 等）记一条警告后按正常完成处理；`iterateSse` 的 `finally` 先 `await reader.cancel()`（吞异常）再 `releaseLock()`，上层提前退出不再让服务端继续生成计费；新增 `dataPayloadsOf()` 兼容规范的「一个事件多行 `data:`」与老网关的「单换行、每行一个 JSON」；`ProviderConfig` 新增 `onWarning`（缺省 `console.warn`，与 `apps/web/src/lib/session.ts:97` 的既有做法一致）。
- **空回复兜底不重复加**：三处落库点本来就拦了——`apps/web/src/hooks/useTurnRunner.ts:629`（主生成）、`:809`（重抽）、`apps/web/src/lib/admin.ts:304`（世界管理员空回复给占位句）。
- **测试**：新增 `packages/core/src/provider/openai-compatible.test.ts` **16 条**（非流式错误体 / HTML 错误页 / 200 无 choice / 流里夹 error / 未知 `finish_reason` 只警告（`eos`、`end_turn`、`STOP`、`stop_sequence`、非流式）/ `LENGTH` 与 `max_tokens` 拦下 / 多行 `data:` 两种写法 / 提前 `break` 后 `cancel` 被调用），与调用方视角的 `tools.test.ts`（14 条）一起跑。
- **五项门禁全绿**：typecheck ✓、lint ✓（280 文件，0 error / 0 warning）、test ✓（Core **69 文件 / 796 条**、Web 13 文件 / 45 条）、build ✓（`dist/assets/index-DWZKOBjr.js` 650.20 kB / gzip 204.91 kB，css `index-aDHWLtbR.css`）、build:sync-server ✓。
- **遗留**：`onWarning` 目前只落到 `console.warn`，**没接到界面顶部提示**（`useNotices`）→ 用户看不到「模型以未识别状态结束」；取回的那份改动在原 worktree `.claude/worktrees/agent-a6adfa051fc0cc2bd` 里**仍未提交、仍在原处**；各家网关 `finish_reason` 的真实取值、`cancel()` 是否真让服务端停止计费，都要真机/真模型验（归 Codex）。**本批未 push、未部署**（内核改动，已部署的服务端与网页产物不受影响）。

### 2026-09-26：顺序 84 / 85 合入 main（审计第三、四批全落）+ 代提交另一条会话的成果

审计那 58 条现在**全部进了 main**（顺序 81/82/83/84/85/86 + 顺序 71 的 B12 半条）：

- **代提交 `3c2859f`**（用户裁定「我代提交，解开 84/85」）：另一条会话写完却闲置约两小时的 24 项未提交改动，170 文件 742+/14- ——
  图标换新、`AvatarCropper.tsx` 与 `lib/{avatar-crop,portraits}.ts`（含测试）、`CardDesigner` 等 8 个组件与 `styles.css`、144 张 `/portraits/*.webp`、`brand/icon-master.png`、`tools/art/prepare-assets.py`、`art/` 的 README 与两张总览图。
  提交信息里写明**这是别人的成果、由我代提交、未经逐行审阅**（只做了敏感信息排查：凭据/域名/API Key/私钥/内网地址零命中）。48 张原图（~114 MB）按用户裁定**不进仓**（`.gitignore` 新增 `art/source/`）。
- **`0ad316d` 顺序 84**：合 `worktree-agent-a5ef9d3cfc346aade`（A2/A4/A9/A10/B1/B2/B3/B5/B7/B13/B17/C3/C13/C17/C18 + 分支上补的 B3 原子认领与 SW 静态白名单），21 文件 805+/135-，**零冲突**。
- **`554d5d2` 顺序 85**：合 `audit/integration`（A14/A15/B19/B20/B21/C16/C21/C22 与本地助手 A1/A13/C19/C20），唯一冲突是 `.gitignore`（两边条目都留，没动 `--ours/--theirs`）；CI 里 actions 固定到 SHA、加 `build:sync-server` 步骤、engines 提到 `node: >=22.5`。
- **`655230c` 顺序 85 收尾**：lint 从 13 error 收到 **0 error / 0 warning**（本仓第一次），门禁五项全绿：
  typecheck ✓、lint ✓（279 文件）、test ✓（Core 68 文件/780 条、Web 13 文件/45 条）、build ✓（`dist/assets/index-9bjwPXDa.js` 649.25 kB / gzip 204.58 kB）、build:sync-server ✓。
- **仍未做**：`tools/*` 不在 `pnpm-workspace.yaml`（顺序 85 没补，缺口仍在）；B11/B12 只接了一半；顺序 87 的预算币种。**B10 已在顺序 88 补上**（见本节上面那一节）。**服务端与网页的重新部署已在 2026-09-26 完成**（见本页最上面的「整批上线」一节）。六个提交都已 push。
- 合并插曲：`package.json`/`pnpm-workspace.yaml` 变过之后，非 TTY 下 `pnpm` 会因 `verify-deps-before-run` 报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`；解法是 `$env:CI='true'; pnpm install`（`pnpm-lock.yaml` 未被改动）。

### 2026-09-26：顺序 71 落进 main（token 估算校准：先把实测数据通路打通，口径等真机数字）

审计 B12 里「结构开销 + 5% 余量」那一半**早在顺序 82** 就落在 `packages/core/src/prompt/assemble.ts`（`BUDGET_SAFETY_MARGIN = 0.05`），
本批只做剩下那一半——**让估算能和真实值配对**，从而在不联网、没有 tokenizer 的前提下拿到实测比例：

- 新增 `packages/core/src/token/calibrate.ts`：`ratioOf`（`actual/estimated`，> 1 = 低估）、`suggestedNarrowDivisorFor`（`4/ratio` 钳在 `[2,6]`）、
  `calibrateCounts`（账单那种只有两个数的样本）/ `calibrateTokenCounter`（带原文）、`counterFromCalibration`（按比例包一层计数器，**不自动生效**）、`formatCalibration`。
- 账单攒样本：`UsageRecord.promptEstimate`（**不存正文**）、`UsageTotals.calibration { calls, estimated, actual }`（估算与真实都 > 0 才计）、`usageCalibration(totals)`；
  生成路接线（`useTurnRunner.ts:574` 带 `generation.prompt.tokenEstimate`），意图判断那条路不走 `assemblePrompt`，写 null。
- 「用量与花费」面板底部多一行提示（`formatCalibrationNote`，样本 ≥ 10 才显示）：真机上跑够 10 轮就能看到「本地估算比真实少/多 N%」。
- `estimate.ts` 的字面量 4 提成 `NARROW_CHARS_PER_TOKEN`，**行为一字未变**——本机没有任何 tokenizer（tiktoken/gpt-token/bpe 全空），凭感觉调数字会让英文侧白丢历史。

门禁：typecheck ✓、Core **780**（68 文件）+ Web **29**（8 文件）全绿、全仓 lint 仍是那 13 个 error（全部来自另一条会话未提交的文件）、build ✓、build:sync-server ✓。
做法、两个实现坑与五条遗留见 **EVAL 第七十五节**。**「误差 < 10%」这个目标仍是待验证**：实测比例要等真机（归 Codex / 用户）。**本批已 push 并部署**（见本页最上面的「整批上线」一节）。

### 2026-09-26：顺序 86 落进 main（审计遗留里没人修的五条：B6/B9/B15 修了，B18 裁定不动，B10 不做）

审计盘查时核出**五条没有任何分支在修**，本批在 main 上处理：

- **B6（改素材会清空没提到的字段）**：管理员工具的 `parseCardDraft`/`parseWorldBookDraft` 改成**以现有素材为底做字段级合并**
  （`mentioned()`：`undefined`/`null` 算「没提」、显式空串 = 清空），世界书同名条目**复用原 id 与用户调过的设置**，`alternateGreetings` 进 schema；
  并在采纳路径加**过期拒绝**（`adoptAdminArtifact` → `conflictOf()`：目标被删或 `updatedAt` 变过就只把 `conflict` 写在草稿上，
  不抛异常也不覆盖用户的改动），`SideChat.tsx` 草稿卡显示一句话并禁用采纳按钮。
- **B9（多币种直接相加）**：`UsageTotals` 新增 `costs: CurrencyCost[]`，**按币种分别累计**，最主要的那种写回 `cost`/`currency`；
  网页账单主币种后面显示「另计 …」。**不做汇率换算**。副作用：`cost` 的语义从「乱加之和」变成「主币种小计」，而 `budget.ts:43` 的额度没有币种字段 → 已登记**顺序 87**。
- **B15（PNG 压缩炸弹 / 一块坏了整卡失败）**：解压改成 `readAllWithLimit` **边读边数 8 MB**（超限先 `cancel()` 再抛 `InflateTooLargeError`）；
  单块读不出来只推 `png.chunk-failed` 警告并跳过（`InflateUnavailableError` 仍上抛），导入 `reason` 里如实说「另有 N 个数据块读不出来」。
- **B18（Key 默认明文存 localStorage）**：**用户 2026-09-26 裁定「不必写提示」** → 默认档位保持 `'device'`、不新增文案（风险写在 EVAL 第七十四节）。
- **B10（流式失败边角）**：**本批不做**——别人在 `.claude/worktrees/agent-a6adfa051fc0cc2bd` 里有未提交的 `provider/openai-compatible.ts` + 新测试，碰了会撞车。

门禁：typecheck ✓、Core **760**（67 文件）+ Web **19**（6 文件）全绿、本批 14 个文件 lint 干净、build ✓、build:sync-server ✓；
全仓 lint 仍是那 13 个 error（全部来自另一条会话未提交的文件）。做法、数字与遗留见 EVAL 第七十四节。**本批已 push 并部署**（见本页最上面的「整批上线」一节）。

**下一步**：84 = 合 `a5ef9`（**两条真代码已在分支上补掉**：`task-queue.ts` 的 `claim` 走 `updateEntity` 原子 CAS、`sw.js` 白名单加 `/portraits/` 与 `/brand/`；已把 main 预先并进那条分支、预集成门禁全绿 → 等脏文件提交后合并很快）。
**84/85 仍必须等另一条会话提交 `App.tsx` / `styles.css` / `components/*.tsx`**（现在合会被 git 拒）。
**部署：服务端那批（配额/限流/`epoch` 三列）已在 2026-09-26 上线**（见本页最上面的「整批上线」一节）。

### 2026-09-26：顺序 83 落进 main（审计第三批 + 三条「有疑」按裁定补齐）

分支 `a063c`（A3/A4/A6/A7/A8/A9/B1/B16/C8–C12/C14/C15 十五条）已合入 main（合并提交 `6ce2b89`，24 文件 1991+/363-）。
只读复核判「只做了一半」的三条，按用户 2026-09-26 的裁定在 main 上补齐：**A4** 网页层真的调 `resetSyncState`（新建空间 + 回灌快照 + `resync` 三处）、
**A9** 新建空间也强制口令 ≥6（口令下限/强度提示收到唯一实现 `apps/web/src/lib/password-policy.ts`）、
**B1** 入口串行化（`sync-queue.ts` 的进程内队列 + 跨标签页 Web Locks，`doSync` 排队后才推拉，已核查无嵌套无死锁）。
A9/B1 是**故意按 `a5ef9` 那一套原样落地**的，好让顺序 84 合并时这两块无差异（见 TASKS 第〇节）。
门禁：Core **737**（66 文件）+ Web **19**（6 文件）全绿，build ✓、build:sync-server ✓，本批路径 lint 干净；全仓 lint 仍是那 13 个 error（全部来自另一条会话未提交的文件）。做法与证据见 EVAL 第七十三节。

**下一步**：84 = 合 `a5ef9`（**只读复核回执已到**：15 条里 A2/A10/B2/B5/B7/B13/B17/C3/C13/C17/C18 可信，A4/A9/B1 是重复且更弱的一份、已被 main 覆盖；
**真正要动代码的只有两条**——① B3 回退：`worker.ts:548` 改调 `db.tasks.claim` 会绕开 main 的原子 CAS，需改回或走 `updateEntity` 事务；② SW 白名单要加 `/portraits/**` 与 `/brand/**`，否则装到桌面后立绘/头像离线破图）。
**下一步**：84/85 仍然必须等另一条会话提交 `App.tsx` / `styles.css` / `components/*.tsx`（现在合会被 git 拒；86 已做完，见上一节）。
**部署：服务端那批（配额/限流/`epoch` 三列）已在 2026-09-26 上线**（见本页最上面的「整批上线」一节）；升级时盯住的已有库 `ALTER TABLE` 与 `/sync/health` 都已实测通过。**本批已 push、已部署。**

### 2026-09-26：顺序 82 落进 main（审计第二批 + 三处必修）

分支 `a6adfa`（A5/A11/A12/B3/B4/B8/B11/B12/B14/C1/C2/C4/C5/C6/C7 十五条）已合入 main（合并提交 `5014509`，19 文件 1695+/266-），
只读复核判出的**三处必须先改**也在 main 上改完了：① 导入回滚接进启动路径（`apps/web/src/lib/session.ts` 的 `useDatabase` 调 `recoverInterruptedImports`）；
② 导入标记从模块级单键改成「一次导入一把钥匙」+ 5 分钟判死（还认老版本留下的单键）；③ v3 迁移守卫改成「该 room 是否已有未删的 main 主线」，
中断重跑会接着用那条主线（新增测试在把守卫改回旧判据时**会变红**）。Core **709** / Web **12** 全绿，做法与证据见 EVAL 第七十二节。

**下一步**：83 = 合 `a063c`（只读复核回执已到：A3/A6/A7/A8/C8–C12/C14/C15 可信；A4/A9/B1 只做了一半；
**合并前要拍板三处**——SYNC.md §4.12.2 的措辞、新建空间是否强制密码最小长度、B1 入口串行化做不做）；
84 与 85 仍必须等另一条会话提交 `App.tsx` / `styles.css`；86 = 补五条没人修的（B6/B9/B10/B15/B18）。
82 自己带出来的遗留（回滚没有界面提示、5 分钟窗口内不收拾、C6/A11 复核有疑未消解、B11/B12 只接一半）已记进 TASKS 第〇节。**本批已 push、已部署**（见本页最上面的「整批上线」一节）。

### 2026-09-26：审计遗留归账 + 顺序 81 落地（本机助手加固）

opus5.5 那轮深度审计（`docs/AUDIT-2026-09-26.md`，58 条）**一条都没进 TASKS**，修复散在五条分支/worktree 上。
先把账补上（TASKS 第〇节「审计遗留」小节：哪条分支修了哪几条、4 条重复实现、**5 条没人修**、**2 条只接了一半**），
再把 P0 那批落地：**顺序 81** = 本机助手 `tools/local-bridge` 的 Origin/Host 白名单 + 可选令牌 + 请求体/超时/并发上限
（提交 `acb93dd`，手动 `node --test` 15 条全过；五项门禁见 EVAL 第七十一节）。顺手补了 `.gitignore` 的
`.claude/` 与 `tmp-test-cards/`（防一次 `git add -A` 把 agent worktree 与真实角色卡提交进去）。

**下一步（当时；82 与 83 的复核后来都出了结果，见上面两节）**：82 = 合 `a6adfa`；83 = 合 `a063c`；
**84 与 85 必须等另一条会话把 `App.tsx` / `styles.css` 的改动提交**（那两条分支碰了这两个脏文件，现在合会被 git 拒绝）；
86 = 补五条没人修的（B6/B9/B10/B15/B18）。**本批已 push、已部署**（见本页最上面的「整批上线」一节）。

### 2026-09-25：无限制模式已上线（push + 部署，用户明确要求）

`main` 推到 `origin/main`（`ac78a37..f1e0b5e`，两个提交：`aa2b7fa` 第一版 + `f1e0b5e` 改成用户数据）。
网页换成 `assets/index-2_KP3lQJ.js` + `index-obPMknLQ.css`；旧网页目录备份 `/var/www/dramatis.bak-f1e0b5e`
（`bak-e140839`、`bak-b117bd3` 也还在，可连退三步）。同步服务端**本批未动**（`/health` 本机 200、
公网 200，`systemctl is-active` = active）——本批只改了内核的提示词装配与前端，没碰同步协议。

上线后核过四件事：① 公网页面引用的是新包；② 把线上那份 JS 下载回来扫过，
**不含用户提示词**（`live_bundle_has_secret: false`）；③ 新功能标记在（`无限制模式` / `清空旧提示`
都能在线上包里搜到）；④ 全树与构建产物各 0 命中（复核脚本，见 EVAL 第七十节）。

**用户要做的一件事**：提示词现在是**用户数据**，所以不会随部署出现——请打开应用 →
输入区「＋」→「无限制模式」→ 在粘贴框里粘一次 →「保存提示词」。
代码里取出来的那份正文存在本机 `secrets/unlimited-prompt.txt`（`.gitignore` 挡住，不会进 git）。

### 2026-09-25：无限制模式（加号里的「高级系统提示」输入框改成开关）

用户点名的一批（68a）：输入区「＋」菜单里原来的**「高级系统提示 · 当前对话」文本框**（另一条会话
刚在 `e140839` 提交并上线的那个）删掉了，换成对话级勾选框**「无限制模式」**，下面接一个**粘贴框**。

**这一批中途翻过一次案，值得记住**：第一版把提示词正文做成**代码里的常量**，用户粘贴后门禁全绿；
但用户说这是**商业机密**，于是用不读取正文的脚本核了一次——**那段文字确实被编译进了网页包**
（`bundle_contains_raw: true`，包体 +8.95 kB）。而网页是**公开托管**的静态站点，任何人下载
`assets/*.js` 就能读到，`git push` 还会进远端仓库历史。**这是这一批自己引入的泄露**，改之前
那段文字本来只存在用户浏览器里。据实报告后用户要求「让它不可读」，于是改成：

- 正文常量**删掉**；正文当**用户数据**存本机 `meta`（`META_KEYS.unlimitedPrompt`），
  装配时由 `AssembleInput.unlimitedPrompt` 传进来——**不进代码、不进网页包、不参与同步**
  （代价：换设备要重新粘一次，想跟着账户走记成 TASKS 68b）。
- 残留复核（不读取正文，只输出计数）：全树 **0** 命中、构建产物 **0** 命中；重建后包体
  619.65 kB（含正文那次是 627.33 kB）。
- 旧字段 `modes.advancedSystemPrompt` 仍照旧装配（块标签带「旧」），菜单里说明 + 「清空旧提示」——
  线上现在还是旧界面，用户库里可能已经存过内容，这条兼容是必须的。

单测 Core 671 + Web 8，五项门禁全绿。**本批已按用户要求 push 并部署**（见上一条）。
真实模型上的效果、真机菜单观感**待 Codex 验**。一条硬提醒写进了 EVAL 第七十节：
**不要把用户的提示词/密钥写进源码常量**——产物是公开可下载的。

### 2026-09-25：顺序 68 账单 `since` 下推与汇总不排序

顺序 68 收口（A+B）：账单记录现在盖 `updatedAt`（与 `createdAt` 恒等，账单不参与同步，
所以对同步零影响），`since` 走 62 已建好的 `updatedAt` 索引——实测 1000 条流水里
`list({roomId, since})` 从读 857 行降到 **61 行**；`summary` 不再复用带排序的 `list()`，
`summarizeUsage` 改成与输入顺序无关。**排序本身只占 0.046 ms / 857 条**，所以 A 的收益是
结构性的、时间上量不出来——照实记在 EVAL 第六十九节。原方案里的「`limit` 下推」与
「`summary` 增量缓存」按实测拆开：前者没生产调用者、且并列同一毫秒的记录会取到不同子集，
不做；后者拆成**顺序 80**（前置是删世界绕开 ledger 直接删账单那条路径要收口）。
SCHEMA_VERSION 10 → 11（迁移 11 归一老账单的 `updatedAt`，否则老账单会被索引漏掉、安静少算钱）。
**已随另一条会话的 `e140839` 那批 push 并上线**（网页包 `index-kacAMQSe.js`）；迁移 11 已在隔离
Chrome 用一条合成旧账单验过（迁移前索引 0 条 → 迁移后 `10→11` 且 1 条，详见 EVAL 第六十七节末）。
仍未验：**用户真实长跑库**（上千条账单）的升级耗时、真实 IndexedDB 上 1000 条流水的耗时、手机用量页。

### 2026-09-25：角色卡高级系统提示默认值

### 2026-09-25：长对话质量三修（顺序 67e）

178 轮真实模型长跑（侧边浏览器、真 Key、无假模型）测出的「长对话漂移」已按用户裁定处理：
新增 `ConversationModes.replyLength` 三档（偏短 / 标准 / 偏长，缺省标准）与
`prompt/reply-style.ts` 的反重复规矩（动作可以连着做几个不同的，但不许同一个动作重复；
动作句不拿自己的名字当主语；不复述已答过的事），规则以**可丢弃块** `reply-style` 进
system 提示，输入区加号菜单里可切档。串线检测暂缓；「一轮内多个角色作答（不是所有角色都
必须回答）」记在 TASKS 78。基线数字、实现与未验项见 EVAL 第六十八节——**长度三档在真实
模型上的效果还没复跑，属于待验**。

角色沉浸模板现为角色卡「系统提示（覆盖默认规则）」的默认值。新建卡、空系统提示的导入卡会写入；旧卡空字段在编辑时显示并在生成时使用；已有非空自定义提示不覆盖。小 token 预算下仅压缩这份默认提示，保留自定义提示原文。主对话输入框旁「＋」还提供当前对话的可选高级系统提示，独立于角色卡和其他对话。`e140839` 已推送，网页包 `index-kacAMQSe.js` 已上线；真实浏览器保存、刷新和跨对话隔离通过，迁移 11 的合成旧账单在隔离 Chrome 中通过。实现、测试与边界见 EVAL 第六十七节。

### 2026-09-25：DeepSeek 接入与角色回复完整性

用户已授权本轮 push、部署，以及 Codex 通过侧边浏览器发送真实模型测试消息。修复 `b117bd3` 已推送并上线：网页包 `index-qKsI2pdF.js`，同步服务 `/health` 正常；旧网页与服务包均有 `bak-b117bd3` 备份。新配置默认使用 DeepSeek 现行 `deepseek-flash`；旧配置保留原模型和 Key 引用，并在模型接入面板提示手动改名。现行 DeepSeek 思考模型不再被 512 token 请求上限截空；供应商若返回内容过滤、长度截断、中止、损坏 SSE 或提前断流，会明确报错且不把半条回复当作成功落盘。重抽先完成并检查新回复，再撤销旧回复，避免模型失败时先丢旧数据。Codex 已在侧边栏真实网站把现有配置模型名改为 `deepseek-flash`（未读取 Key），创建独立测试世界、从世界行续开第二条对话，并用真实模型发送与重抽成功；详情与边界见 EVAL 第六十六节。服务商侧过滤不由客户端控制，不能保证任意题材都放行。

### 2026-09-25 补记：用户实测的两处 P0 缺陷

用户报告顶部「新对话」错误地落入当前世界，以及双角色开场白格式和长度失真。本地修复把顶部入口改为创建新世界及首轮，把世界内续开放到对应世界行；自动开场按角色归属、动作标记和字面换行处理，生成请求设置每角色输出上限。改动尚未部署或推送，线上仍是旧行为。已在独立本地端口 5274 的空库实测：顶部依次创建甲、乙两个世界，各 1 条对话；从非当前乙世界点击甲的续开按钮后，甲变 2 条、乙保持 1 条；新世界首轮的自定义场景与地点已显示。Core 单测和五项门禁、真实模型验证记录见 EVAL 第六十三节，最终提交状态以 `git log -1` 为准。

顺序 67a 的本地修复已单独提交（`a59b9c8`），并用两张合成卡在手机视口核对双角色开场。图标与设置交互第一轮继续做 SVG、焦点和保存状态；浏览器测量与未做的真机项目见 EVAL 第六十四节。两批均未部署、未推送。

图标与 UX 第二轮继续核对手机设置与运行时面板：去重标题、提高表单标签字号、统一键盘焦点环，运行时抽屉打开后先聚焦页签、Esc 回焦顶栏。测量见 EVAL 第六十五节；真实手机软键盘与安全区仍待 Codex 验证。

### 🔴 新会话第一份要读的：截至 2026-09-25 凌晨的交接

**一句话**：57–63 已落地，**66 / 65 / 64 / 67 都已完成**——也就是 TASKS 第〇节里
「63 / 66 / 65 / 64 / 67」这一批**全部收口**；本地 `main` 领先 `origin/main` 若干提交
（写这份交接时是 14 个），**所有改动都还没上线**（线上仍是 `index-JFtj61pq.js`）。
下一步：按第〇节的顺序往下走 **68（账单查询下推与增量汇总，依赖 62 的索引）**，
当时上线与推送尚未获授权；2026-09-25 用户已明确授权本轮部署与 push，见本页最新补记。

| 项 | 值 |
| --- | --- |
| 本地 `main` HEAD | 看 `git log -1 --oneline`；`git log --oneline origin/main..HEAD` 列出所有**未推**的提交（数字每次提交都会变，别照抄） |
| 线上网页 | 还是 `index-JFtj61pq.js`（2026-09-24 23:16 那次部署）；**63 / 66 / 65 / 64 / 67 都还没上线** |
| 同步服务端 | 与线上一致（61 的 WAL 与护栏已在跑）；有两条「用户 id → 账户 ID」的文案改动**等下次服务端部署**才生效 |
| 工作区 | 干净（`git status` 无输出）。**注意：另一条会话也在同一个仓库里干活**——2026-09-25 00:26 他们提交了「400 轮长对话压力测试 + QUALITY.md」（`ca18b89`），所以 `docs/EVAL.md` 里出现了两个「六十」；我这边把编号让开，见 EVAL 第六十一节开头的说明 |
| 本机进程 | **vite 开发服务器在 5273 上开着**（它同时挂着 `/sync` 开发后端，改完源码刷新即生效）；顺序 66 验证时起的**假模型还挂在 5288**（`--chunk-ms 60`，用完可关）；没有本机 8787 |

**下一步（严格按 [TASKS.md](./TASKS.md) 第〇节的顺序，不要插队）**

1. **这一批（63 / 66 / 65 / 64 / 67）已经收齐**，五件的实测数字与验证证据分别在
   EVAL 第五十六 / 五十八 / 五十九 / **六十一** / **六十二**节（六十一 = 顺序 64，
   六十二 = 顺序 67；六十 是另一条会话的 400 轮压力测试）。**该向用户做一次完整汇报了**。
2. 当前这轮已获「部署及 push」授权；以 EVAL 第六十六节记录核对上线结果。
3. 用户点头之后，下一件是 **68**（`usage.list` 的 `since / limit` 走 `byCollectionUpdated`、
   `summary` 做增量缓存）。

**66 留下的口子（已单独记成顺序 76）**：App.tsx 现在 1091 行（66 收工时 1090，顺序 67 又加了一行
`error` 传参），没到 §0 里写的「< 600 行」——
剩下的几乎全是布局壳 JSX（左栏 / 工作区 / 顶栏 / 四个弹窗），要再往下拆得按区域把布局拆成组件。

**2026-09-25 凌晨补记（400 轮长对话压力测试 + 质量评测准备）**

- **假模型 400 轮真机跑过**：800 条消息 / 1183 条记忆 / **0 失败 0 产品错误**，16.7 分钟。
  两个发现：① **每轮耗时随对话变长**（0.95s → 2.5s，第 300–400 轮约 3.4s/轮），
  涨的是记忆召回与装配这类**按条数走**的开销——建议并进顺序 62（验收就是这条曲线不再上扬）；
  ② 记忆 **≈3 条/轮**（1 客观 + 每个在场角色一条），合并没明显压住它，值得单独量。见 EVAL 第六十节。
- 过程中出现过一次 `ReferenceError: Composer is not defined`：那是**一边跑一边有人提交顺序 65**
  （新增 `Composer.tsx`）导致的 HMR 竞态；在稳定 HEAD 上复跑 40 轮 = 0 错误 0 失败。
- **新增 [QUALITY.md](./QUALITY.md)**：真模型的对话质量评分表（像人说话 / 性格 / 经历记忆 /
  不越界 / 没有 AI 腔）、AI 腔清单八条、抽样法，以及**现在最可能导致 AI 感的六处提示词**。
  真模型 400 轮脚本 `long-400-real.mjs`（工作区外，Key 只从环境变量读）已就绪；
  **真模型那一半没跑**（本机没有 Key），谁拿到 Key 谁跑，跑完把 transcript 交回来按表评分。

**工作约定（每一轮都适用）**

- **绝不** `git reset / restore / checkout / stash / clean`；未提交的改动一律先审阅再收口。
- 每小步都能构建 / 测试 / 提交；**提交信息带顺序号**（如「顺序 66」）。
- 每次提交前跑五项门禁：`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm build:sync-server`。
- 实现与计划的偏差、验证里抓到的问题，写进 [EVAL.md](./EVAL.md) 与相关设计文档；私有信息不进仓库
  （`deploy/LOCAL-NOTES.md` 已被 .gitignore 挡住，**不要提交它**）。
- **验证边界**：另一个 AI（Claude）只做 typecheck / lint / 假模型 / 单测 / build / build:sync-server；
  **浏览器真机验证由 Codex 做**（用户明确这么分工）。不碰线上站点、真实 API Key、真实模型。
- **多智能体**：用户要求过用 Agent Teams，但实测**子代理收不到任务正文**（8/8 失败），
  只能让它们自己从 docs 里挑活、再事后核对；**不要假装用了它们**。

**本机怎么跑浏览器验证**：开发服务器与假模型两条命令——
`cd apps\web ; node node_modules\vite\bin\vite.js --host 127.0.0.1 --port 5273 --strictPort`，
需要模型时 `node tools\fake-model\server.mjs --port 5288 --chunk-ms 120`（可加 `--reasoning`）。
Playwright 从 `C:\Users\35350\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules`
用 `createRequire` 加载，Chrome 用 `C:\Program Files\Google\Chrome\Application\chrome.exe`。
一次性验证脚本都在工作区外 `C:\Users\35350\.codex\visualizations\2026\09\24\01a0d30c-...\`：
`verify-draft-hook.mjs`（63：逐键写库 / 真 IME）、`verify-66-smoke.mjs`（66 冒烟）、
`verify-account-flow.mjs`（账户注册 + 另一台设备登录）、`verify-sync-button.mjs`、
`verify-drawer.mjs`（侧栏推开）、`verify-62-db.mjs` / `verify-62-perf.mjs`、
`smoke-sync-deployed.mjs`（打线上服务端的同步冒烟）、`shots-topbar.mjs`（前后截图）——都还能直接跑。
顺序 66 第三步的验证脚本在 `...\01a0d419-...\verify-66-turn-runner.mjs`（发一句 / 重抽 ×3 /
改归属 / 无 Key 桥接，13/13），顺序 65 的在同一个目录 `verify-65.mjs`（输入区 / 三个模态框 /
在场状态 / 体积格式 / 副对话，11/11），顺序 64 的 `verify-64.mjs`（手搓三张真 PNG 走导入口，
5/5；它也会顺手在同一个目录里生成 `card-crc-*.png` 三张样本），顺序 67 的 `verify-67.mjs`
（副对话错误显示 / 未知参数回填 / 起草 → 采纳 → 撤回，6/6；它要的模型配置指向死端口，
故意让这一轮失败）。

**仍然没验的（别写成通过）**：真机软键盘与安全区、真模型效果（要用户的 Key）、
两台**真设备**（不是两个浏览器 profile）的同步演练、顺序 39/41 的线上回归、
以及 61 之后那两条服务端文案（等下次部署）。

> **2026-09-23 全量代码审阅**：把内核、前端、同步服务端与工具链整个读了一遍，
> 发现的问题按 P0–P4 重排成 [TASKS.md](./TASKS.md) 第〇节的「2026-09-23 总排期」
> （顺序 57–75，每条带改哪里 / 怎么改 / 怎么验）。用户拍板：**先做 57 / 58 / 59**
> （被取代原文退出召回但保留索引、提示词按场记覆盖收起、流式重渲染）；
> 同步与数据安全是底线（61）；对话质量优先于省 token；世界书插入位置要做（60）。
> 工作约定不变。下一步从顺序 57 开工。
>
> **顺序 57 已完成（2026-09-23）**：`recallForPrompt()` 成为一轮生成挑记忆的统一入口——常规召回只看
> 未被取代的条目，被取代原文只在玩家**这一句**提到关键词（≤2 条）或问过去时顺着印象展开（≤2 条）才回来，
> 分数压低且预算里只留不超过 1/4 的位置；Prompt 检查器显示「常规召回 / 提到才想起 / 印象来源」各几条。
> 60 轮假模型演练 15/15（EVAL 第四十六节），573 个测试全绿。**未上线**。下一步：顺序 58（先量：
> 60 轮时提示词 5,913 字仍在线性长）。
>
> **顺序 58 已完成（2026-09-23）**：历史不再按固定条数砍，而是「未被场记覆盖的全带、已覆盖但在近窗 40 条内的
> 全带、已覆盖且在近窗外的收起」，收起段由本场场记、前几场场记（新块）、章节、记忆代表，玩家这一句提到关键词时
> 取回 ≤3 条原文；开关在对话模式菜单，对话级。假模型 300 轮：改前 21,947 字线性涨、改后封顶 3.3–3.75 千字
> （EVAL 第四十七节）。顺带修掉已结束场景的尾巴进不了场记的漏洞。580 个测试全绿。**未上线**；真模型定向问答
> 待用户 Key。下一步：顺序 59（流式重渲染）。

> **顺序 59（2026-09-24）**：保留并收口未提交草稿；流式正文、说话人、推理流、阶段移到独立 store，
> 只有 `StreamingBubble` 订阅。五个 hook 返回值 memo 化，消息列表和单条消息拆出并 memo；
> 输入框编辑与流式分块不再从 App 根节点刷新历史消息。流式滚动仅在靠近底部时跟随，
> 避免每个分块叠加平滑滚动。单测与验证边界见 EVAL 第四十八节。
> **浏览器验证已完成（2026-09-24）**：600 条消息的真实界面上，打字与每个分块都只重画
> `MainChat`/`StreamingBubble`，列表与面板 0 增量（EVAL 第四十八节末）。仍然存在的热点是
> 「一轮收尾时列表被整体重画 7–10 次」，留到 62 / 66 一起收。**未上线**。
> 下一步严格按 TASKS 第〇节顺序做 60 → 61 → 62，再做图标和 UX 优化。

> **顺序 59 收口补记（2026-09-24）**：`stream-store` 分成 `main` / `admin` 两条通道，
> **副对话（世界管理员）那条流式也搬出了 App 根节点**（`useAdminChat` 返回值 memo 化、
> `SideChat` memo 并自己订阅、App 回调稳定化）。顺带查到：副对话本来就不逐字流
> （`collectCompletionWithTools` 等整段），所以那条路的收益是架构一致与少几次整树重画。
> 单测 585 个（Core 580 + Web 5）全绿，五项门禁全绿；副对话那条路已在无头浏览器上量过
> （打字 0 旧组件增量、回合内只有 `SideChat` 动）。**未上线、未 push**。
>
> **浏览器结论要分两半说（三方独立演练汇整，见 EVAL 第四十八节末）**：
> ✅ 成立——每个 token 不再重画整棵树（分块帧上只有流式气泡）、打字不重画旧消息、
> 流式期间上滑不被拽回底部。❌ 不成立——「长任务为 0」（600 条世界里一轮 12–25 个、
> 最长到秒级；20 条对照组为 0）与「一轮不再整表重画」（每轮仍有 9–17 次 600 项全量重渲染）。
> 这两条都是**顺序 62 + 66** 的范围，不是 59 没做完。另记一条**待复核 P1**：
> 614 条世界里重抽 4 次有 2 次卡死（忙态收不掉），需干净环境复现。

> **顺序 60 已完成（2026-09-24）**：世界书的插入位置语义真的落地了。匹配阶段逐条 `scanDepth`、
> 递归最多 3 轮（`preventRecursion` / `excludeRecursion` 各按 SillyTavern 的语义）、同组只留一条；
> 落点按 `position` 落到人设前 / 人设后 / 场景前 / 场景后，`at_depth` 作为独立 system 消息插进
> 历史倒数第 `depth` 条之前，认不出的位置码记一条导入 warning（不静默丢弃）。
> 每条命中各成一块，预算按 `order` 逐条丢；**默认位置的老世界书提示词逐字不变**。
> 单测 +20（Core 600 + Web 5 = 605 全绿），五项门禁全绿，映射写进 DESIGN §9.3。
> **没验的**：真实世界书端到端对照、真模型效果、检查器标签的浏览器回归（EVAL 第四十九节）。
> 下一步：顺序 61（同步与数据安全底线，七件一批收）。

> **顺序 61 代码与单测已完成（2026-09-24）**：同步与数据安全底线七件全部落地——
> 错误按**机器可读的 `code`** 判（新 `SyncHttpError` 带 `status`/`code`，删掉 `includes('存满')`）；
> PBKDF2 从「建空间 4 次 / 登录 2 次 / 换密码 2 次」降到「3 / 1 / 1」；
> SQLite 开 WAL + `busy_timeout`（服务端与备份不再互相顶掉）；`POST /spaces` 补来源限流与总量上限；
> 字节配额改成「写完之后」判；凭据墓碑不再带密文；删掉死参数 `baseHead` 与换密码后多余的 KeyStore 写入。
> 单测 +13（Core 613 + Web 5 = 618），五项门禁全绿，协议修订写进 SYNC §4.9.1 / §4.9.2。
> **未部署、未 push**；服务端重新部署 + `/health`、三条真机同步演练（换密码 / 恢复码 / 坏记录隔离）
> 都还没做，**这一批上线前必须先跑一次同步冒烟**（EVAL 第五十节）。
> 下一步：顺序 62（存储层 O(N) 热点，含 59 留下的收尾整表重画与 worker 8 秒空转）。

> **顺序 62 已完成（2026-09-24）**：IndexedDB 升到 v2（加「房间」与「updatedAt」两个索引）、
> `countAlive` 走 `store.count`、`EntityStore.listSince` 支持增量读、`stampUpdatedAt` 的时钟与
> 水位线进内存缓存、`reloadWorld` 只换真正变了的集合、（worker 8 秒空转 tick 不再碰 React）。
> **量的过程中又挖出一条**：消息列表还会因为「角色实例数组（情绪每轮都变）」换引用而整表重画，
> 改成只吃 `{id, displayName}` + App 回调过 ref 之后，一轮对话的整表重画从 **36.1 次降到 4.0 次**
> （剩下的 4 次是两条消息落盘 + busy 开关，压掉后两次要等 66）。真 Chrome 实测：老库升级不丢
> 数据、索引语义与整表过滤一字不差、静置 20 秒所有组件增量为 0、重抽 4/4 完成（1.0–1.4 秒）。
> 原「重抽卡死」的 P1 在干净环境**未复现**（那次疑似两个子代理共用同一个库互踩）。
> 单测 623（Core 618 + Web 5），五项门禁全绿，**未上线、未 push**。
> 下一步：顺序 63（逐键写库 → 统一草稿 hook），之后 66 → 65 → 64。

> **上线记录（2026-09-24 晚，用户要求「部署及 push」）**：上面几条里写「未上线 / 未 push」的
> 全部随这一次一起上线并推送了——顺序 57 / 58 / 59 / 60 / 61 / 62 与手机端顶栏那一批
> （本地 `main` 推到 `origin/main`：`2d4f09a..6086096`，136 个提交）。
>
> | 东西 | 值 |
> | --- | --- |
> | 网页构建 | `apps/web/dist` → `index-CqzQpPAn.js` + `index-D0RqXr07.css`（提交 `6086096`） |
> | 同步服务端 | `tools/sync-server/dist`（同一提交；含 61 的 WAL / 护栏 / 去掉 `baseHead`） |
> | 本机探针 | `http://127.0.0.1:8787/health` = 200；`sqlite3 … "PRAGMA journal_mode;"` = **wal** |
> | 公网 | `https://dramatissync.com:8443/` = 200（引用新构建）、`…/sync/health` = 200 |
> | 同步冒烟 | **6/6**：建空间 → 设备 A 推 → 设备 B 拉并合并 → 设备 B 再推 → 设备 A 合并成三条 → 设备 A 删一条、设备 B 拉到墓碑后那条消失（用一次性随机账户，密文） |
> | 回滚点（网页） | `/var/www/dramatis.bak-20260924-214123` |
> | 回滚点（服务端） | `/opt/dramatis-sync/dist.bak-20260924-214123` 与 `backup.mjs.bak-20260924-214123` |
>
> 部署后**仍然没验的**：真机软键盘/安全区、真模型、以及两台**真设备**（不是两个模拟设备）的合并演练；
> 另外服务端重启后 Tailscale/域名那两条老路不受影响（本轮只换了静态文件与 dist）。

> **手机端第二批（2026-09-24，用户指定，仍不进 §0 排期）**：删掉手机端「世界名 · 对话名」那一行；
> 左右两侧都改成**把主对话推开的卡片**（圆角 + 外缘阴影，取消 55% 黑遮罩，240ms 位移，
> `prefers-reduced-motion` 时不位移）；两侧互斥；**打开期间对话不卸载**（草稿、滚动、
> 流式气泡都在，收起回原位）；改名从标题栏搬到左栏对话列表（改的是那一条，不切换对话）。
> 真 Chrome 实测 11/11（含"草稿不丢"与"桌面面板照旧 340px/无位移"）。踩到一个 CSS 硬规则：
> 平移 `.workspace` 会把 `position: fixed` 的面板一起推走，改成只平移 `.chat-surface`。
> **没做的**：左右滑动关闭（swipe）、真机手势与软键盘；「开着侧栏也能直接打字」需要另定方案
> （当前效果里输入框大部分在屏幕外）。**本地已提交，未部署、未 push**（上一批已上线）。

> **第二批已上线（2026-09-24 22:02）**：`main` 推到 `origin/main`（`4953961..b656faf`），
> 网页换成 `index-75pZ50Ty.js`；同步服务端本批未变（`health=200`）。
> 公网复核：`https://dramatissync.com:8443/` = 200 且引用新产物；线上 bundle 里含
> `rail-open` / `panel-open` / `renameConversation`，**不含**旧的 `rail-scrim`（黑遮罩真的删了）。
> 回滚点：`/var/www/dramatis.bak-20260924-220250`（上一批的 `/var/www/dramatis.bak-20260924-214123`
> 也在，两步都能退）。

> **第三批（2026-09-24 晚，用户看完上线效果后的反馈）**：手机上**对话区铺满整屏**
> （外壳外框与卡片边框全部去掉），**顶栏改成半透明的覆盖层**（毛玻璃 + 安全区，正文从它下面开始）；
> **收起侧栏只靠点「被移开的对话区」**——左栏的 ≡ 与面板的「收起面板」两个按钮都删掉了。
> 真 Chrome 实测 14/14（含"点对话区收起"两侧都过、"对话铺满 x=0 宽 390"、"顶栏 fixed"、
> "没有别的关闭按钮"）。**本批未部署、未 push**（待你点头或按上次流程处理）。

> **第三批已上线（2026-09-24 22:35）**：`main` 推到 `origin/main`（`d10a0eb..9cc0a2c`），
> 网页换成 `index-C6SFgPSL.js`；同步服务端本批未动（`health=200`）。
> 公网复核：页面 200 且引用新产物；线上 bundle 含 `drawer-backdrop`，**不再含**「收起面板」
> 与 `rail-head-close`。回滚点 `/var/www/dramatis.bak-20260924-223546`（连同前面两个备份，
> 可以连退三步）。

> **账户重构（2026-09-24 晚，用户要求）**：账户与同步空间合并成一件事——
> **账户 ID 就是同步空间名，账户密码就是同步密码**（注册时设、登录时输）；
> 账户面板改成**一账户一张卡片**，「新建账户」变成「**＋ 添加账户**」卡片，里面有**注册 / 登录**两条路；
> 服务器地址默认本站 `/sync`，只在「高级」里改。数据层新文件 `lib/account-auth.ts`，
> 设计写进 SYNC §4.9.3，验证见 EVAL 第五十五节。
> **端到端实测 6/6**（本机开发服务器 + 它的 /sync 开发后端）：注册拿到 52 位恢复码 → 进入新账户 →
> 写入一个世界 → 同步已连接 → **另一个浏览器 profile 用账户 ID + 密码登录，把世界拉了下来**。
> 老账户的同步配置与密码没被动过，照旧能用。**本地已提交、已上线**（见下一条）。

> **账户重构已上线（2026-09-24 23:05 / 23:08）**：`main` 推到 `origin/main`
> （`a6334b4..6c30f1b`，再 `6c30f1b..a550012` 文案收尾）；网页换成 `index-BSUDnlw8.js`，
> 同步服务端本批未重启（`health=200`）。公网复核：页面 200 且引用新产物，bundle 里含
> 「添加账户」「注册并进入」「登录并进入」。回滚点 `/var/www/dramatis.bak-20260924-230541`
> 与 `/var/www/dramatis.bak-20260924-230805`。
> 服务端有**两条提示文案**从「用户 id」改成「账户 ID」（`core/sync/server.ts`），
> 它们随**下一次服务端部署**生效——本轮没重启服务，避免打断可能在同步的设备。

> **多设备同步精简为一个按钮（2026-09-24 晚，用户要求）**：账户里已经有服务器地址了，
> 所以「设置 → 账户 → 多设备同步」现在只剩**一颗「同步」按钮 + 一行状态**
> （`上次同步 X · 结果`）；密码保存方式、状态明细、服务端快照、设备与改密码、重新拉一遍、
> 断开同步全部收进折叠的**「高级」**。没配置同步的账户仍保留手填表单（老账户与连别的服务器用）。
> 真 Chrome 实测 6/6（含「页面上不再有用户 id / 同步密码 / 服务端地址输入框」与
> 「点一下状态行真的变了」）。**本地已提交、已上线**（见下一条）。

> **同步精简已上线（2026-09-24 23:16）**：`main` 推到 `origin/main`（`fd52ead..ca9bb0c`），
> 网页换成 `index-JFtj61pq.js`；同步服务端本批未动（`health=200`）。
> 公网复核：页面 200 且引用新产物，bundle 含 `sync-primary` / `sync-advanced`。
> 回滚点 `/var/www/dramatis.bak-20260924-231622`。

> **顺序 63 完成（2026-09-24）**：新增 `lib/useDraftField.ts`（防抖 300ms + 失焦提交 +
> 组合期不提交 + 同值不重复提交），接进场景三个字段、对话名、角色显示名、记忆两处
> （后两处在 `map` 里，各抽了一个小组件）。真 Chrome 实测 6/6：连敲 6 个字写库 **0** 次、
> 停手 1 次；用 CDP 真 IME 模拟组合期写库 **0** 次、结束后 1 次、候选字没被盖掉、
> 落库值 = 屏幕上打的字。单测 623 不变，五项门禁全绿（EVAL 第五十六节）。
> 下一步按 TASKS §0：顺序 66（App.tsx 拆四个 hook）。

> **顺序 66 进行中（2026-09-24）**：先拆了耦合最轻的两个——`hooks/useNotices.ts`
> （`error` / `warnings` / 安装引导 + 存储快满提醒）与 `hooks/useWebBridge.ts`
> （桥接状态 + sessionStorage 落盘）。解构沿用原来的名字，**二十多处调用点一个字没改**；
> Biome 的 `useExhaustiveDependencies` 要求把稳定 setter 列进依赖数组（行为不变，用 `--unsafe` 自动补）。
> App.tsx **1947 → 1905 行**，真 Chrome 冒烟 5/5（应用起来、世界显示、引导关掉并落盘、输入区正常）。
> **还剩两个 hook**：`useImport`（导入流程）与 `useTurnRunner`（生成/重抽/改归属，最大的一块）。
> 目标仍是 App < 600 行。**未部署**（这批是纯重构，等 66 做完一起上线）。

> **顺序 66 第二步（2026-09-24）**：`useImport` 也搬出去了（PNG / JSON 卡与世界书、导入警告、
> 内嵌世界书、导完收起手机左栏）。App.tsx **1947 → 1853 行**，门禁五项全绿。
> **只剩 `useTurnRunner`**：`runGeneration` / `runIntentPlan` / `handleSend` / `handleRegenerate` /
> `handleReassignMessage` 合计约 740 行、二十多个依赖，一次搬错就动到聊天主循环，
> 所以留作下一轮独占——搬完配一次假模型端到端演练（发一句 / 重抽 / 改归属）。
> 另：四个 hook 全搬完 App 大约还有 1100 行（主要是布局 JSX），要做到 < 600 行还得拆布局，
> 那部分建议作为 66 的收尾单独记。

> **手机端顶栏按 DeepSeek 布局重排（2026-09-24，用户指定的一小批，不进 §0 排期）**：
> 「全屏」按钮**整个删掉**（功能弃掷）；顶栏不再写「存储：indexeddb」（设置里那份照旧，
> 「数据不会保存」警告保留）；手机端左上角改成**三横图标**开左栏、中间是**半高（24px）的在场角色条**、
> 右上角是**主/副合一的可切换按钮**与**面板**；点角色条里的名字会把它插进输入框（点名叫人，
> 不用开面板也不打断对话）。手机端主区标题栏从两行降到一行（108→58px）。
> **桌面除了那两处删除，逐像素没动**（实测主区标题栏与主/副分段的坐标尺寸与改前一致）。
> 三套主题 + 390×844 + 1440 实测无横向溢出、触摸目标 44、点角色插入成功；前后截图见
> EVAL 第五十二节。**待真机**：软键盘、安全区、输入法聚焦。下一步仍按 §0 做 63。

## 上一轮接续点（2026-09-21 深夜）

> 这一节是给**下一轮新对话**准备的：读它 + [MEMORY.md](./MEMORY.md) + [TASKS.md](./TASKS.md) 第〇节，
> 就能接着干。当前测试 **561 个全绿**，类型检查 / lint / 构建全绿。

**这一轮的主线**：用户把「对话的记忆与对话长度」定为当前最重要的问题，原话三件事——
① 一轮新对话要能输入 **500–800 条消息**而不出明显错误；
② 开新对话时把原对话的重要记忆作为**特殊附件存进角色卡**，带到新对话里用；
③ 记忆对**性格与情感**的影响要优化，并且**留好可回滚的通路**（不能不可逆）。
他的设想：附件**像文件夹**——平时不占 token，对话**提及关键词**时才去里面检索相关记忆。

**已经做完的（按提交顺序）**：

| 顺序 | 状态 | 关键文件 / 证据 |
| --- | --- | --- |
| 默认窗口按 800 条输入 | ✅ | `model/provider.ts` 65536 / 4096；`prompt/assemble.ts` 历史上限 40 → 3000；迁移 v7（只升级还是老默认值的配置） |
| 27a 记忆合并 | ✅ | `memory/consolidate.ts`（纯函数 + `applyConsolidation`）；阈值 **≤0.5 / 同视角 20 条**；接进后台队列（`lib/worker.ts` 的 `memory.consolidate`）；真机演练 5/5 |
| 27a 顺带修的竞态 | ✅ | `Repository.markMemoriesRecalled(ids, at)`：原来 `markRecalled` 用旧拷贝整条写回，把合并刚盖的章抹掉（20→9）；回归测试 `storage/recall-stamp.test.ts` |
| 27b 完成 | ✅ | `memory/attachment.ts` 的三层附件 + `buildCardMemoryAttachment`；开新对话自动把原对话章节/印象写回角色卡，界面显示「带了 N 条印象 / M 章，丢了 X 条」；单测 10 个，真机 7/7 |
| 27c 完成 | ✅ | 装配常驻只放附件索引；关键词/问过去才展开 ≤3 条正文。实测日常 1,022 字、命中 1,253 字；修掉旧记忆从普通召回漏回的问题 |
| 27d 完成 | ✅ | 状态历史带 id / before / after / 来源记忆；逐条撤销与回合回滚都 append-only；迁移 v9；无头真机 9/9 |
| 27e 完成 | ✅ | 记忆面板显示附件预览与「印象 → 来源原文」链；全链路真机 6/6 |

> 账户重构 A1–A9 + 顺序 54/55 已上线：网页构建 index-D_hz40V2.js，本机 HTTPS 探针 health=200。
> 网页回滚点 /var/www/dramatis.bak-20260922-234519。同步服务端代码本轮未变，
> 仍沿用 A1–A8 上线时的服务端构建与回滚点。

**27a–27e 已完成**：记忆合并、附件、按需展开、可回滚影响与面板收尾都落地。

**账户重构（A1–A9 已落）**：账户名、ID 与内部数据库分层；Persona 左栏管理、
对话级选择、副对话工具与彻底删除；模型配置和 API Key 密文随账户同步。
A1 8/8，A3 5/5，A4 6/6，A5/A8 各 4/4，A6/A7 6/6，A2 11/11，A9 4/4。
A2 补上本机硬删除与账户级同步密码；A9 复查 390×844 并把身份按钮折行修掉。
顺序 54 修掉身份创建时手写输入被按笔画拆字的问题：组合中只更新本地草稿，
组合结束或失焦后才写入，桌面 8/8、手机 3/3。

顺序 55：手机输入区不再把回车当发送，改成换行；桌面仍是 Enter 发送。
服务器管理台方案已写在 [ADMIN-CONSOLE.md](./ADMIN-CONSOLE.md)：
服务器实际只有密文空间，推荐先做 SSH 隧道下的本机网页管理台，而不是公网管理页。

**环境与验证（新会话直接用）**：

```bash
# 本机：开发服务器 + 假模型（零成本、可重复；假模型 stderr 会打每次调用的提示/输出字数）
cd apps/web && node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5273 --strictPort
node tools/fake-model/server.mjs --port 5280          # 可加 --reasoning --chunk-ms 300

# 测试与构建（每次提交前都跑）
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm build:sync-server
```

- **无头验证**：Playwright 从 `C:\Users\35350\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules`
  用 `createRequire` 加载，`executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'`；
  **读合并结果的窍门**：`page.evaluate` 里直接开 IndexedDB（库名 `dramatis`、store `entities`、
  索引 `byCollection`）按集合名读原始记录——比从界面绕一圈可靠。
- **长对话脚本**：`measure-long.mjs N`（导入卡 → 配假模型 → 连发 N 句 → 采样记忆条数与提示词长度）。
  300 轮实测：提示词第 60 轮封顶（老设置）→ 记忆 2 条/轮 → 300 轮 590 条。
- **线上**：`https://dramatissync.com:8443/`（nginx 托管 `apps/web/dist`，`/sync` 反代本机 8787）。
  部署顺序**必须**是「先确认包到了 → 旧的改名成备份 → 换 → `chmod -R a+rX` → 重启 → 核健康」；
  同步服务端同理（`/opt/dramatis-sync/dist`），**权限那步不能省**（scp 过来是 700）。
- **不要提交**：`deploy/LOCAL-NOTES.md`（已 gitignore，里面有服务器与域名信息）。

**提交习惯**：每小步都能构建 / 测试 / 提交；提交信息带顺序号（如「顺序 27b 第二步」）；
实现与计划的偏差、以及验证里抓到的问题，写进 `docs/EVAL.md` 与相关设计文档。

## 一句话

Dramatis 是一个多角色扮演酒馆，兼容 SillyTavern 资产格式。**P0（9 项）全部完成，P1 全部收口（11/11，P1-11 以评测结论收口：证据不支持上向量）；P2 已完成响应式 / PWA / 存储持久化 / 封存导出；界面改版三批（A/B/C）全部完成；P1-10 七轮真模型验证 + 六次评测回归跑完**，441 个测试通过；**P2-6 已上线**：数据层 / 加密 / 同步循环 / 服务端 / 界面全部交付，并已部署在用户自己的腾讯云 Ubuntu 24.04 上（systemd + SQLite + 每 6 小时备份，冒烟测试通过）。**域名线已上线（2026-09-20）：`dramatissync.com` + Let's Encrypt（8443 同源托管网页与 /sync）+ 公网两台设备端到端验证通过；下一步备案 + 切 443**（细节见 deploy/LOCAL-NOTES.md，不进仓库）。

> **2026-09-20 晚更新（本轮：项目主体 + 桌面版 + 安卓壳）**：468 个测试通过。
> 项目主体做了三件（都先复现再动手）：**T11 记忆面板的对话维度**（按对话筛选 / 对照视图 /
> 跳到原句）、**T12 归档的可发现性与正文导出**、**每轮对话结束自动同步**（节流 20 秒 +
> 尾随补一次）。中途撞上一个**会真丢数据的同步 bug 并修掉**：分页拉取把全局头号当游标，
> 新设备同步超过一页（200 条）的空间时会「成功」地只拿到一小部分——详见 [SYNC.md](./SYNC.md) §4.7。
> 桌面版：P2-9 的四条触发条件逐条量过，**Tauri 不触发**，改为补强启动器（`--prod` 会跳过
> 无谓构建）+ 一条装快捷方式的路，证据见 [DESKTOP.md](./DESKTOP.md)。
> 安卓：**P2-10 开工**——Capacitor 壳搭好、**本机真的构建出 APK**（4.8 MB），
> 四项能力在与 WebView 同源的环境里验过；真机这一轮没条件跑，清单见 [ANDROID.md](./ANDROID.md)。
>
> **当前接续点**：① 安卓真机（文件下载 / 切后台 / 键盘安全区）；② 部署线的域名（等审核）；
> ③ 项目主体的下一批候选（T13 管理员工具体验、T3 后半的记忆合并、记录分块与坏记录隔离）。

> **2026-09-20 深夜（体验优先）**：域名 `dramatissync.com:8443` **已经上线**（nginx 托管网页 +
> `/sync` 反代，Let's Encrypt 证书），所以按用户要求**暂停桌面版与安卓**，先修体验。
> 这一批做的是「**没有 API Key 也能聊第一轮**」：发送时不再拦「还没有填 API Key」，
> 而是把这一轮**本来要发出去的提示词**交给用户，贴进 DeepSeek 网页版，再把回复粘回来；
> 第二步可选地把这一轮的记忆与情绪也贴回来。484 个测试通过。
> 新构建（含分页修复 / T11 / T12 / 自动同步 / 这一批）**已经部署到线上**，
> 老目录备份在 `/var/www/dramatis.bak-20260920-223245`（回滚就是改名换回来）。
> 细节见 [EVAL.md](./EVAL.md) 第十五节。
>
> **接下来的接续点**：④ 网页版桥接的体验打磨（要不要在手机上也顺手、要不要记住「上次贴到哪一步」）；
> ⑤ 安卓真机（清单在 ANDROID.md）；⑥ 有域名之后部署线可以收尾（备案切 443）。

> **2026-09-20 深夜（侧边浏览器真机复测 + 总排期）**：用侧边浏览器在**线上站点**
> （390×844 手机视口，真文件选择器 + 真剪贴板）走完了「无 Key 一条龙」——
> 导入卡 → 生成提示词（952 字）→ **复制进剪贴板（读回验证）** → 贴回回复 → 贴回记忆 →
> 记忆面板 2 条，0 控制台错误。
> **测出一个硬伤**：手机上点「面板」会把对话挤成 **30px**（`.runtime-drawer` 在 flex 流里，
> 宽 340px；左栏抽屉则是正确的浮层）。这正是「手机端适配」那一块的第一项。
> 全部未完成任务的排列（先前剩下的 + 新冒出来的 + 用户点名的账号系统 / 手机端 / 数据存储）
> 写在 [TASKS.md](./TASKS.md) 的**第〇节排期总表**；测试记录见 [EVAL.md](./EVAL.md) 第十六节。
> **下一步建议**：先修 1.1（手机上面板挤压，一个 CSS 断点的事），再顺着第 1 批把手机这条线收干净。

> **2026-09-20 深夜（P0–P4 排期 + 第一批交付）**：排期按用户要求改成 **P0–P4 + 真实处理顺序**
> （见 [TASKS.md](./TASKS.md) 第〇节的总表：20 条，一条一行，写清级别、为什么排在这儿）。
> **第一批（P0）已交付并上线**：手机上点「面板」不会再把人挤出去——改前会话区 30px、
> 改后 **378px**，面板变成右侧覆盖层（遮罩 + 收起出口）；同批还收了左抽屉自动收起、
> 桥接面板窄屏竖排、安全区与 `viewport-fit=cover`、同步面板「用本站地址」一键填与恢复码复制、
> 以及一处静默失败。本机（390×844 无头）与线上（侧边浏览器 390×844）都复验过，
> 记录见 [EVAL.md](./EVAL.md) 第十七节；老网页备份在 `/var/www/dramatis.bak-20260920-224943`。
>
> **接下来的接续点**：顺序 5（iOS/安卓真机验键盘与安全区，**需要一台手机**）
> 与顺序 6（副对话也走网页版桥接——现在唯一还会卡住的入口，纯代码）。

> **2026-09-21 追加（用户提出三件事，已并入排期）**：① 「链接 DeepSeek 网页版」的原意是
> **不用复制粘贴**（我交付的是手动转接）→ 排成**顺序 7**，把三条路线的代价摊开等拍板：
> 推荐「官方 Key 极简引导」，**不做服务端代理**，本地助手（驱动你自己登录的网页）可以做但要
> 默认关闭并告知条款风险；② 「我填的 API Key 存哪、谁能看见」→ 排成**顺序 8**（写进 README 与设置里）
> 与**顺序 10**（口令加密落盘，现在是明文 localStorage，已从 P3 提到 P2）；
> ③ 顺手实测发现两件事：**线上同步库现在是空的**（`spaces/records/heads` 全 0，服务端对 22:13 建的
> 空间回 404，而日志显示当时确实推过）→ 排成顺序 11（空间消失时的可见性与一键恢复）；
> 以及 **80 端口**（外网看到的是腾讯云备案拦截页，本机看到 nginx 默认页）→ 顺序 18。
> 总表已重排为 25 条，见 [TASKS.md](./TASKS.md) 第〇节。

> **2026-09-21 推进（顺序 6 + 8，已上线）**：① **副对话（世界管理员）也能桥接了**——
> 没有 Key 时点「创建」不再直接失败：提示词里带上三个工具的声明与「这次请把工具调用写成
> JSON 块」的说明，贴回来的多个 JSON 块走**与 API 那条路同一套**校验与执行（起草角色卡 /
> 世界书 / 场景），一次贴回而不是贴三次；实测无 Key 走完「起草 → 采纳 → 进素材库」。
> ② 设置里多了一段折叠说明「**这个 Key 会被谁看见**」：你的浏览器（会话内 / 明文
> localStorage）、模型服务商（直连，Authorization 头）、同步服务端（只有密文与哈希）、
> 以及唯一的信任边界——能改这个网页的人就能读你填的 Key。记录见 [EVAL.md](./EVAL.md) 第十八节。
> ③ 顺带修掉场景草稿「没落下去也标已生效」的小毛病。
> **接下来的接续点**：顺序 5（真机键盘与安全区，需要一台手机）、顺序 7（网页版全自动，等你选路线）、
> 顺序 9-10（触控目标 / 口令加密落盘）。

> **2026-09-21（界面这一批，已上线）**：用户真机确认键盘/安全区有效（**顺序 5 收口**），
> 同时提了五件事，都落地了：**流式观感**（原来不是没流，是等待里界面一句话不说——
> 现在 0ms 就有阶段占位、推理流的尾巴实时可见，顺序 20）、**心理意图默认收起**（点开才看，
> 顺序 21）、**设置改成弹窗 + 六个大类**（顺序 22）、**三套色调**（酒馆 / 浅色白+蓝 /
> 深色黑+蓝，顺带把 18 处写死的酒馆金换成跟着强调色走的 `color-mix`，顺序 23）、
> **对话区自定义背景**（滑动时背景固定、只有对话滚，顺序 24）。
> 总表 30 条，见 [TASKS.md](./TASKS.md) 第〇节；验证记录见 [EVAL.md](./EVAL.md) 第十九节。
> **下一步**：顺序 7 等你拍板（网页版全自动走哪条路）；顺序 9/10（触控目标 / 口令加密落盘）
> 我可以直接开工；再往后是 P2 的账号与数据（12 恢复演练、13 坏记录隔离最值钱）。

> **2026-09-21 夜（真机真模型 + 账户按钮 + 持久化）**：用户存好 Key 后要求我自测，
> **在线上用真模型跑通了一轮**——阶段占位「正在判断这一轮谁开口…」在点下发送的第一帧就出现
> （顺序 20 的 P0 在真模型上确认成立），回复落盘带用量（提示 647 / 输出 59）、后台写入两条本轮记忆、
> 用量页 3 次调用（生成 / 一轮分析 / 意图判断），0 控制台错误。本轮还交付：**左栏底部拆出
> 「账户」按钮（1/4 宽）**，直接开设置弹窗的「账户」档（我是谁 + 多设备同步），分类收成 5 档；
> **持久化不再沉默**——点完如实回报，被拒时说明「Chrome 按装没装成应用判断」并给出装成应用的路，
> 页面加载自动申请一次，有安装机会时给真按钮。见 [EVAL.md](./EVAL.md) 第二十节。
> **下一步**：顺序 7（等拍板）、9（手机触控目标）、10（口令加密落盘）。

> **2026-09-21 夜（消息上的操作，顺序 39/40，已上线）**：用户提「角色回答下方那行 Token 提示
> 太碍眼、自己发言下的编辑删除也影响观感，而且手机上那几颗按钮已经超出消息框」，要的是
> **像 Codex 那套**。现在：桌面鼠标移到**某一条**消息才露出重抽/编辑/删除，右键出完整菜单
> （菜单里带 **Token 用量**与改归属）；手机什么都不常驻、**长按 450ms** 出同一个菜单，
> 菜单项 44px 高（顺手把顺序 9 的触控目标在菜单这一处补上）。
> 验证：本机无头 Chrome（1360×900 与 390×844，CDP 真触摸事件）**23/23**，
> 线上 `dramatissync.com:8443`（导入卡 → 网页版桥接跑出真消息）**13/13**；
> 过程中撞出一个真问题并修掉（顺序 40）：菜单原本绝对定位在消息列里，**最下面那条消息的
> 菜单坐标对、人看不见**——被对话区的 `overflow` 裁掉了，现在挂 `document.body` 并自动推回可视区。
> 见 [EVAL.md](./EVAL.md) 第二十四节、[LAYOUT.md](./LAYOUT.md) 第 28/29 条。
> **下一步**：顺序 38（零复制粘贴，等你点头）、10（口令加密落盘）、9（其余控件的触控目标）；
> 想先要手感就先做 9。

> **2026-09-21 夜追加（输入区，顺序 41，已上线）**：用户要求「输入框和发送键照 Codex 的样子」。
> 现在输入区是**一个圆角盒子**：输入框与下面那排控件住在同一个盒子里，焦点态由盒子统一表示
> （`focus-within` 亮边 + 一圈很淡的强调色光晕），`textarea` 自己不画边框；输入框**跟着字数
> 长高**（最多 200px）；旁边那排控件换成**无边框**的 `.composer-chip`（悬停才有一层浅底）；
> 主操作是**圆圈里一个向上的箭头**（32px / 手机上 40px），跑起来时同一位置换成描边圆圈 + 方块，
> 尺寸位置都不动；没配 Key 时它展开成「↑ 生成提示词」的胶囊。副对话的输入区跟着同一套。
> 图标是内联 SVG（新增 `apps/web/src/components/Icons.tsx`），吃 `currentColor`，三套色调自动跟。
> 验证：本机无头 Chrome（含假模型跑「发送 → 停止 → 发送」、三套色调截图、手机视口）**18/18**，
> 线上**15/15**（顺带回归了上一轮的消息菜单）。见 [EVAL.md](./EVAL.md) 第二十五节、
> [LAYOUT.md](./LAYOUT.md) 第 30/31 条。回滚点 `/var/www/dramatis.bak-20260921-185953`。
> **下一步**：还是 38（等你点头）/ 10（口令加密）/ 9（其余控件触控目标）；
> 另外「其它地方的按钮要不要一起改成无边框那套」需要你点头——那是全局改动。

> **2026-09-21 夜（顺序 42–44 + 一次 token 实测，已上线）**：用户点头做全局按钮，并提了三件小事。
> ① **顺序 42**：`.ghost` 全部去掉边框，改成「平时灰字、悬停浮出一层浅底」；**触屏**给一层
> 常驻浅底（没有悬停还什么都不留的话，手机上这些按钮会退化成纯灰字看不出能点）。
> ② **顺序 43**：消息操作按钮从气泡**里面**搬到**外面**——气泡只包住自己的字，
> 那块空位留在气泡与下一条消息之间（用户原话「不归入消息框中，仅仅放在消息框下的空位」）。
> ③ **顺序 44**：输入区「＋」里加了便捷指令：`# 动作`（插入 `#`，光标停在其后）、
> `「台词」`（光标落在两个引号中间）。
> 验证：本机 11/11，线上 17/17（含顺序 41 的回归）。回滚点 `/var/www/dramatis.bak-20260921-191649`。
> **④ 顺手回答「100 轮大概烧多少 token」**（用假模型真跑 100 轮量的，不是拍脑袋）：
> **约 27 万 token**（输入 25.7 万 + 输出 1.8 万），平均每轮 2,600 输入 + 180 输出，
> 按便宜档位约 **0.65 元**；**回复本身只占其中约 1 成**，大头是「每轮把上下文重发一遍」，
> 而且上下文到第 50 轮就封顶（装配只带最近 40 条历史）。方法与表见 [EVAL.md](./EVAL.md) 第二十六节。
> **下一步**：38（等你点头）/ 10（口令加密）/ 9（其余控件的触控目标）。

> **2026-09-21 深夜（按顺序表一次推进 5 项，已上线）**：38 与 7 在等你拍板，跳过；
> 往后顺延的五项都做完并验过：
> **10 口令加密落盘**——新增口令库（PBKDF2 600k + AES-GCM），设置里多第三档
> 「用一句口令加密后保存在本机」；真机验到**盘上没有明文 Key、也没有那句口令**，
> 口令错了明说「口令不对」，解锁后应用重新认得 Key（10/10）。**没有「忘记口令」的恢复路**，
> 想不起来就重填一次 Key——留备用钥匙等于没加密。
> **9 手机触控目标**——先量后改：390×844 逐屏枚举，过小目标 **338 个**（左栏「归档」34×22、
> 删除 ✕ 21×22、面板页签 82×29…），改成按元素给 44px 下限后剩 **5 个**，
> 全是勾选框（可点区是整个 label 行，刻意不动）；对话正文 14→15px、行高 1.7。
> **12 恢复演练**——第一次真按「换设备」走：新设备只带 id + 恢复码，两台真设备 + 真 HTTP，
> 9/9，世界/对话/场景/角色/卡/消息/身份全部回来。
> **13 坏记录隔离 + 分块推**——一条解不开的记录**不再卡死整台设备**（跳过 + 上报 + 游标照常推进），
> 推送按 200 条一块；**16 每空间配额与限流**——内核一处护栏（413 / 429），
> 自建服务器可用参数调。这两项改了协议用法，所以 [SYNC.md](./SYNC.md) 新增 §4.8 / §4.9。
> 验证：内核 507 个单测、真机 10/10 + 9/9 + 逐屏触控测量；同步服务端也已重新部署。
> 回滚点：网页 `/var/www/dramatis.bak-20260921-193521`、服务端 `/opt/dramatis-sync/dist.bak-*`。
> **下一步**：38 / 7 等你选路；再往后 **14 设备可见性与断开、15 密码轮换、19 覆盖可见性**
> 都要在线上的记录里加 `deviceId`（现在协议里没有设备字段），我建议单独一批做，先改 SYNC.md。

> **2026-09-21 深夜（「两条都推进」：38 / 7 / 14 / 15 / 19 全做完，已上线）**：
> **38 零复制粘贴**——新增本地助手 `tools/local-bridge/`（零依赖 Node，用 Chrome 调试端口
> 驱动**你自己登录的**模型网页标签页）；桥接面板上多一个「一键用本地助手」，走的是与手动粘贴
> **完全同一条**收下路径。默认不用：没起进程时按钮根本不出现，静默退回手动那三步；
> **验证全程用假网页版**（不拿你的账号做自动化），机制 5/5 + 应用内完整链路 4/4。
> **7 Key 极简引导**——「模型配置」里没填 Key 时给三步（入口直连 API keys 页 + 「粘贴并保存」）。
> **14/15/19 设备那一片**——记录带上 `deviceId` 上线上；同步面板能看「最近写过的设备」
> （本机标「这台设备」），能**换同步密码**（= 把只知道旧密码的设备断开：它再也过不了鉴权、
> 也解不开主密钥；恢复码不受影响），还能看到「有多少条是别的设备写得更旧、被本机留住了」。
> 换密码**不换主密钥**——只换锁，避免几千条记录全量重加密。协议改动写进
> [SYNC.md](./SYNC.md) §4.10。真机演练 **9/9**（旧密码 401 → 新密码重连、数据全在），
> 线上复验 **9/9**；顺手把开发后端缺的 `deviceUsage` / `rotatePassword` 补上
> （不然本机联调会像一台老服务端，这是演练里真撞出来的）。
> 回滚点：网页 `/var/www/dramatis.bak-*`、服务端 `/opt/dramatis-sync/dist.bak-*`。
> **下一步**：顺序表里 P2 还剩 **12 已完成、17 本机每日拉服务器备份 + 配额用满演练、
> 18 80 端口**；P3 是 26（管理员工具体验）、27（记忆合并成印象）、28（语音归属模型侧）、
> 29（平板与横屏）、30（备案后切 443）。

> **2026-09-21 深夜（顺序 17 / 18 / 26，已上线）**：**17** 加了「服务端快照」——
> 把服务端那份**原文**（密文 + 坐标）存成一个文件，也能原样灌回一个空的服务端，
> 超过一天没存就提醒一次（不做自动存：浏览器不让页面在无用户操作时写文件）。
> 配额用满演练用**本机跑的生产服务端**（上限调到 20 条）跑通 10/10，
> 顺带抓出三个真问题并修掉：撞满时的指引是错的（墓碑不可回收，「删掉一些」没用）、
> 护栏只在「已经满了」时才拦（一批能把 20 条顶到 27 条）、撞满后的警告会被后续成功同步清掉。
> **18** 把 80 端口查清了：服务器对外**只有 8443**，80 上没有任何我们的内容
> （外网到 80 是云网关回的 502），跳转模板备在 `deploy/nginx-80-redirect.conf.example`，
> 等备案通过再启用。**26** 管理员草稿卡片三件事：预览带**开场白**、
> 采纳后能**撤回这次采纳**（删掉刚进素材库那份、草稿退回待采纳）、
> 世界书**整本替换**说清楚。真机 8/8、线上 11/11，回滚点
> `/var/www/dramatis.bak-*` 与 `/opt/dramatis-sync/dist.bak-*`。
> **下一步**：顺序 27（低重要度记忆合并成粗粒度印象）——它是「先量再决定」那一项，
> 第一步应该是**拿真实数据量一遍**「低重要度记忆到底多不多」，再决定要不要动语义层；
> 之后是 28（语音归属模型侧）、29（平板与横屏）与等备案的 30。

> **2026-09-21 深夜（记忆与长对话：实测 + 方案）**：用户把这一块定为当前最重要的问题。
> **先量再动手**的结果（300 轮真机长跑，假模型、可复现）：提示词从第 60 轮起**封顶在 3,754 字**
> ——500 条消息**不会撑爆上下文**，601 条消息 0 报错；但**记忆按 2 条/轮线性涨到 590 条**，
> 这才是真问题（召回每次只带得进几条）。300 轮 ≈ **93 万 token ≈ 2.2 元**。
> 方案写在 [MEMORY.md](./MEMORY.md)：**常驻索引、正文按需取**（关键词或「问过去」时命中才注入），
> 新对话的记忆附件压成三层（关系现状 ≤60 字 / 时间线索引 ≤600 字 / 记忆索引 ≤1,000 字），
> 合并只标「已被取代」绝不删原文，记忆对性格情感的影响落成可追溯、可按条目回滚的记录。
> 顺序 27 因此从 P3 提到 **P1**，拆成 27a–27e，**先做 27a（记忆合并）**：
> 其余四步都以「记忆有层级」为前提。见 [TASKS.md](./TASKS.md) 与 [MEMORY.md](./MEMORY.md)。

> **2026-09-21 深夜续（默认值按 800 条输入改 + 27a 开工）**：默认**上下文窗口 16384 → 65536**、
> **回复预留 1024 → 4096**（65536 是 DeepSeek-chat 的真实窗口；800 轮约需 59k + 固定部分 3k）。
> 更要紧的一处是**历史上限**：装配里原来写死「只带最近 40 条」，**窗口调多大都没用**，
> 现在放开成 3000 条、让窗口当约束（超了由预算守卫从最旧的历史开始丢）。
> 老库里**还是老默认值**的配置由迁移 v7 自动升级，用户自己调过的数字不动。
> 小规模确认：第 60 轮的提示词从「封顶 3,733 字」变成 **6,845 字且还在长**。
> **代价必须说清**：800 轮时每轮约发 6 万 token 输入 ≈ 0.12 元/轮（聊满约 100 元，
> 而老设置只要 2 元）——这正是 27c（索引化按需检索）要解决的问题，
> 上线后近处历史可以重新收窄。
> **27a 第一步已落**：`core/memory/consolidate.ts`（决定「合并哪些」的纯函数 + 提示词构造）
> 与 7 个单测（不混视角、跳过钉住/高重要度/墓碑、先合并最旧的、时间隔远分批）。
> 下一步是把计划接进后台队列（调模型写印象、原文标 `supersededBy`，**原文永不删**）。

> **2026-09-21 深夜续（27a 完成：记忆合并真的跑起来了）**：阈值按演练调成
> **同视角低重要度（≤0.5）攒到 20 条**（原来写 0.4/40，50 轮演练里一条都没触发——
> 日常经过普遍落在 0.45 上下）。合并接进**后台队列**：每轮结算后按「每 20 条记忆」
> 排一次队（凑不够只是空跑），runner 拿最新数据决定合并哪一组；印象带 `supersedes`
> 指回原文，原文只盖「已被取代」的章、**永不删**。
> 真机演练 **5/5**（50 轮 → 1 条印象 + 20 条盖章，对账差 0）。
> **演练还抓到一个真 bug 并修掉**：`markRecalled` 会把整条记忆用**旧拷贝**写回去，
> 把合并刚盖的章静默抹掉（20 条只剩 9 条）——现在改成 `markMemoriesRecalled(ids, at)`：
> 先读最新、只改那两个字段（回归测试在 `core/storage/recall-stamp.test.ts`）。
> 530 个测试全绿，网页已上线。**下一步 27b**：新对话的记忆附件（关系现状 + 时间线索引 + 记忆索引）。

> **2026-09-21 深夜续（27b 第一步：记忆附件的形状与生成）**：新增
> `core/memory/attachment.ts`——三层附件（**关系现状** ≤60 字 / **时间线索引** ≤600 字 /
> **记忆索引** ≤1,000 字），超预算时**从最不重要的开始丢**（时间线丢最早的章、记忆丢重要度最低的），
> 并且**如实记在 `stats.dropped` 里**；关键词用启发式（参与者名、地点、章标题、
> 引号里的专名、高频短词）；附件挂在 `Card.extensions['dramatis.memoryAttachment']`，
> **跟着角色卡走**。7 个单测（三层都在、预算裁剪方向、关键词、挂卡取回）。
> **537 个测试全绿**、构建通过。
> **下一步**：27b 第二步——开新对话时用原对话的章与印象生成附件并挂到卡上；
> 然后 27c——装配提示词时**只注入索引**，对话里出现关键词才展开命中的两三条正文
> （那一步能把「满足 800 条」涨上去的 token 重新压回来）。

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
| — | **P2-6 域名上线（2026-09-20）**：HTTPS + 同源托管网页与 /sync（Let's Encrypt，DNS-01），公网两台设备端到端验证通过；同日修掉「同源 POST 也被 CORS 拦」的真 bug |
| — | **P2-6 落地部署（2026-09-20）**：用户自己的腾讯云服务器（Ubuntu 24.04 + Node 22 + systemd + SQLite + 每 6 小时备份），先用 Tailscale 内网 HTTPS 过渡（用户之后放弃该方案）、改走「域名 + HTTPS」；服务器地址 / SSH / 域名等私有信息在 `deploy/LOCAL-NOTES.md`（**已 gitignore**） |
| — | P2-6 界面接线：设置里「同步（多设备）」（地址 + 用户 id + 密码/恢复码 + 保存方式 + 上次结果）；两个独立浏览器端到端验证 |
| — | P2-6 第四步（下，部署件）：`packages/core/src/sync/sqlite.ts`（SQLite 存储 + 7 条单测）+ `tools/sync-server/`（独立服务端 / systemd / 在线备份 / 部署手册）+ CORS；跨源真机验证 13 项；**方案答卷见 [SYNC-DEPLOY.md](./SYNC-DEPLOY.md)** |
| — | **T11 记忆面板的对话维度**：对话 × 视角两个下拉、按轮分组的对照视图、「跳到原句」（切回那条对话并高亮那句话）；内核 `memory/panel-view.ts` + 10 条单测 |
| — | **T12 归档的可发现性与正文导出**：归档提示条带「去看这条对话」入口、设置里每条归档对话可「导出正文」（Markdown）；内核 `storage/transcript.ts` + 8 条单测 |
| — | **修掉一个会丢数据的同步 bug（分页拉取）**：`pull` 曾经返回全局头号当游标，新设备同步超过一页的空间时会静默只拿到一部分；现在服务端返回「这一批给到哪里」+ `serverHead` / `hasMore`，客户端分页拉到追平，**老服务器不用改也能修好**；另有「重新拉一遍」逃生口。详见 [SYNC.md](./SYNC.md) §4.7 与 EVAL 第十三节 |
| — | **每轮对话结束自动同步**：`core/sync/auto-sync.ts`（节流 20 秒、窗口内合并、尾随补一次、不重入、失败不重试）+ 7 条单测；同步面板多一行状态 |
| — | **桌面版复核（P2-9）**：四条触发条件逐条量过 → **不触发 Tauri**；补强启动器（`--prod` 判断产物是否最新、`--force-build`）+ `install-shortcut.ps1`（现场从 PNG 生成 `.ico`）；证据与复现步骤见 [DESKTOP.md](./DESKTOP.md) |
| — | **安卓壳开工（P2-10）**：`apps/android/`（Capacitor 7 + `webDir=../web/dist` + `androidScheme=https`），本机 `gradlew assembleDebug` 构建成功（4.8 MB）；四项能力在 `https://localhost`（与 WebView 同源）逐项验过；见 [ANDROID.md](./ANDROID.md) |
| — | **没有 API Key 也能聊第一轮（网页版桥接）**：发送时不再拦「还没有填 API Key」，改成把**本来要发出去的提示词**交给用户贴进 DeepSeek 网页版，回复粘回来就走与自动生成相同的落盘路径（意图解析 / 转写清理 / 气泡分段）；第二步可选地把这一轮的记忆与情绪也贴回来（内核新增 `applyTurnAnalysis`，与后台任务共用）。**已部署到线上**并真机跑通 |

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
tools/fake-model/        假模型服务（零依赖：一轮对话能在本机不花钱跑完）
apps/android/            Capacitor 安卓壳（原生工程 android/ 不进版本库）
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
pnpm test           # 全部单元测试（数量以输出为准）
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

**不花钱跑整条链路的两件工具**（2026-09-20 加的，界面回归靠它们）：

```bash
# 假模型：OpenAI 兼容 + SSE，按提示词形状分派「意图 / 一轮分析 / 分层摘要 / 角色生成」，
# 每个请求打到 stderr。在应用的「模型接入」里填 http://127.0.0.1:5280 + 随便一个非空密钥。
node tools/fake-model/server.mjs --port 5280

# 世界种子探针：往本机库里种一个已知规模的世界（三条主线 + 副对话 + 已归档线，78 条记忆），
# 用来复现「面板里混了几条线」这类问题。**会先跑一次 migrate()**（否则应用下次打开会把
# 它当成老库、重跑 v3 给世界再补一条空的主线对话——踩过）。
#    http://127.0.0.1:5273/tools/world-seed-probe.html
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

**顺带一件小事（不用等域名）**：分页漏拉的修复（SYNC §4.7）同时改了**服务端**的
`pull` 返回值。客户端对新旧两种服务端都兼容，所以**不重新部署也不会丢数据**；
但那台腾讯云上跑的仍是旧版，哪天顺手重新部署一次更干净（步骤见下面的环境表：
`pnpm build:sync-server` → `scp` → 服务器上换 dist 并重启）。这次不需要动数据库。

## 下一轮怎么开（给新会话的提示词）

> 直接复制下面这段作为新会话的第一条消息：

```text
接着做 Dramatis（多角色扮演酒馆）。先读 docs/STATUS.md（接续点）、docs/TASKS.md（工作清单）、
docs/ROADMAP.md（长期路线）与 docs/LAYOUT.md（界面规格）。

现状（2026-09-20 晚，468 个测试通过）：项目主体这一批做完了 T11（记忆面板的对话维度）、
T12（归档的可发现性与正文导出）、每轮结束自动同步，并修掉一个会丢数据的同步 bug（分页拉取，
见 SYNC.md §4.7 与 EVAL 第十三节）。桌面版复核完（P2-9 不触发 Tauri，见 DESKTOP.md）；
安卓壳搭起来并本机构建出 APK，四项能力在与 WebView 同源的环境验过，**真机没跑**（见 ANDROID.md）。
部署那条线（域名 + HTTPS + 备案）仍搁置，服务器私有信息在 deploy/LOCAL-NOTES.md（已 gitignore）。

这一轮建议按这个顺序做：

1) **安卓真机验证**（最该先做，因为桌面壳/手机这两条路都卡在这一步）：把
   apps/android/android/app/build/outputs/apk/debug/app-debug.apk 装到手机上，按 ANDROID.md
   末尾那张清单逐条跑——重点是 ① WebView 里的文件导出（可能要加 @capacitor/filesystem）
   ② 切后台再回来时后台队列的行为 ③ 键盘与安全区 ④ IndexedDB 有没有拿到持久化。
   发现问题就当场修（能构建/能测试/能提交），并把结论写回 ANDROID.md 与 EVAL。
2) **项目主体**：从 docs/TASKS.md 挑 2~3 项（候选：T13 世界管理员工具的体验、T3 后半的
   「记忆合并成粗粒度印象」、记录分块与坏记录隔离）。**先用真实数据或真机复现再动手**。
3) 有域名了就插 部署线 那条（STATUS 末尾有现成的提示词）。

要求：每一小步都能构建/测试/提交；提交信息带任务编号；实现与计划有偏差写进文档；
真机验证；**任何用户私有信息（域名/IP/凭据）都不进仓库**。
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
| **改完网页怎么上线**（2026-09-20 实践过） | 本机 `pnpm build` → `scp -r apps/web/dist dramatis:/tmp/dist-web-new` → 服务器上 `sudo mv /var/www/dramatis /var/www/dramatis.bak-$(date +%Y%m%d-%H%M%S) && sudo mv /tmp/dist-web-new /var/www/dramatis && sudo chown -R root:root /var/www/dramatis && sudo chmod -R a+rX /var/www/dramatis`。**权限那一步不能省**（scp 过来是 700，nginx 读不到就是 500）。验证：`curl -s https://dramatissync.com:8443/ \| grep -o 'assets/index-[A-Za-z0-9_-]*\.js'` 看哈希有没有变；`curl -s -o /dev/null -w '%{http_code}' https://dramatissync.com:8443/sync/spaces/probe/head` 应该是 404（说明反代活着）而不是 502 |
| SSH/SCP 的坑 | Windows 下私钥必须先 `icacls <key> /inheritance:r /grant:r "<账户>:(R)"`，否则 OpenSSH 报 "bad permissions" 直接忽略；`scp`/`ssh` 一律要用**提权**执行，否则读不到 `~/.ssh/config`（表现为 `Could not resolve hostname dramatis`） |
| 真模型验证 | 两条路：应用里直接聊（Key 在浏览器配置里），或 `pnpm --filter @dramatis/core test prompt-samples --silent=false --disableConsoleIntercept` 生成提示词、贴进 DeepSeek 网页版 |
| 假模型（不花钱跑一整轮） | `node tools/fake-model/server.mjs --port 5280`，应用里把接口地址填 `http://127.0.0.1:5280`、模型 `fake-model`、密钥随便填一个非空值。日志打在 stderr，能核对这一回合发了几次调用 |
| 世界种子探针 | `http://127.0.0.1:5273/tools/world-seed-probe.html`（种一个已知规模的世界；**先 migrate 再种**，否则应用会把库当成老库重跑 v3） |
| 平台能力探针 | `http://127.0.0.1:5273/tools/platform-probe.html`（真浏览器里问一遍：后台执行 / 密钥存储 / 本地模型 / 文件夹监控各有没有） |
| 桌面端（真机） | `pnpm desktop:prod`（会跳过无谓的构建；`--force-build` 强制重建）。给用户做快捷方式：`pwsh -File tools/desktop/install-shortcut.ps1 -Destination Both` |
| 安卓构建 | **JDK 必须是 21**：`$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'`，然后 `pnpm --filter @dramatis/android apk`。本机缓存里的 AGP 是 8.7.3（模板写 8.7.2），且模板那行 `google-services` 本机没有、也用不到——都只影响被 gitignore 的生成目录 |
| 安卓真机 | `adb install -r apps/android/android/app/build/outputs/apk/debug/app-debug.apk`（手机开 USB 调试；本机 adb 在 `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`） |
