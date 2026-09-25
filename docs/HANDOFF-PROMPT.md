# 新会话交接提示词（Dramatis）

> 用途：把下面「提示词正文」整段贴给一个新的编码会话（例如 DeepSeek 官方 Agent），
> 它就能先建立对项目的整体认识、再按队列接手。本文只写**该知道的**，不写任何域名、IP、
> 凭据——那些只在 `deploy/LOCAL-NOTES.md`（已 gitignore）。

## 提示词正文

```text
你接手一个已经在跑的项目：Dramatis，工作目录 C:\Users\35350\Desktop\another life。
你是这个项目的实现者与看护者。用户是中文用户，交流用中文。

【产品是什么】
Dramatis 是一个「本地优先的角色扮演 / 互动故事引擎」：用户导入角色卡（SillyTavern
v2/v3 PNG 或 JSON）与世界书，在一个世界里开多条对话；角色有性格、情绪、关系与记忆，
长对话里要靠记忆与场记保持一致性。模型接入由用户自带 Key（OpenAI 兼容协议：DeepSeek、
OpenAI、Ollama、LM Studio 等都走同一条路），提示词由客户端本地拼装；数据存在浏览器
IndexedDB（本机优先），可选多设备同步（自有同步服务端 + 账户密码派生密钥）。
手机端是主要使用场景之一，界面规格以 LAYOUT.md 为准。

【技术栈与仓库结构】
- pnpm monorepo：packages/core（内核，纯 TS，含模型/存储/提示词/记忆/同步协议）、
  apps/web（React + Vite 前端）、tools/sync-server（同步服务端，Node + SQLite）。
- 内核目录：packages/core/src/{model,storage,session,prompt,provider,memory,render,
  director,admin,compat,crypto,sync,platform,token,types,util,eval}
- 前端目录：apps/web/src/{App.tsx,hooks,components,lib,plan}；工具页在 apps/web/tools。
- 根脚本：pnpm dev（起前端）、pnpm typecheck、pnpm lint、pnpm test、pnpm build、
  pnpm build:sync-server。

【先读什么（按这个顺序，读完再动手）】
1. docs/STATUS.md —— 此刻在哪里、下一步做什么。
2. docs/TASKS.md 的**第〇节「总表」** —— 当前有效的处理顺序（顺序号就是工作单元）。
3. docs/MEMORY.md —— 记忆/召回/场记的设计与实测曲线。
4. docs/EVAL.md 的最近 5–8 节 —— 最近每批做了什么、验到什么程度、哪些还是「待验证」。
5. docs/FILE-LOG.md 最后一节 —— 最近动过哪些文件。
6. 需要时再读：docs/LAYOUT.md（界面规格）、docs/DESIGN.md（架构与数据模型）、
   docs/SYNC.md（同步协议与数据安全）、docs/ROLEPLAY-PROMPT.md（角色沉浸提示词模板）、
   docs/QUALITY.md（对话质量评分表与「AI 腔」清单）、docs/ROADMAP.md（长期路线）。

【硬约束（违反就是事故）】
1. 绝不使用 git reset / restore / checkout / stash / clean。工作区可能有别人正在写的改动，
   先 `git status` 看清，再决定动哪些文件；不确定就绕开那些文件。
2. 不提交、不写进任何仓库文件：域名、IP、凭据、API Key、`deploy/LOCAL-NOTES.md`。
   用户的 Key 只存在于他自己的浏览器/设备上，你既不要读也不要打印。
3. 未经用户明确要求，不部署、不 push、不动线上。要动就严格按 deploy/LOCAL-NOTES.md
   的流程（先在暂存目录落地、确认到位再改名备份、切权限、再验证）。
4. 同步与数据安全是底线：任何性能或界面优化都不得破坏同步协议、不得造成数据丢失或
   静默丢弃（宁可报错，也不要假装成功）。写库相关的改动要问自己「断电/失败会留下什么」。
5. 一次只做一件事（一个顺序号），做完就提交，提交信息带顺序号（例：`顺序 67e：…`）。

【每次提交前的五项门禁（必须全绿）】
    pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm build:sync-server
lint 有历史 warning 可以留着，但**不许新增 error**。

【文档随代码一起更新（这是项目约定）】
- docs/TASKS.md 第〇节：勾掉做完的、加上新冒出来的（含「怎么做/怎么验」）。
- docs/EVAL.md：新增一节，写清做法、实测数字、**没验到什么**。
- docs/STATUS.md：一行说明当前状态。
- docs/FILE-LOG.md：本轮改动的文件清单。

【验证边界（很重要，决定了你能不能下结论）】
- 你可以做：typecheck、lint、单测、构建、用**假模型/假响应**跑逻辑、读代码、写文档。
- 你不能替代：真实浏览器真机验证（含手机尺寸、软键盘、安全区）与真实模型/真实 Key 的
  效果验证——这一层由 Codex（本机浏览器 + 用户的真实配置）做。
- 因此：凡是没在真实环境跑过的，只能写「待验证」，不许写成「已通过」。
- 用户 2026-09-25 明确要求：**对话质量类结论不许用假模型得出**（假模型只能测链路，
  不能测质量）。
- 不许做：Playwright/真机以外的「线上站点」压测、真实 API Key 探测、内容过滤绕过。

【当前状态（截至 2026-09-25 傍晚）】
- HEAD：`54b20b8`（`ec870b5` 顺序 67e + 修复 67d 补全）；已 push 到 origin/main。
- 线上网页产物：`assets/index-9gmcgFkQ.js`（含顺序 67e 与 67d）；同步服务 `/sync/health` 正常。
- 最近三批：67c（DeepSeek 现行模型名 + 回复完整性：内容过滤/截断/断流不再当成功）、
  67d（角色沉浸模板成为角色卡「系统提示」默认值）、67e（长对话质量：回答长度三档 +
  反重复规矩 + 输入区加号菜单）。
- 队列里下一批（见 TASKS 第〇节总表，按顺序号推进，不许插队）：
  68 账单查询下推、69 可访问性、70 打包懒加载、71 token 估算校准、72 dedupeRecalled、
  73 部署文档漂移、74 local-bridge 加固、75 供应商流剩余兼容项、76 App.tsx 布局壳拆组件、
  77 重抽成功后多步写入事务化；78「一轮内多个角色作答」与 79「跨角色串线检测」是用户
  2026-09-25 拍板的方向（78 待排期、79 暂缓）。
- 未验项（别当成已完成）：①顺序 67e 的长度三档在真实模型上到底收住多少——基线是
  178 轮长跑里「回复 171→325 字、自称名字 0.9→5.6 次」，改完必须用同一套台词复跑才算
  有效；②一条异常：侧边浏览器里曾连续三条消息落盘却没有回话、页面无任何报错（疑似
  自动化时序，也可能是静默丢回合的真 bug），需要干净复跑定性；③真机手机软键盘与安全区；
  ④顺序 60 的世界书位置语义在真实世界书上的端到端。

【代码地图（改哪里，连带看什么）】
| 想改什么 | 主要文件 | 连带要看的 |
| --- | --- | --- |
| 提示词拼装、长度/风格规矩 | packages/core/src/prompt/{assemble,history,reply-style,budget,types}.ts | prompt/assemble.test.ts、docs/QUALITY.md |
| 对话模式（含回答长度） | packages/core/src/model/conversation.ts | apps/web/src/components/MainChat.tsx 的加号菜单 |
| 角色卡与世界书 | packages/core/src/model/card.ts、compat/sillytavern/{card,png,worldbook}.ts | docs/ROLEPLAY-PROMPT.md |
| 记忆、召回、场记、章节 | packages/core/src/memory/*、director/* | docs/MEMORY.md、EVAL 第 46/47 节 |
| 模型接入与流式 | packages/core/src/provider/openai-compatible.ts | docs/EVAL.md 第六十六节（回复完整性） |
| 存储与仓储 | packages/core/src/storage/repository.ts | 顺序 62 的索引/缓存结论 |
| 主对话流程 | apps/web/src/hooks/useTurnRunner.ts、apps/web/src/App.tsx | 顺序 59（流式只重画气泡）/66（App 拆 hook） |
| 同步协议与数据安全 | packages/core/src/sync/*、tools/sync-server/src/* | docs/SYNC.md、EVAL 第五十节 |

【环境与常见坑】
- 本机 Vite 默认只绑 `localhost`/`::1`；要 `--host 127.0.0.1` 才在 `127.0.0.1:5273` 可用。
- 在仓库外新建干净检出后 `pnpm install --offline` 可能缺 tarball（例如 biome）；要么联网装，
  要么直接在主工作区构建。
- `git add/commit` 在沙箱里可能报 `.git/index.lock: Permission denied`，需要提权执行。
- 两条会话可能同时在同一个仓库工作：**只 add 你确实改过的路径**，否则会把别人的半成品
  带进你的提交（`ec870b5` 就这么发生过一次，靠 `54b20b8` 补齐才自洽）。
- 用户对进度敏感：每完成 5 个任务做一次完整汇报；中途发现问题边做边提，不要停下来等确认
  （除非要动线上、要花钱、或有数据风险）。

【你这一轮怎么开始】
1. 先只读：`git log --oneline -8`、`git status`、docs/STATUS.md、docs/TASKS.md 第〇节
   总表、docs/EVAL.md 最后三节。
2. 用你自己的话向用户复述：项目目标、当前 HEAD、队列里下一批是哪一条、你打算怎么验。
3. 等用户点头后，从队列的下一个顺序号开始，一次一件，做完跑五项门禁、更新四处文档、
   提交（提交信息带顺序号），并按用户的节奏汇报。
4. 任何你无法在本机验证的结论，明确写「待 Codex 真机/真模型验证」。
```

## 用法说明（给用户）

1. 把上面代码块里的内容整段复制给新会话，作为第一条消息。
2. 新会话需要能读到本仓库（同一台机器 / 同一工作目录）。若它跑在别处，先把仓库放到它
   能访问的路径，并把路径那一行改掉。
3. 这份提示词不包含任何域名、地址与凭据；需要部署细节时，让新会话自己读
   `deploy/LOCAL-NOTES.md`（gitignore，不进仓库）。
4. 每次交接建议让新会话先复述一遍理解，再动手——省掉「按自己理解改错方向」的返工。
