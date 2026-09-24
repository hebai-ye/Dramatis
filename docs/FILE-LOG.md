# 文件日志 · 创建与修改时间

> 这份文档记录**每个文件的创建时间、修改时间与提交时间**，用途有三个：
> 追溯某段代码是什么时候加进来的、判断哪些文件已经很久没动过、
> 以及在工作交接时快速看清「最近动过什么」。
>
> 路径一律是**相对于项目根目录**的相对路径。
> 重点部分见第一节（各 `.md` 文档的用途）。
>
> 生成时间：2026-09-16 23:05；**最新一批改动见第七节**（T2c 生成前意图调用、T7 用量账单、
> T3 分层摘要）。
> 第二～五节的时间表是 23:05 的快照（当时仓库里还没有 T17/T18/T2/T2c 这些提交），
> 之后新增或改过的文件统一记在第七节，以**提交时间**为准。

## 时间列的含义

| 列 | 来源 | 说明 |
| --- | --- | --- |
| 创建 | 文件系统的 `CreationTime` | 本机上的落盘时间。**重新克隆或复制项目会重置**，只在同一台机器上有意义 |
| 修改 | 文件系统的 `LastWriteTime` | 同上；但如果文件在提交后被再改过，它比「最近提交」新 |
| 首次提交 | `git log --diff-filter=A` | 这个文件**进入版本库**的时间（权威的「创建」） |
| 最近提交 | 排在最新一次触及该文件的提交时间 | 权威的「最后修改」；比文件系统时间更可靠 |

重新生成这张表：

```powershell
git ls-files | ForEach-Object {
  $i = Get-Item $_
  "{0}`t{1}`t{2}" -f $_, $i.CreationTime.ToString('yyyy-MM-dd HH:mm'), $i.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
}
```

---

## 一、各 Markdown 文档的用途（重点）

| 文档 | 创建 | 修改 | 用途 |
| --- | --- | --- | --- |
| [`README.md`](../README.md) | 2026-09-16 00:05 | 2026-09-19 17:29 | **项目门面**。给第一次看到这个仓库的人：一句话定位、与 SillyTavern 的关系、已经能用的功能清单、桌面入口与快速开始、核心设计摘要、路线图状态。也承担英文 TL;DR 与关键词，便于被搜索到 |
| [`docs/DESIGN.md`](DESIGN.md) | 2026-09-16 00:05 | 2026-09-16 18:12 | **设计依据**。数据模型、记忆分层、Prompt 装配顺序、平台适配层的原始设计。ROADMAP 的每条任务都要能追溯到这里；改实现前先看它 |
| [`docs/ROADMAP.md`](ROADMAP.md) | 2026-09-16 11:10 | 2026-09-19 22:23 | **执行计划**。P0–P3 全部任务、依赖关系、执行顺序、风险登记册、验收标准、任务状态表。每个批次的「实现说明」也写在这里（踩过的坑、与计划的偏差） |
| [`docs/LAYOUT.md`](LAYOUT.md) | 2026-09-16 21:26 | 2026-09-19 22:06 | **界面与交互规格**。来自手绘草图与逐区域填写，是界面实现的唯一依据；含「与当前实现的差异」对照表、三批进度、以及**实现时的取舍**（哪些细节规格没写、实现时怎么定的） |
| [`docs/STATUS.md`](STATUS.md) | 2026-09-16 20:49 | 2026-09-19 22:22 | **接续点**。给下一个会话（或下一个人）：一句话状态、已完成批次、不可回退的设计决定、待办与卡点、怎么继续跑。**新会话应当先读它** |
| [`docs/EVAL.md`](EVAL.md) | 2026-09-16 18:46 | 2026-09-19 22:33 | **评测与验证**。上半部分是自动化基线（脚本化模型的 50 回合长跑与压力场景及其结论），下半部分是真模型人工验证：怎么生成提示词、判定标准，加上七轮验证记录与 T7 的界面回归（含 T4 长跑、T2c 意图、T3 分层摘要、用量账单） |
| [`docs/SYNC.md`](SYNC.md) | 2026-09-19 22:21 | 2026-09-19 22:21 | **账号与同步的方案选型**（P2-5 的交付物）。三个问题——账号是什么、后端放哪儿、加密做到哪一步——各有结论与**被否方案的死因**；含协议草案（同步单位、白名单、冲突策略、拉取循环）与「数据层要先补什么」的开工顺序 |
| [`docs/TASKS.md`](TASKS.md) | 2026-09-16 23:04 | 2026-09-19 22:22 | **工作清单**。回答「下一批动手做什么」：P1 收尾、验证任务、P2 功能添加、真实使用中发现的优化项，各带来源、验收标准与建议顺序。与 ROADMAP 的分工写在文首 |
| [`docs/FILE-LOG.md`](FILE-LOG.md) | 2026-09-16 23:05 | 2026-09-19 22:27 | **本文档**。文件级时间日志：每个文件的创建/修改/提交时间（第二～五节是 09-16 23:05 的快照，之后的变更集中在第七节），加上各 md 文档的用途索引 |

---

## 二、根目录与工程配置

| 相对路径 | 创建 | 修改 | 首次提交 | 最近提交 |
| --- | --- | --- | --- | --- |
| `.editorconfig` | 2026-09-16 00:05 | 2026-09-16 00:05 | 2026-09-16 00:11 | 2026-09-16 00:11 |
| `.gitattributes` | 2026-09-16 00:05 | 2026-09-16 00:05 | 2026-09-16 00:11 | 2026-09-16 00:11 |
| `.gitignore` | 2026-09-16 00:05 | 2026-09-16 00:05 | 2026-09-16 00:11 | 2026-09-16 00:11 |
| `.github/workflows/ci.yml` | 2026-09-16 18:10 | 2026-09-16 18:10 | 2026-09-16 18:12 | 2026-09-16 18:12 |
| `LICENSE` | 2026-09-16 00:05 | 2026-09-16 00:05 | 2026-09-16 00:11 | 2026-09-16 00:11 |
| `README.md` | 2026-09-16 00:05 | 2026-09-16 22:04 | 2026-09-16 00:11 | 2026-09-16 22:04 |
| `biome.json` | 2026-09-16 18:10 | 2026-09-16 18:10 | 2026-09-16 18:12 | 2026-09-16 18:12 |
| `package.json` | 2026-09-16 00:14 | 2026-09-16 18:26 | 2026-09-16 00:21 | 2026-09-16 18:28 |
| `pnpm-lock.yaml` | 2026-09-16 18:10 | 2026-09-16 18:10 | 2026-09-16 00:21 | 2026-09-16 18:12 |
| `pnpm-workspace.yaml` | 2026-09-16 18:10 | 2026-09-16 18:10 | 2026-09-16 00:21 | 2026-09-16 18:12 |
| `start-dramatis.cmd` | 2026-09-16 18:26 | 2026-09-16 18:32 | 2026-09-16 18:28 | 2026-09-16 18:33 |
| `tsconfig.base.json` | 2026-09-16 00:14 | 2026-09-16 00:14 | 2026-09-16 00:21 | 2026-09-16 00:21 |

## 三、`packages/core` · 平台无关内核

### 入口与模型

| 相对路径 | 创建 | 修改 | 首次提交 | 最近提交 |
| --- | --- | --- | --- | --- |
| `packages/core/package.json` | 2026-09-16 00:14 | 2026-09-16 00:14 | 2026-09-16 00:21 | 2026-09-16 00:21 |
| `packages/core/tsconfig.json` | 2026-09-16 00:14 | 2026-09-16 00:14 | 2026-09-16 00:21 | 2026-09-16 00:21 |
| `packages/core/src/index.ts` | 2026-09-16 00:17 | 2026-09-16 21:48 | 2026-09-16 00:21 | 2026-09-16 21:48 |
| `packages/core/src/model/index.ts` | 2026-09-16 00:14 | 2026-09-16 21:44 | 2026-09-16 00:21 | 2026-09-16 21:46 |
| `packages/core/src/model/ids.ts` | 2026-09-16 00:14 | 2026-09-16 21:41 | 2026-09-16 00:21 | 2026-09-16 21:46 |
| `packages/core/src/model/card.ts` | 2026-09-16 00:14 | 2026-09-16 20:32 | 2026-09-16 00:21 | 2026-09-16 20:36 |
| `packages/core/src/model/instance.ts` | 2026-09-16 00:14 | 2026-09-16 18:10 | 2026-09-16 00:21 | 2026-09-16 18:12 |
| `packages/core/src/model/message.ts` | 2026-09-16 00:14 | 2026-09-16 22:55 | 2026-09-16 00:21 | 2026-09-16 22:03 |
| `packages/core/src/model/conversation.ts` | 2026-09-16 21:41 | 2026-09-16 21:45 | 2026-09-16 21:46 | 2026-09-16 21:46 |
| `packages/core/src/model/persona.ts` | 2026-09-16 18:15 | 2026-09-16 18:15 | 2026-09-16 18:23 | 2026-09-16 18:23 |
| `packages/core/src/model/provider.ts` | 2026-09-16 18:06 | 2026-09-16 18:06 | 2026-09-16 18:12 | 2026-09-16 18:12 |
| `packages/core/src/model/room.ts` | 2026-09-16 00:14 | 2026-09-16 21:42 | 2026-09-16 00:21 | 2026-09-16 21:46 |

### 兼容层（SillyTavern）

| 相对路径 | 创建 | 修改 | 首次提交 | 最近提交 |
| --- | --- | --- | --- | --- |
| `packages/core/src/compat/sillytavern/index.ts` | 2026-09-16 00:15 | 2026-09-16 18:10 | 2026-09-16 00:21 | 2026-09-16 18:12 |
| `packages/core/src/compat/sillytavern/card.ts` | 2026-09-16 00:15 | 2026-09-16 00:19 | 2026-09-16 00:21 | 2026-09-16 00:21 |
| `packages/core/src/compat/sillytavern/card.test.ts` | 2026-09-16 00:18 | 2026-09-16 00:20 | 2026-09-16 00:21 | 2026-09-16 00:21 |
| `packages/core/src/compat/sillytavern/png.ts` | 2026-09-16 00:15 | 2026-09-16 18:10 | 2026-09-16 00:21 | 2026-09-16 18:12 |
| `packages/core/src/compat/sillytavern/png.test.ts` | 2026-09-16 00:18 | 2026-09-16 18:10 | 2026-09-16 00:21 | 2026-09-16 18:12 |
| `packages/core/src/compat/sillytavern/inflate.ts` | 2026-09-16 00:15 | 2026-09-16 18:10 | 2026-09-16 00:21 | 2026-09-16 18:12 |
| `packages/core/src/compat/sillytavern/worldbook.ts` | 2026-09-16 00:15 | 2026-09-16 18:10 | 2026-09-16 00:21 | 2026-09-16 18:12 |
| `packages/core/src/compat/sillytavern/worldbook.test.ts` | 2026-09-16 00:18 | 2026-09-16 00:18 | 2026-09-16 00:21 | 2026-09-16 00:21 |

### 记忆系统

| 相对路径 | 创建 | 修改 | 首次提交 | 最近提交 |
| --- | --- | --- | --- | --- |
| `packages/core/src/memory/types.ts` | 2026-09-16 18:37 | 2026-09-16 18:37 | 2026-09-16 18:42 | 2026-09-16 18:42 |
| `packages/core/src/memory/extract.ts` | 2026-09-16 18:38 | 2026-09-16 18:41 | 2026-09-16 18:42 | 2026-09-16 18:42 |
| `packages/core/src/memory/extract.test.ts` | 2026-09-16 18:38 | 2026-09-16 21:44 | 2026-09-16 18:42 | 2026-09-16 21:46 |
| `packages/core/src/memory/ingest.ts` | 2026-09-16 18:38 | 2026-09-16 21:43 | 2026-09-16 18:42 | 2026-09-16 21:46 |
| `packages/core/src/memory/ingest.test.ts` | 2026-09-16 18:39 | 2026-09-16 18:41 | 2026-09-16 18:42 | 2026-09-16 18:42 |
| `packages/core/src/memory/recall.ts` | 2026-09-16 18:38 | 2026-09-16 18:41 | 2026-09-16 18:42 | 2026-09-16 18:42 |
| `packages/core/src/memory/recall.test.ts` | 2026-09-16 18:39 | 2026-09-16 21:44 | 2026-09-16 18:42 | 2026-09-16 21:46 |
| `packages/core/src/memory/affect.ts` | 2026-09-16 20:24 | 2026-09-16 20:26 | 2026-09-16 20:27 | 2026-09-16 20:27 |
| `packages/core/src/memory/affect.test.ts` | 2026-09-16 20:24 | 2026-09-16 20:26 | 2026-09-16 20:27 | 2026-09-16 20:27 |

### Prompt 装配与预算

| 相对路径 | 创建 | 修改 | 首次提交 | 最近提交 |
| --- | --- | --- | --- | --- |
| `packages/core/src/prompt/types.ts` | 2026-09-16 00:15 | 2026-09-16 21:46 | 2026-09-16 00:21 | 2026-09-16 21:48 |
| `packages/core/src/prompt/assemble.ts` | 2026-09-16 00:16 | 2026-09-16 22:32 | 2026-09-16 00:21 | 2026-09-16 22:41 |
| `packages/core/src/prompt/assemble.test.ts` | 2026-09-16 00:19 | 2026-09-16 22:31 | 2026-09-16 00:21 | 2026-09-16 22:41 |
| `packages/core/src/prompt/budget.ts` | 2026-09-16 00:15 | 2026-09-16 18:10 | 2026-09-16 00:21 | 2026-09-16 18:12 |
| `packages/core/src/prompt/budget.test.ts` | 2026-09-16 00:19 | 2026-09-16 00:19 | 2026-09-16 00:21 | 2026-09-16 00:21 |
| `packages/core/src/prompt/history.ts` | 2026-09-16 18:15 | 2026-09-16 18:15 | 2026-09-16 18:23 | 2026-09-16 18:23 |
| `packages/core/src/prompt/history.test.ts` | 2026-09-16 18:17 | 2026-09-16 21:44 | 2026-09-16 18:23 | 2026-09-16 21:46 |

### 调度、渲染、管理员工具

| 相对路径 | 创建 | 修改 | 首次提交 | 最近提交 |
| --- | --- | --- | --- | --- |
| `packages/core/src/director/scheduler.ts` | 2026-09-16 18:15 | 2026-09-16 22:59 | 2026-09-16 18:23 | 2026-09-16 23:02 |
| `packages/core/src/director/scheduler.test.ts` | 2026-09-16 18:17 | 2026-09-16 23:00 | 2026-09-16 18:23 | 2026-09-16 23:02 |
| `packages/core/src/render/segments.ts` | 2026-09-16 21:42 | 2026-09-16 22:33 | 2026-09-16 21:46 | 2026-09-16 22:41 |
| `packages/core/src/render/segments.test.ts` | 2026-09-16 21:45 | 2026-09-16 22:33 | 2026-09-16 21:46 | 2026-09-16 22:41 |
| `packages/core/src/render/narration.ts` | 2026-09-16 21:42 | 2026-09-16 21:45 | 2026-09-16 21:46 | 2026-09-16 21:46 |
| `packages/core/src/render/narration.test.ts` | 2026-09-16 21:45 | 2026-09-16 21:45 | 2026-09-16 21:46 | 2026-09-16 21:46 |
| `packages/core/src/admin/prompt.ts` | 2026-09-16 21:47 | 2026-09-16 22:17 | 2026-09-16 21:48 | 2026-09-16 22:19 |
| `packages/core/src/admin/tools.ts` | 2026-09-16 21:47 | 2026-09-16 22:18 | 2026-09-16 21:48 | 2026-09-16 22:19 |
| `packages/core/src/admin/tools.test.ts` | 2026-09-16 21:47 | 2026-09-16 22:18 | 2026-09-16 21:48 | 2026-09-16 22:19 |
| `packages/core/src/admin/turn.ts` | 2026-09-16 21:47 | 2026-09-16 21:48 | 2026-09-16 21:48 | 2026-09-16 21:48 |
| `packages/core/src/admin/turn.test.ts` | 2026-09-16 21:47 | 2026-09-16 21:48 | 2026-09-16 21:48 | 2026-09-16 21:48 |

### 会话、存储、平台适配、模型接入

| 相对路径 | 创建 | 修改 | 首次提交 | 最近提交 |
| --- | --- | --- | --- | --- |
| `packages/core/src/session/turn.ts` | 2026-09-16 00:17 | 2026-09-16 22:56 | 2026-09-16 00:21 | 2026-09-16 21:46 |
| `packages/core/src/session/turn.test.ts` | 2026-09-16 22:58 | 2026-09-16 22:58 | 2026-09-16 23:02 | 2026-09-16 23:02 |
| `packages/core/src/session/setup.ts` | 2026-09-16 21:43 | 2026-09-16 21:45 | 2026-09-16 21:46 | 2026-09-16 21:46 |
| `packages/core/src/storage/repository.ts` | 2026-09-16 18:06 | 2026-09-16 22:02 | 2026-09-16 18:12 | 2026-09-16 22:03 |
| `packages/core/src/storage/repository.test.ts` | 2026-09-16 18:07 | 2026-09-16 21:45 | 2026-09-16 18:12 | 2026-09-16 21:46 |
| `packages/core/src/storage/conversation.test.ts` | 2026-09-16 21:45 | 2026-09-16 21:46 | 2026-09-16 21:46 | 2026-09-16 21:46 |
| `packages/core/src/storage/artifact.test.ts` | 2026-09-16 21:49 | 2026-09-16 21:49 | 2026-09-16 22:03 | 2026-09-16 22:03 |
| `packages/core/src/platform/background-runner.ts` | 2026-09-16 18:06 | 2026-09-16 22:39 | 2026-09-16 18:12 | 2026-09-16 22:41 |
| `packages/core/src/platform/background-runner.test.ts` | 2026-09-16 18:07 | 2026-09-16 22:39 | 2026-09-16 18:12 | 2026-09-16 22:41 |
| `packages/core/src/platform/entity-store.ts` | 2026-09-16 18:06 | 2026-09-16 18:06 | 2026-09-16 18:12 | 2026-09-16 18:12 |
| `packages/core/src/platform/key-store.ts` | 2026-09-16 18:06 | 2026-09-16 18:06 | 2026-09-16 18:12 | 2026-09-16 18:12 |
| `packages/core/src/platform/file-io.ts` | 2026-09-16 18:06 | 2026-09-16 18:06 | 2026-09-16 18:12 | 2026-09-16 18:12 |
| `packages/core/src/platform/memory-store.ts` | 2026-09-16 18:06 | 2026-09-16 18:10 | 2026-09-16 18:12 | 2026-09-16 18:12 |
| `packages/core/src/provider/openai-compatible.ts` | 2026-09-16 00:16 | 2026-09-16 21:48 | 2026-09-16 00:21 | 2026-09-16 21:48 |
| `packages/core/src/provider/collect.ts` | 2026-09-16 18:39 | 2026-09-16 22:56 | 2026-09-16 18:42 | 2026-09-16 21:48 |
| `packages/core/src/provider/tools.test.ts` | 2026-09-16 21:48 | 2026-09-16 22:58 | 2026-09-16 21:48 | 2026-09-16 21:48 |
| `packages/core/src/token/estimate.ts` | 2026-09-16 00:15 | 2026-09-16 00:15 | 2026-09-16 00:21 | 2026-09-16 00:21 |
| `packages/core/src/token/estimate.test.ts` | 2026-09-16 00:19 | 2026-09-16 00:19 | 2026-09-16 00:21 | 2026-09-16 00:21 |

### 评测

| 相对路径 | 创建 | 修改 | 首次提交 | 最近提交 |
| --- | --- | --- | --- | --- |
| `packages/core/src/eval/baseline.test.ts` | 2026-09-16 18:45 | 2026-09-16 21:44 | 2026-09-16 18:47 | 2026-09-16 21:46 |
| `packages/core/src/eval/extraction-prompt.test.ts` | 2026-09-16 18:46 | 2026-09-16 21:44 | 2026-09-16 18:47 | 2026-09-16 21:46 |
| `packages/core/src/eval/prompt-samples.test.ts` | 2026-09-16 22:11 | 2026-09-16 22:16 | 2026-09-16 22:14 | 2026-09-16 22:19 |
| `packages/core/src/eval/real-model-responses.ts` | 2026-09-16 22:11 | 2026-09-16 22:18 | 2026-09-16 22:14 | 2026-09-16 22:19 |

## 四、`apps/web` · React + Vite 界面

### 入口与样式

| 相对路径 | 创建 | 修改 | 首次提交 | 最近提交 |
| --- | --- | --- | --- | --- |
| `apps/web/index.html` | 2026-09-16 00:17 | 2026-09-16 00:17 | 2026-09-16 00:21 | 2026-09-16 00:21 |
| `apps/web/package.json` | 2026-09-16 00:17 | 2026-09-16 18:09 | 2026-09-16 00:21 | 2026-09-16 18:12 |
| `apps/web/tsconfig.json` | 2026-09-16 00:17 | 2026-09-16 00:17 | 2026-09-16 00:21 | 2026-09-16 00:21 |
| `apps/web/vite.config.ts` | 2026-09-16 00:17 | 2026-09-16 00:17 | 2026-09-16 00:21 | 2026-09-16 00:21 |
| `apps/web/src/main.tsx` | 2026-09-16 00:17 | 2026-09-16 20:52 | 2026-09-16 00:21 | 2026-09-16 20:53 |
| `apps/web/src/App.tsx` | 2026-09-16 21:53 | 2026-09-16 22:59 | 2026-09-16 00:21 | 2026-09-16 23:02 |
| `apps/web/src/styles.css` | 2026-09-16 00:18 | 2026-09-16 22:58 | 2026-09-16 00:21 | 2026-09-16 23:02 |
| `apps/web/src/plan/PlanPage.tsx` | 2026-09-16 20:52 | 2026-09-16 20:52 | 2026-09-16 20:53 | 2026-09-16 20:53 |

### 组件

| 相对路径 | 创建 | 修改 | 首次提交 | 最近提交 |
| --- | --- | --- | --- | --- |
| `apps/web/src/components/TopBar.tsx` | 2026-09-16 20:34 | 2026-09-16 21:51 | 2026-09-16 20:36 | 2026-09-16 22:03 |
| `apps/web/src/components/LeftRail.tsx` | 2026-09-16 21:51 | 2026-09-16 21:56 | 2026-09-16 22:03 | 2026-09-16 22:03 |
| `apps/web/src/components/WorldTree.tsx` | 2026-09-16 21:51 | 2026-09-16 21:55 | 2026-09-16 22:03 | 2026-09-16 22:03 |
| `apps/web/src/components/MainHeader.tsx` | 2026-09-16 21:51 | 2026-09-16 21:55 | 2026-09-16 22:03 | 2026-09-16 22:03 |
| `apps/web/src/components/MainChat.tsx` | 2026-09-16 21:52 | 2026-09-16 22:58 | 2026-09-16 22:03 | 2026-09-16 23:02 |
| `apps/web/src/components/MessageBody.tsx` | 2026-09-16 21:51 | 2026-09-16 22:29 | 2026-09-16 22:03 | 2026-09-16 22:41 |
| `apps/web/src/components/SideChat.tsx` | 2026-09-16 21:52 | 2026-09-16 21:55 | 2026-09-16 22:03 | 2026-09-16 22:03 |
| `apps/web/src/components/CastRail.tsx` | 2026-09-16 21:52 | 2026-09-16 21:52 | 2026-09-16 22:03 | 2026-09-16 22:03 |
| `apps/web/src/components/CastDetail.tsx` | 2026-09-16 21:52 | 2026-09-16 21:56 | 2026-09-16 22:03 | 2026-09-16 22:03 |
| `apps/web/src/components/SceneDialog.tsx` | 2026-09-16 21:52 | 2026-09-16 21:56 | 2026-09-16 22:03 | 2026-09-16 22:03 |
| `apps/web/src/components/NewConversationDialog.tsx` | 2026-09-16 21:52 | 2026-09-16 21:56 | 2026-09-16 22:03 | 2026-09-16 22:03 |
| `apps/web/src/components/SettingsPanel.tsx` | 2026-09-16 21:53 | 2026-09-16 21:53 | 2026-09-16 22:03 | 2026-09-16 22:03 |
| `apps/web/src/components/RuntimePanel.tsx` | 2026-09-16 20:33 | 2026-09-16 22:58 | 2026-09-16 20:36 | 2026-09-16 23:02 |
| `apps/web/src/components/MemoryPanel.tsx` | 2026-09-16 18:40 | 2026-09-16 22:58 | 2026-09-16 18:42 | 2026-09-16 23:02 |
| `apps/web/src/components/ScenePanel.tsx` | 2026-09-16 00:18 | 2026-09-16 18:20 | 2026-09-16 00:21 | 2026-09-16 18:23 |
| `apps/web/src/components/CastPanel.tsx` | 2026-09-16 18:20 | 2026-09-16 20:26 | 2026-09-16 18:23 | 2026-09-16 20:27 |
| `apps/web/src/components/PromptInspector.tsx` | 2026-09-16 00:17 | 2026-09-16 00:17 | 2026-09-16 00:21 | 2026-09-16 00:21 |
| `apps/web/src/components/CardDesigner.tsx` | 2026-09-16 20:33 | 2026-09-16 20:35 | 2026-09-16 20:36 | 2026-09-16 20:36 |
| `apps/web/src/components/WorldDesigner.tsx` | 2026-09-16 20:33 | 2026-09-16 20:36 | 2026-09-16 20:36 | 2026-09-16 20:36 |
| `apps/web/src/components/PersonaLibrary.tsx` | 2026-09-16 20:33 | 2026-09-16 20:33 | 2026-09-16 20:36 | 2026-09-16 20:36 |
| `apps/web/src/components/ProviderPanel.tsx` | 2026-09-16 18:09 | 2026-09-16 20:22 | 2026-09-16 18:12 | 2026-09-16 20:23 |

### 库（会话、模型配置、后台队列…）

| 相对路径 | 创建 | 修改 | 首次提交 | 最近提交 |
| --- | --- | --- | --- | --- |
| `apps/web/src/lib/db.ts` | 2026-09-16 18:08 | 2026-09-16 18:10 | 2026-09-16 18:12 | 2026-09-16 18:12 |
| `apps/web/src/lib/session.ts` | 2026-09-16 21:50 | 2026-09-16 22:00 | 2026-09-16 18:12 | 2026-09-16 22:03 |
| `apps/web/src/lib/world.ts` | 2026-09-16 00:17 | 2026-09-16 21:55 | 2026-09-16 00:21 | 2026-09-16 22:03 |
| `apps/web/src/lib/admin.ts` | 2026-09-16 21:51 | 2026-09-16 21:51 | 2026-09-16 22:03 | 2026-09-16 22:03 |
| `apps/web/src/lib/providers.ts` | 2026-09-16 18:08 | 2026-09-16 18:40 | 2026-09-16 18:12 | 2026-09-16 18:42 |
| `apps/web/src/lib/worker.ts` | 2026-09-16 20:25 | 2026-09-16 22:57 | 2026-09-16 20:27 | 2026-09-16 23:02 |
| `apps/web/src/lib/keystore.ts` | 2026-09-16 18:08 | 2026-09-16 18:08 | 2026-09-16 18:12 | 2026-09-16 18:12 |
| `apps/web/src/lib/fileio.ts` | 2026-09-16 18:08 | 2026-09-16 18:08 | 2026-09-16 18:12 | 2026-09-16 18:12 |

## 五、工具与桌面入口

| 相对路径 | 创建 | 修改 | 首次提交 | 最近提交 |
| --- | --- | --- | --- | --- |
| `tools/desktop/launch.mjs` | 2026-09-16 18:26 | 2026-09-16 18:32 | 2026-09-16 18:28 | 2026-09-16 18:33 |

---

## 六、提交时间线

项目是从 2026-09-16 一天之内搭起来并迭代出来的，所以按时间读提交历史就等于读一份开发日志。

### 2026-09-16

| 时间 | 提交 | 说明 |
| --- | --- | --- |
| 00:11 | `c6bf71e` | 初始化仓库与设计文档 |
| 00:21 | `7586089` | M0 骨架（兼容层 + 数据模型 + Prompt 装配 + Web 端） |
| 11:11–11:18 | `ef6a3c4` `941c00a` `d47f5b8` | 路线图与平台范围（PWA 优先、桌面壳条件性） |
| 18:12 | `fd5c71c` | P0-1/2/8/9：持久化、会话恢复、多服务商配置、工程基线 |
| 18:23 | `fbc72a1` | P0-3/4/5/6/7：多角色同场、调度、视角化上下文、重抽 |
| 18:28–18:33 | `9d3ac3a` `b2ff0a5` `aea7788` | 桌面启动器（三次迭代修到双击可用） |
| 18:42 | `a8e580e` | P1-1~P1-4：视角化记忆与记忆面板 |
| 18:47 | `4f7621f` | P1-10：长跑评测基线与真模型验证文档 |
| 20:23 | `8033e9f` | 查漏补缺：级联删除、世界书入口、后台模型配置 |
| 20:27 | `9e6c963` | P1-7/P1-8/P1-9：情绪关系推演、抗漂移、统一后台队列 |
| 20:36 | `1398fad` | 侧边栏＝设定区，新增角色卡与世界书设计器 |
| 20:49 | `c7a4aa2` | 新增 STATUS.md（跨会话接续） |
| 20:53 | `61b8bb5` | 布局规划页（按草图还原可填写的骨架） |
| 21:26–21:38 | `7132947` `8531d01` `2d4f09a` | LAYOUT.md 三次补全到定稿 |
| 21:46 | `fcfb81b` | 世界拆成「世界 + 多条对话」，归档的状态回滚 |
| 21:48 | `5cf5ba1` | 副对话的真实工具调用 |
| 22:03 | `6291e38` | 界面改版 A：三栏骨架、双对话、动作分段、角色栏 |
| 22:04 | `2a8c78b` | 记录界面改版的落地情况与取舍 |
| 22:06 | `af9d245` | 流式气泡用真正的发言者 |
| 22:14 | `704a736` | 真模型验证取样器 + 回答可重跑断言 |
| 22:19 | `ae2ddfd` | 网页版验证：修掉当场抓到的三处问题 |
| 22:41 | `53dfab6` | 端到端验证：修掉五个问题 |
| 22:42 | `8440cb1` | 端到端验证记录（九项通过、五处修复、两处仍缺） |
| 23:02 | `333a34a` | P3-7 真实 token 用量统计 + 修掉场外角色上台 |
| 23:05 | `cf242d5` | 新增 TASKS.md、FILE-LOG.md；删除死代码 ChatPanel.tsx、lib/settings.ts |
| 23:17 | `f4e2974` | T1 动作分段（引号即对白）、T2a 追问延续、设置面板草稿式保存 |
| 23:18 | `dbdb012` | 记下动作分段的排查过程与结论（六种办法全部失败的对照表） |
| 23:35 | `bccd507` | T4 五十回合长跑：长线不塌，修掉转写标记自我强化与「一句提两人」的抢答 |

### 2026-09-17 ~ 09-19 的提交

| 时间 | 提交 | 说明 |
| --- | --- | --- |
| 09-17 00:05 | `5725dce` | T18 语音归属检测（判据收紧到 2 条真错位）+ 一键改归属 |
| 09-17 14:03 | `cc332b0` | T17/T10 换场「这次带谁走」，名单成为存在状态的权威 |
| 09-17 20:11 | `15b008c` | T2 意图先行：规则信号全部落地、推理流当盘算、动作轮不吃冷却 |
| 09-19 17:30 | `52e9ad2` | T2c 生成前意图调用 + 抽取与推演合并成一次后台调用 |
| 09-19 17:45 | `3f7e271` | T7 用量账单落盘（按用途/角色/模型统计 + 单价换算 + 「用量」页） |
| 09-19 20:29 | `d270f35` | T3 分层摘要（场景场记 + 章节回顾，原文不删；真机 3 轮验证） |
| 09-19 20:45 | `491f562` | T19 调用熔断 + T20 动作主语改用角色名字（用户提出） |
| 09-19 20:58 | `ddf4ab0` | T21 召回评测（合成题库 + 真实数据探针）：真实数据不支持上向量，问题在精度 |
| 09-19 21:10 | `f5141e5` | T23 滚动归属：修掉「窄窗口把整页拉长」的遗留 bug（用户提出） |
| 09-19 21:24 | `efe6604` | T22 记忆预算的兜底上限（实测推翻「噪音是重复」的猜测） |
| 09-19 21:37 | `9dc2f11` | T9 封存导出 / 导入（P2-4）：一个世界一个文件，导入永远新建一条线 |
| 09-19 22:07 | `e0fdc1e` | T8b PWA：可安装、离线外壳（含两个实测坑）、存储持久化面板 |
| 09-19 22:31 | `2742a30` | 换成用户给的应用图标（圣杯 + 彩虹火焰），去掉 AI 水印 |
| 09-19 22:23 | `d755677` | T6/P2-5 账号与同步的方案选型（新增 SYNC.md） |
| 09-19 22:47 | `1eed734` | **P2-6 第一步（1/3）**：四类实体补 `updatedAt`，写入路径统一盖章（迁移 v4） |
| 09-19 22:57 | `ac70781` | **P2-6 第一步（2/3）**：`deletedAt` 软删除——`delete*` 改墓碑、查询默认过滤（迁移 v5） |
| 09-19 23:03 | `f43d5cd` | **P2-6 第一步（3/3）**：本机 `deviceId` + 消息 `localSeq`（`seq` 改名，迁移 v6） |
| 09-19 23:30 | `ae8cbb6` | **P2-6 第二步**：`core/crypto` 加密工具（折 id / PBKDF2 / AES-GCM + AAD / 两种凭证 / 恢复码 / 主密钥封装）+ 真浏览器探针页 |
| 09-19 23:37 | `f9c55b8` | **P2-6 第二步补**：AAD 改用 `updatedAt`，并让每条记录的 `updatedAt` 严格递增（定 SYNC §4.4 的空隙） |
| 09-19 23:54 | `c485c44` | **P2-6 第三步**：`core/sync` 同步循环（传输层契约 / 合并规则 / 内存服务端 / 本地游标）+ 真机探针页 |
| 09-20 18:35 | `9f31022` | **P2-6 第四步（下）**：独立同步服务端 `tools/sync-server/`（SQLite / systemd / 备份 / 手册）+ CORS + 方案答卷 `docs/SYNC-DEPLOY.md` |
| 09-20 17:43 | `b1eca18` | **P2-6 第四步（上）**：服务端侧——`server.ts` + `http.ts`（一份逻辑三宿主）/ 开发后端（vite `/sync/*`）/ fetch 传输层；顺手修掉「同毫秒写入推不出去」 |

---

## 七、快照之后新增与改动的文件（2026-09-17 ~ 09-19）

第二～五节是 23:05 的快照。这一节补上之后的四批改动（T18 / T17 / T2 / T2c），
时间以 **git 提交时间**为准；标「未提交」的是 T2c 这一批正在交付的文件。

### 新增文件

| 相对路径 | 创建（本机） | 修改（本机） | 首次提交 | 用途 |
| --- | --- | --- | --- | --- |
| `packages/core/src/render/attribution.ts` | 2026-09-16 23:58 | 2026-09-17 00:04 | 2026-09-17 00:05 | T18 语音归属检测（纯规则，不调模型） |
| `packages/core/src/render/attribution.test.ts` | 2026-09-16 23:58 | 2026-09-17 00:00 | 2026-09-17 00:05 | 含一条「靠道具词才能看出的错位故意不检测」的限制用例 |
| `packages/core/src/session/presence.ts` | 2026-09-17 13:53 | 2026-09-17 13:59 | 2026-09-17 14:03 | T10 名单是权威，presence 跟着名单走 |
| `packages/core/src/session/presence.test.ts` | 2026-09-17 13:53 | 2026-09-17 13:53 | 2026-09-17 14:03 | 同上 |
| `packages/core/src/render/intent.ts` | 2026-09-17 19:55 | 2026-09-17 20:00 | 2026-09-17 20:11 | T2b 意图行解析、推理流取首句当盘算 |
| `packages/core/src/render/intent.test.ts` | 2026-09-17 19:55 | 2026-09-17 19:55 | 2026-09-17 20:11 | 同上 |
| `packages/core/src/director/intent-plan.ts` | 2026-09-19 17:13 | 2026-09-19 17:18 | 2026-09-19 17:30（`52e9ad2`） | **T2c 生成前意图**：导演提示词、宽松解析、三道闸挑人 |
| `packages/core/src/director/intent-plan.test.ts` | 2026-09-19 17:13 | 2026-09-19 17:13 | 2026-09-19 17:30（`52e9ad2`） | 9 条：四种 mode、名字对不上、不在场、hold_back |
| `packages/core/src/memory/turn-analysis.ts` | 2026-09-19 17:12 | 2026-09-19 17:18 | 2026-09-19 17:30（`52e9ad2`） | **T2c 预算来源**：抽取 + 推演合并成一次调用 |
| `packages/core/src/memory/turn-analysis.test.ts` | 2026-09-19 17:13 | 2026-09-19 17:18 | 2026-09-19 17:30（`52e9ad2`） | 5 条：合并形状、嵌套形状、只写一半 |
| `packages/core/src/storage/usage.ts` | 2026-09-19 17:34 | 2026-09-19 17:40 | 2026-09-19 17:45（`3f7e271`） | **T7 账单流水**：记一次调用 + 纯函数汇总（按用途/角色/模型）+ 删世界时清账 |
| `packages/core/src/storage/usage.test.ts` | 2026-09-19 17:35 | 2026-09-19 17:40 | 2026-09-19 17:45（`3f7e271`） | 9 条：脏数据清洗、无单价不编钱、部分覆盖、筛选、级联清账 |
| `apps/web/src/lib/usage.ts` | 2026-09-19 17:36 | 2026-09-19 17:40 | 2026-09-19 17:45（`3f7e271`） | 读账的 hook + 「额外调用」口径 + token/花费格式化 |
| `apps/web/src/components/UsagePanel.tsx` | 2026-09-19 17:36 | 2026-09-19 17:40 | 2026-09-19 17:45（`3f7e271`） | 「用量」页：两级总计 + 三张分组账 |
| `packages/core/src/memory/summary.ts` | 2026-09-19 20:04 | 2026-09-19 20:17 | 2026-09-19 20:29（`d270f35`） | **T3 分层摘要**：场记/章节的提示词、宽容解析、触发与游标 |
| `packages/core/src/memory/summary.test.ts` | 2026-09-19 20:07 | 2026-09-19 20:17 | 2026-09-19 20:29（`d270f35`） | 14 条：合并语义、散文兜底、阈值、游标幂等、章节候选 |
| `packages/core/src/storage/budget.ts` | 2026-09-19 20:34 | 2026-09-19 20:34 | 2026-09-19 20:45（`491f562`） | **T19 熔断判定**：上限口径（额外调用次数 / 花费）与状态，纯函数 |
| `packages/core/src/storage/budget.test.ts` | 2026-09-19 20:35 | 2026-09-19 20:40 | 2026-09-19 20:45（`491f562`） | 8 条：只算生成之外的调用、没单价不参与金额判定、0 当没设 |
| `packages/core/src/storage/archive.ts` | 2026-09-19 21:26 | 2026-09-19 21:33 | 2026-09-19 21:37（`9dc2f11`） | **T9 封存**：导出格式与解析、导入时全量 id 重映射（新建世界，绝不覆盖） |
| `packages/core/src/storage/archive.test.ts` | 2026-09-19 21:29 | 2026-09-19 21:32 | 2026-09-19 21:37（`9dc2f11`） | 8 条：往返、重复导入、不覆盖本机数据、错误文件、空世界、id 重映射 |
| `apps/web/src/lib/archive.ts` | 2026-09-19 21:30 | 2026-09-19 21:34 | 2026-09-19 21:37（`9dc2f11`） | 接线：读快照 → 导出文件；选文件 → 导入并打开新世界 |
| `apps/web/src/lib/viewport.ts` | 2026-09-19 21:45 | 2026-09-19 21:46 | 2026-09-19 21:50（`00248df`） | T8a：窄屏判断（matchMedia，只在跨断点时重渲染） |
| `apps/web/public/manifest.webmanifest` | 2026-09-19 21:52 | 2026-09-19 21:52 | 2026-09-19 22:07（`e0fdc1e`） | PWA 清单：名称、图标（含 maskable）、standalone |
| `apps/web/public/sw.js` | 2026-09-19 21:53 | 2026-09-19 22:00 | 2026-09-19 22:07（`e0fdc1e`） | 离线外壳：自发现清单、ignoreVary、模型请求放行、诊断钩子 |
| `apps/web/public/icon-*.png` `favicon.png` | 2026-09-19 21:51 | 2026-09-19 22:30 | 2026-09-19 22:07（`e0fdc1e`），22:31 换成用户给的图（`2742a30`） | 应用图标（192/512 + maskable + 64px 标签页图标），AI 水印已按 EVAL 记的方法补掉 |
| `apps/web/src/lib/storage.ts` | 2026-09-19 21:58 | 2026-09-19 21:58 | 2026-09-19 22:07（`e0fdc1e`） | T8b：持久化状态与配额（P2-3） |
| `packages/core/src/eval/recall-eval.ts` | 2026-09-19 20:49 | 2026-09-19 20:49 | 2026-09-19 20:58（`ddf4ab0`） | **T21 召回评测**：命题命中 / 排名 / 进预算 / 串味，纯函数可换实现对比 |
| `packages/core/src/eval/recall-scenario.ts` | 2026-09-19 20:50 | 2026-09-19 20:57 | 2026-09-19 20:58（`ddf4ab0`） | 合成题库：14 条记忆、9 道题（含 2 道负向题测视角隔离） |
| `packages/core/src/eval/recall-baseline.test.ts` | 2026-09-19 20:50 | 2026-09-19 20:50 | 2026-09-19 20:58（`ddf4ab0`） | 5 条回归红线 + 把评测表打出来 |
| `apps/web/tools/recall-probe.html` | 2026-09-19 20:51 | 2026-09-19 20:51 | 2026-09-19 20:58（`ddf4ab0`） | 开发用探针页（不进应用构建） |
| `apps/web/tools/recall-probe.ts` | 2026-09-19 20:51 | 2026-09-19 20:54 | 2026-09-19 20:58（`ddf4ab0`） | 读本机库里的真实记忆、用同一套内核实现跑探针 |
| `packages/core/src/model/lifecycle.ts` | 2026-09-19 22:52 | 2026-09-19 22:52 | 2026-09-19 22:57（`ac70781`） | **P2-6 软删除**：`isAlive` / `aliveOnly`——「字段不存在」与 null 一视同仁，老数据不用先迁移也能读 |
| `packages/core/src/crypto/errors.ts` | 2026-09-19 23:14 | 2026-09-19 23:14 | 2026-09-19 23:30（`ae8cbb6`） | 加解密失败的统一错误类型（上层要能分辨「密码错」与「环境不支持」） |
| `packages/core/src/crypto/encoding.ts` | 2026-09-19 23:14 | 2026-09-19 23:20 | 2026-09-19 23:30（`ae8cbb6`） | base64url、随机字节、定长比较、WebCrypto 句柄（零依赖） |
| `packages/core/src/crypto/keys.ts` | 2026-09-19 23:15 | 2026-09-19 23:29 | 2026-09-19 23:30（`ae8cbb6`） | 折 id 成空间句柄、PBKDF2 派生、凭证与哈希、**主密钥封装**、恢复码生成与归一 |
| `packages/core/src/crypto/records.ts` | 2026-09-19 23:16 | 2026-09-19 23:20 | 2026-09-19 23:30（`ae8cbb6`） | 记录级 AES-256-GCM 加解密 + AAD 绑坐标 + 密文大小口径 |
| 同上（`records.ts`） | 2026-09-19 23:36 | 2026-09-19 23:36 | 2026-09-19 23:37（`f9c55b8`） | AAD 的第四段从 `rev` 改成 `updatedAt`（SYNC §4.4 方案 A） |
| `packages/core/src/crypto/keys.test.ts` | 2026-09-19 23:17 | 2026-09-19 23:29 | 2026-09-19 23:30（`ae8cbb6`） | 25 条：句柄/凭证/用途隔离/封装错误路径/恢复码（含「密码与恢复码解出同一把主密钥」） |
| `packages/core/src/crypto/records.test.ts` | 2026-09-19 23:17 | 2026-09-19 23:20 | 2026-09-19 23:30（`ae8cbb6`） | 14 条：往返、密文不含明文、IV 随机、篡改与四种坐标错位都解不开 |
| `apps/web/tools/crypto-probe.html` `crypto-probe.ts` | 2026-09-19 23:22 | 2026-09-19 23:29 | 2026-09-19 23:30（`ae8cbb6`） | 开发用探针页：真浏览器跑 19 项检查并打出 PBKDF2 的真实耗时（EVAL 第八节） |
| `packages/core/src/sync/types.ts` | 2026-09-19 23:41 | 2026-09-19 23:41 | 2026-09-19 23:54（`c485c44`） | **P2-6 第三步**：三层协议类型（本地记录 / 线上记录 / `SyncTransport`）、十类集合白名单、本地同步状态 |
| `packages/core/src/sync/merge.ts` | 2026-09-19 23:42 | 2026-09-19 23:42 | 2026-09-19 23:54（`c485c44`） | 合并规则：先比 `updatedAt`、平局墓碑赢、其余保留本地（纯函数，好测好解释） |
| `packages/core/src/sync/loop.ts` | 2026-09-19 23:43 | 2026-09-19 23:53 | 2026-09-19 23:54（`c485c44`） | 推 → 拉 → 合并 → 推进游标；失败不推进游标；回声不再推回去 |
| `packages/core/src/sync/memory-transport.ts` | 2026-09-19 23:42 | 2026-09-19 23:52 | 2026-09-19 23:54（`c485c44`） | 内存服务端：校验凭证哈希、分配 `serverRev`、按游标发记录、只存密文（也是 Worker 的对照物） |
| `packages/core/src/sync/sync.test.ts` | 2026-09-19 23:45 | 2026-09-19 23:53 | 2026-09-19 23:54（`c485c44`） | 13 条：合并岔路、两台设备全流程、删除传墓碑、LWW、幂等、换空间、凭证错、服务端改密文 |
| `packages/core/src/sync/sqlite.ts` | 2026-09-20 18:20 | 2026-09-20 18:30 | 2026-09-20 18:35（`9f31022`） | **P2-6 部署**：SQLite 存储（建表、号单调递增、坐标唯一、游标拉取、事务）；不 import 驱动 |
| `packages/core/src/sync/sqlite.test.ts` | 2026-09-20 18:22 | 2026-09-20 18:30 | 2026-09-20 18:35（`9f31022`） | 7 条：建空间不覆盖、号递增与覆盖、since/limit、墓碑、空间隔离、两种凭证、空 push 不跳号 |
| `packages/core/src/types/node-sqlite.d.ts` | 2026-09-20 18:21 | 2026-09-20 18:21 | 2026-09-20 18:35（`9f31022`） | `node:sqlite` 的最小类型声明（不引 @types/node） |
| `tools/sync-server/src/main.ts` `src/node.d.ts` | 2026-09-20 18:24 | 2026-09-20 18:33 | 2026-09-20 18:35（`9f31022`） | 独立服务端：配置解析、HTTP/HTTPS、CORS、健康检查、日志（不记凭证与请求体）、优雅退出 |
| `tools/sync-server/start.mjs` `tsconfig.json` `backup.mjs` `.env.example` `systemd/…` `README.md` | 2026-09-20 18:25 | 2026-09-20 18:34 | 2026-09-20 18:35（`9f31022`） | 部署件：启动入口、编译配置、在线备份、配置模板、systemd 单元、从编译到排错的操作手册 |
| `docs/SYNC-DEPLOY.md` | 2026-09-20 18:30 | 2026-09-20 18:34 | 2026-09-20 18:35（`9f31022`） | **方案答卷**：信息分层、三种部署形态、实施步骤、待用户提供的信息、验收与回滚 |
| `packages/core/src/sync/server.ts` | 2026-09-20 17:33 | 2026-09-20 17:40 | 2026-09-20 17:43（`b1eca18`） | **P2-6 第四步**：空间登记 + 凭证校验 + 记录存取 + 游标，全靠 `SyncServerStore` 五个方法（内存 / JSON 文件 / D1 都能实现） |
| `packages/core/src/sync/http.ts` | 2026-09-20 17:34 | 2026-09-20 17:41 | 2026-09-20 17:43（`b1eca18`） | `handleSyncRequest`：五个路由（建空间 / 空间元数据 / head / push / pull），两个宿主共用 |
| `packages/core/src/sync/http.test.ts` | 2026-09-20 17:37 | 2026-09-20 17:41 | 2026-09-20 17:43（`b1eca18`） | 9 条：状态码 201/400/401/404/405/409、凭证校验、空间隔离、分页、走真实加密的推拉往返 |
| `packages/core/src/sync/credential.ts` | 2026-09-20 17:40 | 2026-09-20 17:40 | 2026-09-20 17:43（`b1eca18`） | 凭证 → 哈希的小工具（避免 keys 与 server 互相 import） |
| `apps/web/tools/sync-dev-backend.ts` | 2026-09-20 17:35 | 2026-09-20 17:42 | 2026-09-20 17:43（`b1eca18`） | 开发后端：挂在 vite 的 `/sync/*`，JSON 文件存储，**配置期不引 core**（走 `ssrLoadModule`） |
| `apps/web/src/lib/sync-transport.ts` | 2026-09-20 17:36 | 2026-09-20 17:39 | 2026-09-20 17:43（`b1eca18`） | 客户端 fetch 版 `SyncTransport` + 建空间 / 取空间元数据，错误消息原样抛给用户 |
| `apps/web/tools/sync-http-probe.html` `sync-http-probe.ts` | 2026-09-20 17:38 | 2026-09-20 17:41 | 2026-09-20 17:43（`b1eca18`） | 开发用探针页：**走真 HTTP** 的两台设备完整链路（EVAL 第十节） || `apps/web/tools/sync-probe.html` `sync-probe.ts` | 2026-09-19 23:51 | 2026-09-19 23:53 | 2026-09-19 23:54（`c485c44`） | 开发用探针页：真浏览器跑两台设备完整链路（13 项检查、1.1 秒） |

### 改动文件（最近一次提交时间）

| 相对路径 | 最近提交 | 这批改了什么 |
| --- | --- | --- |
| `packages/core/src/director/scheduler.ts` | 2026-09-17 20:11 | 句首称呼 +60 并免冷却、动作轮不吃冷却 |
| `packages/core/src/director/scheduler.test.ts` | 2026-09-16 23:35 | 长跑里两处抢答的回归断言 |
| `packages/core/src/render/segments.ts` | 2026-09-17 20:11 | 引号即对白 + 意图行不进正文 |
| `packages/core/src/session/turn.ts` | 2026-09-17 20:11 | 落库前清洗转写标记、意图来源写进消息 |
| `packages/core/src/model/message.ts` | 2026-09-19 17:30 | `intentSource` 增加 `planned` |
| `packages/core/src/model/conversation.ts` | 2026-09-19 17:30 | 会话模式增加 `intentFirst`（缺省开） |
| `packages/core/src/prompt/assemble.ts` | 2026-09-19 17:30 | 把这一轮的打算写进「本轮指令」 |
| `packages/core/src/index.ts` | 2026-09-19 17:45 | 导出新模块（意图计划 / 一轮分析 / 账单） |
| `apps/web/src/App.tsx` | 2026-09-19 17:45 | 生成前意图调用、合并入队、失败静默退回；生成与意图各记一笔账 |
| `apps/web/src/components/MainChat.tsx` | 2026-09-19 17:30 | 「他这一轮想：」chip、模式菜单加「意图先行」 |
| `apps/web/src/components/MemoryPanel.tsx` | 2026-09-19 17:45 | 「额外调用」改读流水（刷新不丢） |
| `apps/web/src/lib/worker.ts` | 2026-09-19 17:45 | `turn.analyze` 合并任务；记账交给账单，去掉会话级计数 |
| `apps/web/src/lib/session.ts` | 2026-09-17 14:03 | 切换/新建对话时同步名单 |
| `apps/web/src/components/SceneDialog.tsx` | 2026-09-17 14:03 | 换场的「这次带谁走」勾选 |
| `apps/web/src/styles.css` | 2026-09-17 20:11 | 意图 chip 与归属警告的样式 |
| `packages/core/src/admin/turn.ts` | 2026-09-19 17:45 | `done` 事件带上本回合用量与调用次数（副对话以前完全没进账） |
| `packages/core/src/model/provider.ts` | 2026-09-19 17:45 | 配置新增可选 `price`（每百万 token 的输入/输出价 + 币种） |
| `packages/core/src/storage/repository.ts` | 2026-09-19 17:45 | 新的 `usageRecords` 集合；删世界时级联清账 |
| `apps/web/src/lib/db.ts` | 2026-09-19 17:45 | 暴露 `ledger` |
| `apps/web/src/lib/providers.ts` | 2026-09-19 17:45 | 后台配置带上 `price`，供记账用 |
| `apps/web/src/lib/admin.ts` | 2026-09-19 17:45 | 副对话开 `includeUsage`、用量挂消息并记一笔账 |
| `apps/web/src/components/RuntimePanel.tsx` | 2026-09-19 17:45 | 新增「用量」标签页 |
| `apps/web/src/components/ProviderPanel.tsx` | 2026-09-19 17:45 | 「模型接入」新增单价输入，跟草稿式保存一起落库 |
| `packages/core/src/model/room.ts` | 2026-09-19 20:29 | 场景新增 `recap` / `recapUpToSeq` / `recapUpdatedAt`（与人写的 `summary` 分开） |
| `packages/core/src/prompt/types.ts` | 2026-09-19 20:29 | 新增块类型 `chapter`（前情提要自成一节） |
| `packages/core/src/prompt/budget.ts` | 2026-09-19 20:29 | 前情提要与召回记忆同级让位，但排在记忆之后 |
| `packages/core/src/prompt/assemble.ts` | 2026-09-19 20:29 | 场景块写入「本场已经发生」；新增「前情提要」块（只带最近三章） |
| `packages/core/src/storage/repository.ts` | 2026-09-19 20:29 | `chapterSummaries` 集合；归档/删世界/删对话级联清理 |
| `apps/web/src/components/ScenePanel.tsx` | 2026-09-19 20:29 | 只读「本场场记」与覆盖进度 |
| `apps/web/src/components/RuntimePanel.tsx` | 2026-09-19 20:29 | 把章节传给记忆页 |
| `apps/web/src/lib/session.ts` | 2026-09-19 20:29 | 快照带 `chapters`，只取当前对话的 |
| `apps/web/src/lib/usage.ts` | 2026-09-19 20:29 | 账单分类新增「前情摘要」 |
| `apps/web/src/lib/worker.ts` | 2026-09-19 20:29 | 两个摘要任务；`TaskOutcome` 区分「调用过」与「没调用」 |
| `apps/web/src/App.tsx` | 2026-09-19 20:29 | 每轮结算后让后台看一眼场记；装配带上章节 |
| `apps/web/src/styles.css` | 2026-09-19 21:10 | 场记与章节的样式 |
| `packages/core/src/render/segments.ts` | 2026-09-19 20:45 | **T20**：动作段的第一人称 → 说话人的名字（引号内不动、第二次主语省略） |
| `apps/web/src/components/MessageBody.tsx` | 2026-09-19 20:45 | 角色的动作按新规则渲染，玩家的保持第一人称 |
| `apps/web/src/components/UsagePanel.tsx` | 2026-09-19 20:45 | 本局上限的草稿式编辑 + 已用/还能再调 + 已熔断提示 |
| `packages/core/src/storage/repository.ts` | 2026-09-19 23:37 | **P2-6**：写入路径统一盖章（`updatedAt` / `deletedAt`，且 `updatedAt` 严格递增）、软删除与默认过滤、`deviceId()`、`appendMessages` 发 `localSeq`、迁移 v4/v5/v6 |
| `packages/core/src/model/message.ts` | 2026-09-19 23:03 | `Message` 增 `localSeq` / `deviceId` / `updatedAt` / `deletedAt`；`localSeqOf()` 兼容老 `seq` |
| `packages/core/src/model/room.ts` | 2026-09-19 22:57 | `Scene` 增 `updatedAt` / `deletedAt`；`Room` 增 `deletedAt` |
| `packages/core/src/model/card.ts` | 2026-09-19 22:57 | **偏差**：`Card` 与 `WorldBook` 原本连 `createdAt` 都没有，补 `createdAt` / `updatedAt` / `deletedAt` |
| `packages/core/src/model/conversation.ts` `instance.ts` `persona.ts` | 2026-09-19 22:57 | 三类实体补 `deletedAt`，构造器默认 null |
| `packages/core/src/storage/archive.ts` | 2026-09-19 23:03 | 导出按 `localSeqOf` 排序（老封存文件也能读），导入时序号与设备号由仓储层重发 |
| `apps/web/src/lib/worker.ts` `admin.ts` | 2026-09-19 23:03 | 新建实体补新字段；场记游标改用 `message.localSeq` |
| `packages/core/src/index.ts` | 2026-09-19 23:30 | 导出 `crypto/*`（折 id、派生、加解密、凭证） |
| `packages/core/src/index.ts` | 2026-09-20 17:43 | 再导出 `sync/server.ts`、`http.ts`、`credential.ts` |
| `packages/core/src/storage/repository.ts` | 2026-09-20 17:43 | 本机逻辑时钟（meta `clock.lastStamped`）：新写入的 `updatedAt` 一定大于同步推送水位线 |
| `packages/core/src/sync/memory-transport.ts` | 2026-09-20 17:43 | 改成「把 `createSyncServer` 装到内存存储上」，与开发后端 / Worker 共用同一份逻辑 |
| `apps/web/vite.config.ts` `apps/web/tsconfig.json` | 2026-09-20 17:43 | 挂上同步开发后端插件；`allowImportingTsExtensions`（配置里要带 `.ts` 后缀 import） |
| `packages/core/src/index.ts` | 2026-09-19 23:54 | 再导出 `sync/*`（传输层契约、合并规则、内存服务端、同步循环） |
| `packages/core/src/model/room.ts` | 2026-09-19 23:52 | `Scene` 新增 `recapUpToMessageId`（合并后 `localSeq` 会撞号，场记游标改按消息 id） |
| `packages/core/src/memory/summary.ts` | 2026-09-19 23:52 | `pendingSummary` 优先用消息 id 游标，老数据退回序号 |

---

## 八、2026-09-20 晚这一批（项目主体 + 桌面版 + 安卓壳）

七个提交，从 `66f7b74` 到 `80636fe`。新增的文件在这里逐条记，改过的文件只记「改了什么」。

### 新增

| 文件 | 时间 | 是什么 |
| --- | --- | --- |
| `packages/core/src/memory/panel-view.ts` | 2026-09-20 21:14 | 记忆面板的视图计算：对话 × 视角两个维度、按轮分组的对照视图（纯函数，T11） |
| `packages/core/src/memory/panel-view.test.ts` | 2026-09-20 21:14 | 上面那份的 10 条单测（含「一轮里两条客观条目不丢数据」这类边界） |
| `packages/core/src/storage/transcript.ts` | 2026-09-20 21:18 | 把一条对话导成可读 Markdown（抬头 + 按场景分段），T12 |
| `packages/core/src/storage/transcript.test.ts` | 2026-09-20 21:18 | 8 条单测（排序、换行压平、场景外消息、已删场景、空对话、文件名） |
| `packages/core/src/sync/auto-sync.ts` | 2026-09-20 21:26 | 自动同步的节流状态机：窗口内合并、尾随补一次、不重入、失败不重试 |
| `packages/core/src/sync/auto-sync.test.ts` | 2026-09-20 21:26 | 7 条单测（用假定时器跑全部岔路） |
| `apps/web/tools/world-seed-probe.html` / `.ts` | 2026-09-20 21:14 | 世界种子探针：往本机库种一个已知规模的世界（三条主线 + 副对话 + 已归档线） |
| `apps/web/tools/platform-probe.html` / `.ts` | 2026-09-20 21:37 | 平台能力探针：真浏览器里问一遍后台执行 / 密钥存储 / 本地模型 / 文件夹监控 |
| `tools/fake-model/server.mjs` | 2026-09-20 21:14 | 假模型服务（零依赖，OpenAI 兼容 + SSE）：一轮对话能在本机不花钱跑完 |
| `tools/desktop/install-shortcut.ps1` | 2026-09-20 21:37 | 生成带图标的桌面 / 开始菜单快捷方式（图标在本机从 PNG 现场包成 `.ico`） |
| `apps/android/package.json` | 2026-09-20 21:58 | `@dramatis/android`：`add:android` / `sync` / `open` / `apk` 四条命令 |
| `apps/android/capacitor.config.json` | 2026-09-20 21:58 | `webDir=../web/dist`、`androidScheme=https`（WebView 因此是安全上下文） |
| `apps/android/README.md` | 2026-09-20 21:58 | 安卓壳的入口说明，细节指向 docs/ANDROID.md |
| `docs/DESKTOP.md` | 2026-09-20 21:37 | P2-9 复核：四条触发条件的实测、结论、什么时候回来重新评估 |
| `docs/ANDROID.md` | 2026-09-20 21:58 | 安卓壳：命令、本机验到哪一步、真机上要盯的五件事、没验到的 |

### 修改

| 文件 | 时间 | 改了什么 |
| --- | --- | --- |
| `apps/web/src/components/MemoryPanel.tsx` | 2026-09-20 21:14 | 加对话 / 视角两个下拉、「逐条 / 对照」两个视图、归属标签、「跳到原句」 |
| `apps/web/src/components/RuntimePanel.tsx` | 2026-09-20 21:14 | 把对话列表与「跳到原句」的回调透给记忆面板 |
| `apps/web/src/components/MainChat.tsx` | 2026-09-20 21:14 | 消息节点带 `data-message-id`，接受 `focus` 请求并滚动 + 高亮 |
| `apps/web/src/lib/session.ts` | 2026-09-20 21:14 | 新增 `locateTurn`（记忆→原句）与 `bundleOf`（一条对话的素材包） |
| `apps/web/src/styles.css` | 2026-09-20 21:14 | 记忆筛选 / 对照视图 / 高亮动画的样式 |
| `apps/web/src/lib/archive.ts` | 2026-09-20 21:18 | 新增 `exportTranscript`（导出对话正文） |
| `apps/web/src/components/SettingsPanel.tsx` | 2026-09-20 21:18 | 归档列表每条加「导出正文」，并说明「没有取消归档」 |
| `apps/web/src/lib/sync.ts` | 2026-09-20 21:26 | 接上自动同步（节流实例 + `requestAutoSync`）与「重新拉一遍」 |
| `apps/web/src/components/SyncPanel.tsx` | 2026-09-20 21:26 | 状态里多一行「自动同步」；多一个「重新拉一遍」按钮 |
| `apps/web/src/App.tsx` | 2026-09-20 21:14 起 | 跳原句、归档提示条的入口按钮、每轮结束排自动同步、归档正文导出接线 |
| `packages/core/src/sync/types.ts` | 2026-09-20 21:26 | `SyncPullResult` 增加 `serverHead` / `hasMore`，并把 `head` 的语义写清楚 |
| `packages/core/src/sync/server.ts` | 2026-09-20 21:26 | `pull` 返回「这一批给到哪里」，不再返回全局头号 |
| `packages/core/src/sync/loop.ts` | 2026-09-20 21:26 | 分页拉到追平为止（逐页合并、上限 200 页），兼容老服务端 |
| `packages/core/src/sync/index.ts` | 2026-09-20 21:26 | 导出 `auto-sync` |
| `packages/core/src/index.ts` | 2026-09-20 21:14 / 21:18 | 导出 `memory/panel-view` 与 `storage/transcript` |
| `packages/core/src/sync/sync.test.ts` | 2026-09-20 21:26 | 两条回归：多页拉完、老服务端也能拉完 |
| `packages/core/src/sync/http.test.ts` | 2026-09-20 21:26 | 断言 `head` / `serverHead` / `hasMore` 的分页语义 |
| `tools/desktop/launch.mjs` | 2026-09-20 21:37 | `--prod` 判断构建产物是否最新（可跳过构建）、`--force-build` 强制重建 |
| `docs/ROADMAP.md` | 2026-09-20 21:37 / 21:58 | P2-9 记下「复核后不触发」、P2-10 记下「已开工」 |
| `pnpm-lock.yaml` | 2026-09-20 21:58 | 新增 `apps/android` 这个工作区包的依赖 |

---

## 九、2026-09-20 深夜：网页版桥接（没有 API Key 也能聊第一轮）

一个提交（`db97d7c`）。新增：

| 文件 | 是什么 |
| --- | --- |
| `packages/core/src/provider/manual.ts` | 「不联网的模型」：让 `runTurn` 走完提示词装配就停下，把提示词交给人 |
| `packages/core/src/prompt/web-bridge.ts` | 网页版桥接的共用件：把装配好的消息渲染成可整段粘贴的文本（格式与 eval 取样器一致）、清洗粘回来的文本、目标域名与「有没有 Key」的判断 |
| `packages/core/src/prompt/web-bridge.test.ts` | 9 条单测（渲染格式、围栏清洗、不改台词、中文里的反引号不误判） |
| `packages/core/src/memory/apply-analysis.ts` | 把「一轮分析」的输出落库（记忆 + 情绪），后台任务与网页版桥接**共用同一个实现** |
| `packages/core/src/memory/apply-analysis.test.ts` | 6 条单测（1 客观 + N 视角、脏文本也能收、重复贴幂等、名字对不上、归属对话、参与者从库里现取） |
| `apps/web/src/components/WebBridgePanel.tsx` | 桥接面板：复制提示词 / 打开网页版 / 贴回回复；两阶段（回复 → 记忆） |

修改：

| 文件 | 改了什么 |
| --- | --- |
| `apps/web/src/App.tsx` | 没有 Key 时不再报错，改走桥接；捕获装配出来的提示词；两个提交处理器（回复 / 记忆）；重抽在桥接下禁用、改归属改成再贴一次 |
| `apps/web/src/components/MainChat.tsx` | 桥接面板的挂载与文案；发送按钮在无 Key 时叫「生成提示词」；桥接开着时不让再发一句；重抽的禁用理由 |
| `apps/web/src/components/SettingsPanel.tsx` | 模型接入多一段说明：「填 Key 全自动，不填也能用」 |
| `apps/web/src/lib/worker.ts` | 一轮分析的落库改为调用内核的 `applyTurnAnalysis`（消掉重复实现） |
| `apps/web/src/styles.css` | 桥接面板与提示的样式 |
| `packages/core/src/index.ts` | 导出 manual provider、web-bridge、apply-analysis |
| `README.md` / `docs/*` | 状态、清单（6.5）、界面取舍（21）、协议无关的验证记录（EVAL 十五）、文件日志 |

---

## 十、2026-09-20 深夜：手机端 P0 修复（第一批）

一个提交（`cdf95e9`）。没有新增文件，改的都是既有文件：

| 文件 | 改了什么 |
| --- | --- |
| `apps/web/src/styles.css` | 窄屏下运行时面板改覆盖层 + 遮罩 + 收起按钮；底部/左右安全区；桥接面板窄屏竖排；恢复码样式 |
| `apps/web/src/App.tsx` | 面板遮罩与收起出口的渲染；导入素材后自动收左抽屉；把「世界/场景没加载完就点发送」的静默失败改成一句话 |
| `apps/web/src/components/SyncPanel.tsx` | 「用本站地址（https://本站/sync）」一键填；地址/密码输入不自动大写纠正；恢复码等宽大字 + 一键复制（失败时如实说） |
| `apps/web/index.html` | viewport 加 `viewport-fit=cover`（安全区 env() 才有值） |
| `docs/TASKS.md` | 第〇节改成 **P0–P4 + 真实处理顺序**（20 条一行一个动作），第一批标为已交付 |
| `docs/EVAL.md` | 新增第十六节（侧边浏览器真机复测）与第十七节（P0 修复的本机 + 线上复验） |
| `docs/LAYOUT.md` | 取舍 22：窄屏运行时面板是覆盖层 |
| `docs/STATUS.md` | 接续点更新为「顺序 5 真机键盘与安全区 / 顺序 6 副对话桥接」 |

---

## 十一、2026-09-21 凌晨：副对话桥接（顺序 6）与 Key 可见面（顺序 8）

两个提交（`079bcc0`、`e923bc5`）。

| 文件 | 新增/改动 | 是什么 |
| --- | --- | --- |
| `packages/core/src/admin/bridge.ts` | 新增 | 管理员桥接：把工具声明渲染成文本、生成「这次请写成 JSON 块」的说明、把贴回来的文本解析成 `ChatToolCall`（容忍无围栏、参数是字符串、前后有散文） |
| `packages/core/src/admin/bridge.test.ts` | 新增 | 10 条单测：工具渲染（含嵌套必填）、格式变体、坏 JSON、无关 JSON 不误判、解析结果直接喂给同一套校验 |
| `apps/web/src/lib/admin.ts` | 改 | `useAdminChat` 增加桥接：无 Key 时不再报错，改为给出提示词；`commitBridge` 解析 → 同一套校验 → 执行 → 落成管理员消息；`executeDraft` 抽出来给两条路共用；顺带修「场景没落下也标已生效」 |
| `apps/web/src/components/WebBridgePanel.tsx` | 改 | 新增 `admin` 阶段（文案、按钮） |
| `apps/web/src/components/SideChat.tsx` | 改 | 副对话挂上桥接面板；无 Key 时发送按钮叫「生成提示词」 |
| `apps/web/src/components/ProviderPanel.tsx` | 改 | 「这个 Key 会被谁看见？」折叠说明（四个面 + 信任边界） |
| `apps/web/src/components/MainChat.tsx` / `App.tsx` | 改 | 与上面几处对齐的 props（桥接面板的第三种阶段、副对话的桥接口） |
| `apps/web/src/styles.css` | 改 | `.key-facts` 的样式 |
| `docs/TASKS.md` / `docs/EVAL.md` / `docs/STATUS.md` / `docs/LAYOUT.md` | 改 | 顺序 6/8 标为已交付、第十八节验证记录、接续点、界面取舍 23 |

---

## 十二、2026-09-21 夜：消息操作与输入区（顺序 39–41）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/components/Icons.tsx` | **新增** | 输入区那四个内联 SVG 图标（加号 / 地图钉 / 向上箭头 / 方块）；不引图标库，吃 `currentColor` |
| `apps/web/src/components/MainChat.tsx` | 改 | 消息操作改悬停 / 右键 / 长按（`menuFor` / `pressTimer` / `swallowNextClick`，菜单走 `createPortal`）；输入区改成 `.composer-box` + `.composer-chip` + `.composer-action`，输入框自动长高 |
| `apps/web/src/components/MessageBody.tsx` | 改 | 挂在最后一段上的操作从 `.bubble-actions` 换成 `.row-actions`（平时不可见，可见性交给样式） |
| `apps/web/src/components/SideChat.tsx` | 改 | 副对话的输入区换成与主对话同一套（盒子 + 圆形发送键） |
| `apps/web/src/styles.css` | 改 | `.row-actions` / `.row-menu`（fixed + portal 定位）、`.composer-box` / `.composer-chip` / `.composer-action` 与窄屏规则；删掉随之失效的 `.usage-hint` |
| `apps/web/tools/world-seed-probe.ts` | 改 | 角色回复补上 `usage`——线上每条都有，回归数据也得有（菜单里的 Token 那行靠它） |
| `docs/TASKS.md` / `docs/EVAL.md` / `docs/LAYOUT.md` / `docs/STATUS.md` | 改 | 总表加 39/40/41，验证记录第二十四、二十五节，界面取舍 28–31，接续点 |

## 十三、2026-09-21 夜续：次级按钮 / 消息操作 / 便捷指令（顺序 42–44）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/styles.css` | 改 | `button.ghost` 去边框改「悬停浅底」（触屏常驻浅底）、`.ghost.danger` 与 `.ghost.active` 跟着改；`.row-actions` 高度收紧、去掉 `.action-only`；`.mode-menu .quick-command` 的样式 |
| `apps/web/src/components/MessageBody.tsx` | 改 | 操作按钮从「最后一段气泡里面」搬到「气泡的兄弟节点」 |
| `apps/web/src/components/MainChat.tsx` | 改 | 「＋」菜单加便捷指令（`QUICK_COMMANDS` + `insertAtCursor`） |
| `docs/EVAL.md` / `docs/TASKS.md` / `docs/LAYOUT.md` / `docs/STATUS.md` | 改 | 第二十六节（含 100 轮 token 账）、总表 42–44、界面取舍 32–34、接续点 |

## 十四、2026-09-21 深夜：顺序表一次五项（10 / 9 / 12 / 13 / 16）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `packages/core/src/platform/key-vault.ts` | **新增** | 口令加密的密钥库：PBKDF2 600k + AES-GCM、加密常量验口令、AAD 绑 ref、绝不覆盖已有库 |
| `packages/core/src/platform/key-vault.test.ts` | **新增** | 7 个单测（盘上无明文、口令错、文件坏、AAD 换位） |
| `packages/core/src/sync/limits.test.ts` | **新增** | 5 个单测：413 / 429 / 老存储跳过 / HTTP 状态码 |
| `packages/core/src/sync/loop.ts` | 改 | 坏记录隔离（跳过 + 上报 + 游标照常推进）、停止条件改成「服务端没给东西」、推送按 200 条分块 |
| `packages/core/src/sync/types.ts` | 改 | `SyncQuarantinedRecord` + `SyncReport.quarantined / quarantinedCount` |
| `packages/core/src/sync/server.ts` | 改 | `SyncServerLimits` + 默认值、每空间配额与写入限流、内存存储的 `spaceUsage` |
| `packages/core/src/sync/sqlite.ts` | 改 | `spaceUsage`（COUNT + LENGTH(sealed)） |
| `apps/web/src/lib/keystore.ts` | 改 | 第三档 `encrypted`、浏览器里的口令库存储、解锁与「有没有库」 |
| `apps/web/src/lib/providers.ts` | 改 | 口令库接线（新建/解锁、切档时删掉明文那份）、`vaultExists / vaultLocked / unlockVault` |
| `apps/web/src/components/ProviderPanel.tsx` | 改 | 「密钥保存方式」第三档 + 口令输入 + 解锁按钮 + 还没解锁的如实提示 |
| `apps/web/src/styles.css` | 改 | 手机上的触控目标（按元素给 44px 下限）与正文可读性（15px / 1.7） |
| `tools/sync-server/src/main.ts` | 改 | 护栏可调（`--max-records` / `--max-mb` / `--pushes-per-minute` 与对应环境变量，非法值忽略） |
| `docs/SYNC.md` | 改 | 新增 §4.8（坏记录隔离与分块）与 §4.9（配额与限流）——协议用法变了就要写进协议文档 |
| `docs/EVAL.md` / `docs/TASKS.md` / `docs/LAYOUT.md` / `docs/STATUS.md` | 改 | 第二十七节、总表五项标记、界面取舍 35–36、接续点 |

## 十五、2026-09-21 深夜续：38 / 7 / 14 / 15 / 19

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `tools/local-bridge/server.mjs` | **新增** | 本地助手：零依赖 Node，`/health` + `/ask`，用 CDP 驱动用户自己登录的模型网页标签页（`--pattern` 可换站点） |
| `apps/web/src/lib/local-bridge.ts` | **新增** | 网页侧的探活与请求（`probeLocalBridge` / `askLocalBridge`），失败即「没有助手」 |
| `apps/web/src/components/WebBridgePanel.tsx` | 改 | 助手在跑时多一个「一键用本地助手」；走与手动粘贴同一条收下路径；风险提示写在按钮旁 |
| `apps/web/src/components/ProviderPanel.tsx` | 改 | 顺序 7 的三步引导（只在没填 Key 时出现）+「粘贴并保存」 |
| `packages/core/src/crypto/keys.ts` | 改 | `rotatePassword()`：只换锁不换主密钥（新凭证 + 新封装，恢复码那份不动） |
| `packages/core/src/sync/types.ts` | 改 | `SyncWireRecord.deviceId?`、`SyncDeviceSummary`、`SyncReport.overridden`、传输层可选的 `devices` / `rotate` |
| `packages/core/src/sync/loop.ts` | 改 | 推的时候带上本机 deviceId；拉的时候统计「被别的设备挡回去」的条数 |
| `packages/core/src/sync/merge.ts` | 改 | 返回 `overriddenIds`（被本机挡回去的那些坐标），供上报使用 |
| `packages/core/src/sync/server.ts` | 改 | `devices()` / `rotatePassword()` 两个服务端动作 + 内存存储实现 |
| `packages/core/src/sync/sqlite.ts` | 改 | `device_id` 列 + 幂等 `ALTER TABLE` 迁移、`deviceUsage`、`rotatePassword` |
| `packages/core/src/sync/http.ts` / `http-client.ts` | 改 | `GET /devices` 与 `POST /rotate` 两条路由与客户端对应实现 |
| `apps/web/src/lib/sync.ts` | 改 | `listDevices()` 与 `rotatePassword()`（先服务端后本机，顺序刻意） |
| `apps/web/src/components/SyncPanel.tsx` | 改 | 设备列表、换密码、覆盖可见性一行 |
| `apps/web/tools/sync-dev-backend.ts` | 改 | 开发后端补上 `deviceUsage` / `rotatePassword`（不然本机联调会像老服务端） |
| `docs/SYNC.md` | 改 | 新增 §4.10（设备号为什么可选/明文、两个新接口、换密码=断开的语义） |
| `docs/EVAL.md` / `docs/TASKS.md` / `docs/LAYOUT.md` / `docs/STATUS.md` | 改 | 第二十八节、总表五项标记、界面取舍 37–39、接续点 |

## 十六、2026-09-21 深夜再续：顺序 17 / 18 / 26

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/lib/snapshot.ts` | **新增** | 服务端快照的形状、解析、文件名；`SNAPSHOT_REMIND_MS`（一天） |
| `apps/web/src/lib/sync.ts` | 改 | `exportSnapshot()`（分页拉全、**不复用 runSync** 以免动本地状态）、`restoreSnapshot()`、`spaceFull` 状态、`lastSnapshotAt` |
| `apps/web/src/components/SyncPanel.tsx` | 改 | 「服务端快照」一块（存 / 灌 + 上次时间提醒）、撞满时的常驻警告 |
| `packages/core/src/sync/server.ts` | 改 | 配额判据改成「这一批写完之后会不会超」；撞满时的指引改成准确的两条路 |
| `packages/core/src/storage/repository.ts` | 改 | `revokeAdminArtifact()`：撤回一次采纳（删素材库那份、草稿退回待采纳、幂等） |
| `packages/core/src/storage/artifact-revoke.test.ts` | **新增** | 3 个单测（撤回 / 幂等 / 撤回来还能再采纳） |
| `apps/web/src/lib/session.ts` | 改 | `revokeArtifact()` |
| `apps/web/src/components/SideChat.tsx` | 改 | 草稿预览（开场白 / 设定 / 词条数）、「撤回这次采纳」、整本替换提示 |
| `apps/web/src/App.tsx` | 改 | 把 `onRevoke` 与 `existingIds` 传给副对话 |
| `deploy/nginx-80-redirect.conf.example` | **新增** | 备案后 80 → 8443 的跳转模板（现在装上也没意义，公网到不了） |
| `docs/EVAL.md` / `docs/TASKS.md` / `docs/LAYOUT.md` / `docs/STATUS.md` | 改 | 第二十九节、总表 17/18/26、界面取舍 40–41、接续点 |

## 十七、2026-09-21 深夜：记忆与长对话的方案（无代码改动）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `docs/MEMORY.md` | **新增** | 记忆与长对话的实测（300 轮曲线）、四个问题的答案、27a–27e 的拆法、可复现的测量方法 |
| `docs/TASKS.md` / `docs/STATUS.md` | 改 | 顺序 27 从 P3 提到 P1、拆成 27a–27e；新增顺序 45（管理员未知参数提示）；接续点 |

这一批**没有改代码**：用户把「记忆与长对话」定为当前最重要的问题，而它属于
「先量再决定」那一项，所以先跑测量、再定方案，避免在没有数字的情况下写合并算法。

## 十八、2026-09-21 深夜：默认窗口按 800 条输入 + 记忆合并第一步

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `packages/core/src/model/provider.ts` | 改 | 默认 `maxTokens` 65536、`reserveForReply` 4096（按 800 条用户输入算出来的，注释里带算式） |
| `packages/core/src/prompt/assemble.ts` | 改 | 历史上限 `?? 40` → `?? 3000`：让**窗口**当约束，超了从最旧的历史开始丢 |
| `packages/core/src/storage/repository.ts` | 改 | 迁移 v7（老默认值的窗口升级）、v8（记忆补 `supersededBy`/`supersedes`/`consolidatedAt`）；`SCHEMA_VERSION = 8` |
| `packages/core/src/model/message.ts` | 改 | `MemoryEvent` 加合并相关的三个字段 |
| `packages/core/src/memory/consolidate.ts` | **新增** | 决定「合并哪些」的纯函数 + 提示词构造（按视角分组、从最旧的切、时间隔远分批） |
| `packages/core/src/memory/consolidate.test.ts` | **新增** | 7 个单测 |
| `packages/core/src/storage/provider-defaults.test.ts` | **新增** | 新默认值 + 迁移只升级老默认值的单测 |
| `docs/MEMORY.md` | 改 | 新增第八节：默认值改动、代价（800 轮约 100 元）、27a 第一步 |
| `docs/EVAL.md` / `docs/TASKS.md` / `docs/STATUS.md` | 改 | 第三十节、总表 27 的进度、接续点 |

## 十九、2026-09-21 深夜：27a 完成（记忆合并接进后台队列）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `packages/core/src/memory/consolidate.ts` | 改 | `applyConsolidation()`（印象 + 原文盖章，纯函数）、阈值 ≤0.5 / 20 条、`planConsolidation` 与提示词 |
| `packages/core/src/memory/consolidate.test.ts` | 改 | 增加到 12 个单测（含印象落成、没什么可记、围栏清理、原文不在库里） |
| `packages/core/src/storage/repository.ts` | 改 | `markMemoriesRecalled(ids, at)`：先读最新再只改两个字段（修「整条旧拷贝覆盖别人的改动」） |
| `packages/core/src/storage/recall-stamp.test.ts` | **新增** | 那条 bug 的回归线（盖章之后记账，章还在） |
| `apps/web/src/lib/worker.ts` | 改 | 新任务 `memory.consolidate`：拿到最新记忆 → 计划 → 一次模型调用 → 印象与原文一起落库 |
| `apps/web/src/lib/session.ts` | 改 | `markRecalled` 改用 `markMemoriesRecalled`（不再写整条） |
| `apps/web/src/App.tsx` | 改 | 每轮结算后排一次合并（幂等键带「每 20 条」的桶号） |
| `tools/fake-model/server.mjs` | 改 | 重要度给**分布**（0.3/0.45/0.7，原来恒定 0.45 测不到门槛两侧）；认得出合并提示词 |
| `docs/MEMORY.md` / `docs/EVAL.md` / `docs/TASKS.md` / `docs/STATUS.md` | 改 | 27a 的落地与阈值调整、第三十一节、总表与接续点 |

## 二十、2026-09-21 深夜：27b 第一步（记忆附件的形状与生成）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `packages/core/src/memory/attachment.ts` | **新增** | 三层附件（关系现状 / 时间线索引 / 记忆索引）、预算裁剪与 `stats.dropped`、关键词启发式、挂卡与取回 |
| `packages/core/src/memory/attachment.test.ts` | **新增** | 7 个单测 |
| `packages/core/src/index.ts` | 改 | 导出 attachment |
| `docs/MEMORY.md` / `docs/TASKS.md` / `docs/STATUS.md` | 改 | 27b 第一步的落地、总表进度、接续点 |

## 二十一、2026-09-21 深夜：27b 第二步（开新对话自动带附件）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `packages/core/src/memory/attachment.ts` | 改 | `buildCardMemoryAttachment()`：按卡/实例挑原对话印象与章节，无印象时回退高重要度条目 |
| `packages/core/src/memory/attachment.test.ts` | 改 | 增加到 10 个单测（视角隔离、章节隔离、回退、无材料不造空附件） |
| `apps/web/src/lib/session.ts` | 改 | `startConversation` 生成并写回附件，返回逐卡「带了/丢了什么」的报告 |
| `apps/web/src/App.tsx` | 改 | 开新对话后显示真实附件摘要 |
| `docs/EVAL.md` / `docs/MEMORY.md` / `docs/TASKS.md` / `docs/STATUS.md` | 改 | 第三十三节、27b 已落、总表续接点 |
## 二十二、2026-09-21 深夜：27c（索引常驻，命中后展开）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `packages/core/src/memory/attachment.ts` | 改 | `expandAttachment()` / `asksAboutPast()` / `renderAttachmentExpansion()`：关键词或过去意图才取正文，最多 3 条 |
| `packages/core/src/memory/attachment.test.ts` | 改 | 增加到 13 个单测（日常不展开、关键词、过去意图、上限） |
| `packages/core/src/prompt/assemble.ts` | 改 | 有附件时常驻索引块；触发时追加展开块，原文缺失不注入空块 |
| `packages/core/src/prompt/assemble.test.ts` | 改 | 3 个端到端装配单测 |
| `packages/core/src/prompt/types.ts` / `budget.ts` | 改 | 新增 `attachment` 块类型，预算降级时与记忆/章节同组处理 |
| `apps/web/src/lib/session.ts` | 改 | 暴露世界内 `allChapters` 供跨对话展开 |
| `apps/web/src/App.tsx` | 改 | 传附件原文池；常规召回限定当前对话，避免旧正文漏回 |
| `docs/EVAL.md` / `docs/MEMORY.md` / `docs/TASKS.md` / `docs/STATUS.md` | 改 | 第三十四节、27c 实测与接续点 |
## 二十三、2026-09-21 深夜：27d（影响可审计、可按条目撤销）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `packages/core/src/model/instance.ts` | 改 | `AffectChange` / `RelationshipChange` 加 id、before/after、sourceMemoryIds、reversionOf |
| `packages/core/src/memory/affect.ts` | 改 | 应用时记录完整变化；`revertAffectChange()` 只追加反向记录；回合回滚复用同路径 |
| `packages/core/src/memory/apply-analysis.ts` | 改 | 状态变化关联本轮写入的角色视角记忆 id |
| `packages/core/src/storage/repository.ts` | 改 | 迁移 v9：旧历史反向回放补 before/after、确定性 id 与来源字段 |
| `packages/core/src/memory/affect.test.ts` / `apply-analysis.test.ts` / `storage/conversation.test.ts` / `storage/repository.test.ts` | 改 | append-only、来源 id、逐条撤销与迁移回归 |
| `apps/web/src/lib/session.ts` | 改 | `revertAffectChange()` 落库 |
| `apps/web/src/components/CastDetail.tsx` / `styles.css` | 改 | 状态历史显示 before/after 与来源，提供「撤销这条影响」 |
| `apps/web/src/App.tsx` | 改 | 把撤销动作接到角色详情 |
| `docs/EVAL.md` / `docs/MEMORY.md` / `docs/TASKS.md` / `docs/STATUS.md` | 改 | 第三十五节、27d 实测与接续点 |

## 二十五、2026-09-21 深夜：27e（来源链与附件预览）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `packages/core/src/memory/panel-view.ts` | 改 | `isImpressionMemory()` / `resolveMemorySources()`：解析印象来源并登记缺失 id |
| `packages/core/src/memory/panel-view.test.ts` | 改 | 来源顺序、缺失 id、普通条目无链 |
| `apps/web/src/components/MemoryPanel.tsx` | 改 | 附件预览、来源原文展开、逐条跳回原句 |
| `apps/web/src/components/RuntimePanel.tsx` / `apps/web/src/App.tsx` | 改 | 把当前世界卡片传给记忆面板 |
| `apps/web/src/styles.css` | 改 | 附件预览与来源链样式 |
| `docs/EVAL.md` / `docs/MEMORY.md` / `docs/TASKS.md` / `docs/STATUS.md` | 改 | 第三十六节、27e 完成与全链路 6/6 |

## 二十六、2026-09-21 深夜：账户重构 A1（名称、ID 与数据容器分层）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/lib/db.ts` | 改 | 账户注册表 v2、旧账户迁移、稳定 storageId、改名/新建/切换 |
| `apps/web/src/components/AccountPanel.tsx` | 改 | 账户列表、创建、改名、切换；技术数据库名退出界面 |
| `apps/web/src/styles.css` | 改 | 账户列表与创建区样式 |
| `docs/EVAL.md` / `docs/TASKS.md` / `docs/STATUS.md` | 改 | 第三十七节、任务 46 与接续状态 |

## 二十七、2026-09-21 深夜：账户重构 A3（Persona 移到左栏）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/components/LeftRail.tsx` | 改 | 新增 `personas` Pane 与“我的身份”顶级按钮 |
| `apps/web/src/components/PersonaLibrary.tsx` | 改 | 独立编辑状态、无世界 CRUD、连续输入竞态修复 |
| `apps/web/src/lib/session.ts` | 改 | Persona 列独立于 RoomSnapshot 维护 |
| `apps/web/src/components/SettingsDialog.tsx` / `apps/web/src/App.tsx` | 改 | 从账户设置移除 Persona，接到左栏 Pane |
| `docs/EVAL.md` / `docs/TASKS.md` / `docs/STATUS.md` | 改 | 第三十八节、任务 47 与接续状态 |

## 二十八、2026-09-21 深夜：账户重构 A4（对话级玩家身份）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `packages/core/src/model/conversation.ts` | 改 | Conversation 增加 personaId / playerName / playerPersona 与创建参数 |
| `packages/core/src/session/setup.ts` | 改 | 新世界、新对话继承默认 Persona |
| `packages/core/src/prompt/assemble.ts` | 改 | 对话级玩家身份覆盖 Room 默认值 |
| `packages/core/src/storage/repository.ts` | 改 | 迁移 v10；旧对话从 Room 复制身份 |
| `packages/core/src/storage/archive.ts` | 改 | 导入封存时重建 Persona 引用与快照 |
| `apps/web/src/lib/session.ts` | 改 | 切换当前对话身份、编辑/删除时同步引用与快照 |
| `apps/web/src/components/RuntimePanel.tsx` / `App.tsx` | 改 | 面板“我的身份”选择器 |
| `packages/core/src/storage/conversation.test.ts` / `repository.test.ts` / `prompt/assemble.test.ts` | 改 | 身份快照、继承、覆盖、v10 迁移回归 |
| `docs/EVAL.md` / `docs/TASKS.md` / `docs/STATUS.md` | 改 | 第三十九节、任务 48 与接续状态 |

## 二十九、2026-09-21 深夜：账户重构 A5（副对话 Persona 工具）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `packages/core/src/admin/tools.ts` | 改 | `upsert_persona` / `delete_persona` 声明、校验与草稿 |
| `packages/core/src/admin/prompt.ts` | 改 | 提示词列出当前账户 Persona |
| `packages/core/src/model/message.ts` | 改 | AdminArtifact 增加 Persona 草稿类型与旧版本 |
| `packages/core/src/storage/repository.ts` | 改 | Persona 草稿采纳与撤回恢复 |
| `apps/web/src/lib/admin.ts` / `apps/web/src/components/SideChat.tsx` | 改 | 管理员上下文、草稿预览与确认删除 |
| `packages/core/src/admin/tools.test.ts` / `storage/artifact-revoke.test.ts` | 改 | Persona 工具与草稿采纳回归 |
| `docs/EVAL.md` / `docs/TASKS.md` / `docs/STATUS.md` | 改 | 第四十节、任务 49 与接续状态 |

## 三十、2026-09-21 深夜：账户重构 A6/A7（模型配置与 Key 同步）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `packages/core/src/model/provider.ts` | 改 | `ProviderCredential`：账户内加密凭据 |
| `packages/core/src/sync/types.ts` | 改 | 同步白名单加入 `providerProfiles` / `providerCredentials` |
| `packages/core/src/storage/repository.ts` | 改 | 模型配置与凭据的软删除、列表、保存 |
| `packages/core/src/sync/sync.test.ts` | 改 | 两设备同步后解回 Key、密文无明文的回归 |
| `apps/web/src/lib/sync.ts` | 改 | `sealSecret` / `openSecret`（账户主密钥加解密） |
| `apps/web/src/lib/providers.ts` | 改 | 本机 KeyStore 与账户凭据双向对齐；清理空白默认模型 |
| `apps/web/src/App.tsx` | 改 | Sync 先于 Providers 初始化 |
| `docs/EVAL.md` / `docs/TASKS.md` / `docs/STATUS.md` | 改 | 第四十一节、任务 50 与接续状态 |

## 三十一、2026-09-21 深夜：账户重构 A8（Persona 彻底删除）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `packages/core/src/storage/repository.ts` | 改 | Persona 正文清空、删除墓碑、房间/对话解引用 |
| `apps/web/src/lib/session.ts` | 改 | 删除后重新加载世界快照 |
| `packages/core/src/storage/persona-delete.test.ts` | **新增** | 墓碑无正文、旧对话保留身份快照 |
| `docs/EVAL.md` / `docs/TASKS.md` / `docs/STATUS.md` | 改 | 第四十二节、任务 51 与接续状态 |

## 三十二、2026-09-21 深夜：账户重构 A2/A9（硬删除与手机复查）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/lib/db.ts` | 改 | 账户删除队列、IndexedDB 硬删除、账户 Key 引用读取、删除标记防复活 |
| `apps/web/src/lib/keystore.ts` | 改 | 按 keyRef 清理明文/口令库中的本机缓存 |
| `apps/web/src/lib/sync.ts` | 改 | 同步密码缓存按 storageId 隔离，旧全局键迁移 |
| `apps/web/src/components/AccountPanel.tsx` | 改 | 输入账户 ID 确认、硬删除流程、共享 Key 保护、删除结果说明 |
| `apps/web/src/styles.css` | 改 | 删除确认块适配窄屏；inline 选择行按钮不再折行 |
| `docs/EVAL.md` / `docs/SYNC.md` / `docs/TASKS.md` / `docs/STATUS.md` | 改 | 第四十三节、任务 52/53、账户级密码与硬删除边界 |

## 三十三、2026-09-21 深夜：顺序 54（身份输入法/手写组合修复）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/components/PersonaLibrary.tsx` | 改 | 本地草稿、composition 起止保护、停止 300ms/失焦保存 |
| `docs/EVAL.md` / `docs/TASKS.md` / `docs/STATUS.md` | 改 | 第四十四节、任务 54 与验证结果 |

## 三十四、2026-09-22：顺序 55（移动端回车换行）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/lib/viewport.ts` | 改 | 增加粗指针检测，供输入区区分移动端软键盘 |
| `apps/web/src/components/MainChat.tsx` / `SideChat.tsx` | 改 | 触摸设备回车换行，桌面保留 Enter 发送；组合输入不误发 |
| `docs/EVAL.md` / `docs/TASKS.md` / `docs/STATUS.md` | 改 | 第四十五节、任务 55 与验证结果 |

## 三十五、2026-09-22：服务器管理台方案

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `docs/ADMIN-CONSOLE.md` | **新增** | 明确服务器只有密文空间、三种管理形态比较、推荐 SSH 隧道本机网页台、接口与审计边界 |
| `docs/STATUS.md` / `docs/TASKS.md` | 改 | 文档地图、任务 56 与待拍板方向 |

## 三十六、2026-09-23：顺序 57（被取代原文退出常规召回，保留「提到才想起」）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `packages/core/src/memory/recall.ts` | 改 | `RecallOptions.superseded`（默认排除被取代原文）、`isSuperseded()`、统一入口 `recallForPrompt()`（常规 / 提到 / 印象来源三条通路，补充项分数压低并在预算里留 ≤1/4 的位置）；`selectWithinBudget` 改成泛型 |
| `packages/core/src/memory/recall.test.ts` | 改 | 新增 9 条：默认排除、include、提到 ≤2 且排后、只看玩家这一句、问过去展开来源、不重复、预算先丢补充项、近事填满预算时仍留位置 |
| `packages/core/src/prompt/assemble.ts` | 改 | `PromptMemory.origin`、记忆块按来源标注与提示语、`AssembledPrompt.memoryStats`（只数预算后留下的） |
| `packages/core/src/prompt/assemble.test.ts` | 改 | 新增 2 条：来源标签与统计；统计只数留下的 |
| `apps/web/src/App.tsx` | 改 | 召回段改走 `recallForPrompt`（`mentionText` 只传玩家这一句、`askingPast`），`toPromptMemory` 带 `origin` |
| `apps/web/src/components/PromptInspector.tsx` | 改 | 「记忆 N 条：常规召回 · 提到才想起 · 印象来源」一行；区块列表项悬停显示 id |
| `docs/EVAL.md` / `docs/TASKS.md` / `docs/STATUS.md` / `docs/MEMORY.md` | 改 | 第四十六节、任务 57 与偏差、接续点；MEMORY 改正「合并任务每 40 条一个桶」 |

## 三十七、2026-09-23：顺序 58（提示词按场记覆盖收起远处原文）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `packages/core/src/model/conversation.ts` | 改 | `ConversationModes.historyMode / historyNearWindow`、`HistoryPolicy`、`historyPolicyOf()`（缺省 recap-aware / 40） |
| `packages/core/src/memory/summary.ts` | 改 | `coveredBySummary()`：一场里已被场记覆盖的消息 id |
| `packages/core/src/prompt/history.ts` | 改 | `partitionHistory()`（未覆盖全带 / 近窗内全带 / 其余收起）、`expandHistoryOnMention()`（提到才取回 ≤3 条） |
| `packages/core/src/prompt/history.test.ts` | **新增** | 8 条：full 模式、覆盖 + 近窗、无场记文字不收、消息 id 游标与多场、按可见历史计近窗；取回的排序 / 上限 / 不命中 |
| `packages/core/src/prompt/assemble.ts` | 改 | `scenes / historyPolicy / mention` 入参；「前几场」块（已结束未进章节的场记）；「提到的旧对话原文」块；`historyStats` 扩成 total / visible / collapsed / recalled |
| `packages/core/src/prompt/assemble.test.ts` | 改 | 新增 5 条（收起与近窗、提到取回、mention 单独传、已进章节不重复、full 与缺省策略） |
| `packages/core/src/prompt/types.ts` / `budget.ts` | 改 | 块类型加 `history-recall`，预算第 2 级与附件展开同级 |
| `apps/web/src/lib/session.ts` | 改 | `scenes`：当前对话的全部场景（含已结束） |
| `apps/web/src/lib/worker.ts` | 改 | 已结束场景有没压的尾巴就压场记（不再按门槛判） |
| `apps/web/src/App.tsx` | 改 | 装配传 `scenes / historyPolicy / mention`；`mentionText` 单独传玩家这一句；`handleChangeModes` |
| `apps/web/src/components/MainChat.tsx` | 改 | 对话模式菜单加「场记覆盖后收起远处原文」；`onChangeModes(patch)` |
| `apps/web/src/components/PromptInspector.tsx` | 改 | 历史账一行：可见 / 收起 / 取回 |
| `docs/EVAL.md` / `docs/TASKS.md` / `docs/STATUS.md` / `docs/MEMORY.md` | 改 | 第四十七节、任务 58 与偏差、接续点；MEMORY 第八节成本按新曲线修订 |

## 三十八、2026-09-24：顺序 59（流式状态隔离与消息渲染）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/lib/stream-store.ts` / `stream-store.test.ts` / `render-count.ts` | **新增** | 四态外置（`main` / `admin` 两条通道）、通知边界与通道隔离单测、开发态渲染计数 |
| `apps/web/src/components/StreamingBubble.tsx` / `MessageItem.tsx` / `SideChat.tsx` | **新增 / 改** | 流式唯一订阅者；已落盘消息的 memo 列表和单条组件；副对话自己订阅 `admin` 通道并 memo |
| `apps/web/src/App.tsx` / `components/MainChat.tsx` / `lib/admin.ts` | 改 | token 不触发根节点状态更新，稳定回调，流式与消息列表分开；副对话流式搬出 App、返回值 memo 化 |
| `apps/web/src/components/CastRail.tsx` / `LeftRail.tsx` / `MessageBody.tsx` / `RuntimePanel.tsx` / `WorldTree.tsx` | 改 | memo 与开发态渲染计数 |
| `apps/web/src/lib/session.ts` / `providers.ts` / `sync.ts` / `worker.ts` / `usage.ts` | 改 | hook 返回值稳定，消息落盘只作必要的本地更新 |
| `apps/web/src/main.tsx` / `apps/web/package.json` / `pnpm-lock.yaml` | 改 | 开发态 Profiler 与 Web Vitest 脚本 |
| `docs/EVAL.md` / `STATUS.md` / `TASKS.md` / `FILE-LOG.md` | 改 | 第四十八节、59 状态与文件记录 |

## 三十九、2026-09-24：顺序 60（世界书插入位置语义）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `packages/core/src/compat/sillytavern/worldbook.ts` | 改 | 逐条 `scanDepth`、递归 ≤3 轮（`preventRecursion` / `excludeRecursion`）、group 只留一条；认不出的位置码记一条导入 warning；`WorldBookMatch.round` |
| `packages/core/src/compat/sillytavern/worldbook.test.ts` | 改 | +13：scanDepth / 递归 / group / 位置码 warning |
| `packages/core/src/prompt/types.ts` | 改 | `PromptPlacement` 与 `PromptBlock.placement` / `depth` |
| `packages/core/src/prompt/assemble.ts` | 改 | 世界书每条命中各成一块并按位置插入；`toChatMessages` 支持 `at_depth` 插进历史；同标签相邻块合并渲染 |
| `packages/core/src/prompt/worldbook-placement.test.ts` | **新增** | 7 个落点单测（每种 position、at_depth 的三种边界、默认位置形状不变、order 决定丢谁） |
| `apps/web/src/App.tsx` | 改 | 扫描窗口不再预拼 `slice(-8)`，改成按时间传 `scanLines` |
| `apps/web/src/components/PromptInspector.tsx` | 改 | 块列表显示落点（人设前 / 场景后 / 插进历史 N） |
| `docs/DESIGN.md` | 改 | 新增 §9.3：`position` → prompt 层的映射表与理由 |
| `docs/EVAL.md` / `STATUS.md` / `TASKS.md` / `README.md` / `FILE-LOG.md` | 改 | 第四十九节、接续点、任务 60 收口、README「已经能用的」补位置语义 |

## 四十、2026-09-24：顺序 61（同步与数据安全底线）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `packages/core/src/sync/http-client.ts` | 改 | 新增 `SyncHttpError`（`status` + `code`），错误体的 code 原样透传 |
| `packages/core/src/sync/http.ts` / `types.ts` / `loop.ts` | 改 | 删除 `push` 的死参数 `baseHead`；`handleSyncRequest` 接受 `clientKey` 并传给建空间 |
| `packages/core/src/sync/server.ts` | 改 | `spacesPerMinute` / `maxSpaces` 两条护栏（容量只对新建生效）、字节配额改成写后判定、`spaceCount` |
| `packages/core/src/sync/sqlite.ts` | 改 | 新增 `applySqlitePragmas()`（WAL + busy_timeout）与 `spaceCount()` |
| `packages/core/src/crypto/keys.ts` | 改 | `wrapSpaceKey` / `unwrapSpaceKey` 接受已派生的 `SecretKeys`：建空间 4→2 次、登录与换密码 2→1 次 PBKDF2 |
| `packages/core/src/storage/repository.ts` | 改 | `providerCredentials` 的墓碑只留坐标（不再带密文） |
| `apps/web/src/lib/sync.ts` / `components/SyncPanel.tsx` | 改 | 按 `code`/`status` 判空间满与空间不在；`SyncApi` 多 `errorStatus`；去掉换密码后多余的 KeyStore 写入 |
| `tools/sync-server/src/main.ts` / `src/node.d.ts` / `backup.mjs` / `.env.example` | 改 | 启动时设 PRAGMA、按来源限流取 `x-forwarded-for`、新环境变量、备份设 `busy_timeout` |
| `packages/core/src/sync/{http,limits,sqlite}.test.ts` / `crypto/keys.test.ts` / `storage/repository.test.ts` | 改 | +13：错误码透传 2、建空间护栏 4、字节配额 1、SQLite 并发 1、派生次数 4、墓碑 2（其中两条同时覆盖反向情形） |
| `docs/SYNC.md` / `EVAL.md` / `STATUS.md` / `TASKS.md` / `FILE-LOG.md` | 改 | §4.9.1 / §4.9.2、第五十节、接续点、任务 61 收口 |

## 四十一、2026-09-24：顺序 62（存储层 O(N) 热点与两处重画）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/lib/db.ts` | 改 | `DB_VERSION` 1→2；新增 `byCollectionRoom` / `byCollectionUpdated` 两个索引；`roomId` 查询走索引；`listSince` 走 `updatedAt` 索引；老库升级只补索引不动数据 |
| `packages/core/src/platform/entity-store.ts` / `memory-store.ts` | 改 | `EntityStore.listSince?` 可选增量读口；内存实现同样实现（语义一致） |
| `packages/core/src/storage/repository.ts` | 改 | `countAlive` 走 `store.count`；`listSyncRecords` 优先 `listSince`；`stampUpdatedAt` 缓存逻辑时钟与水位线；新增并导出 `reuseUnchangedCollections` |
| `packages/core/src/render/attribution.ts` | 改 | `AttributionInput.cast` 收窄成 `{id, displayName}[]`（新增导出 `CastName`） |
| `apps/web/src/lib/session.ts` | 改 | `reloadWorld` 用 `reuseUnchangedCollections`：没变的集合沿用旧数组 |
| `apps/web/src/lib/worker.ts` | 改 | 空跑的 8 秒 tick 不再 `setRunning`（`runningRef` 镜像） |
| `apps/web/src/App.tsx` / `components/MainChat.tsx` / `MessageItem.tsx` | 改 | App 回调过 ref 保持稳定；MainChat 用「名字没变就保持引用」的 `castNames`；消息列表只吃 `CastName[]` |
| `packages/core/src/storage/repository.test.ts` | 改 | +5：快照引用复用的四个方向（不变 / 消息变了 / 空 / 换世界）、墓碑不计入计数、`listSince` 与整表过滤一致 |
| `docs/EVAL.md` / `STATUS.md` / `TASKS.md` / `FILE-LOG.md` | 改 | 第五十一节、接续点、任务 62 收口与 P1 的「未复现」结论 |

## 四十二、2026-09-24：手机端顶栏按 DeepSeek 布局重排

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/components/TopBar.tsx` | 改 | 窄屏分支：三横图标开左栏、中间角色条、右上角两颗控件；删掉「全屏」与「存储」；保留「数据不会保存」警告 |
| `apps/web/src/components/CastStrip.tsx` | **新增** | 手机顶栏里的半高在场角色条；点一下把名字插进输入框 |
| `apps/web/src/components/ChatControls.tsx` | **新增** | 主/副合一的可切换按钮 + 面板按钮（只在窄屏由 TopBar 渲染） |
| `apps/web/src/components/MainHeader.tsx` | 改 | 窄屏时不再渲染在场角色与两颗按钮（都由顶栏接管），只留「世界名 · 对话名」 |
| `apps/web/src/components/MainChat.tsx` | 改 | 新增 `insertRequest`：把顶栏递来的角色名插到光标处并聚焦输入框 |
| `apps/web/src/components/Icons.tsx` | 改 | 新增 `IconMenu`（三横） |
| `apps/web/src/lib/viewport.ts` | 改 | 删掉 `useFullscreen` / `FullscreenApi`（功能弃掷） |
| `apps/web/src/App.tsx` | 改 | 接线（castNames / castAsk / ChatControls / CastStrip）；删除全屏；安装引导文案去掉「点顶栏的全屏」 |
| `apps/web/src/styles.css` | 改 | `.topbar.narrow`（无卡片 + 安全区）、`.cast-strip`（半高、可横滑、隐藏滚动条）、`.chat-controls` / `.kind-toggle` / `.kind-half`、窄屏标题栏不再换行 |
| `docs/LAYOUT.md` / `EVAL.md` / `STATUS.md` / `FILE-LOG.md` | 改 | 顶栏规格的手机端分支与两处删除、第五十二节（含前后截图路径与实测数字）、接续点 |

## 四十三、2026-09-24：上线（部署 + push）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `docs/STATUS.md` / `EVAL.md` / `FILE-LOG.md` | 改 | 上线记录：提交区间、两个构建、health、`journal_mode=wal`、同步冒烟 6/6、两个回滚点、仍然没验的项 |

本轮**没有改任何源码**——部署的是 `6086096` 那个提交构建出来的产物：
`apps/web/dist`（`index-CqzQpPAn.js`）与 `tools/sync-server/dist`（另加 `backup.mjs`）。

## 四十四、2026-09-24：手机端第二批（删标题栏 + 推开式卡片）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/styles.css` | 改 | 手机端：左栏与面板都改成圆角卡片 + 位移进出（`--drawer-ms`）、主对话与顶栏让位、删掉两条 scrim 规则、`prefers-reduced-motion` 兜底 |
| `apps/web/src/App.tsx` | 改 | 根节点加 `rail-open` / `panel-open`；左栏在手机上始终挂载；删掉两个遮罩按钮；手机上不渲染主区标题栏；两侧开关互斥（`handleToggleRail` / `handleTogglePanel`） |
| `apps/web/src/components/LeftRail.tsx` | 改 | 窄屏时顶上多一颗 ≡ 收起按钮（`narrow` / `onClose`） |
| `apps/web/src/components/WorldTree.tsx` | 改 | 每条对话加「改名」（就地输入、Enter 保存、Esc 取消、失焦保存） |
| `apps/web/src/lib/session.ts` | 改 | 新增 `renameConversation(id, title)`：按 id 改名，**不切换当前对话** |
| `docs/LAYOUT.md` / `EVAL.md` / `STATUS.md` / `FILE-LOG.md` | 改 | 手机端第二批的规格、第五十四节（含实测 11/11 与那个 transform/fixed 的坑）、接续点 |

## 四十五、2026-09-24：手机端第三批（铺满整屏 + 顶栏覆盖 + 点对话区收起）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/styles.css` | 改 | 手机端：`.app` padding/gap 归零、对话无边框铺满整屏、顶栏改 `fixed` 半透明覆盖层（毛玻璃 + 安全区）、`.chat-body` 给覆盖层留起始内边距、新增 `.drawer-backdrop`；删掉 `.drawer-close` / `.rail-head-close` 两组规则 |
| `apps/web/src/App.tsx` | 改 | 删掉面板里的「收起面板」按钮；新增透明可点层：`narrow && (左栏开着 || 面板开着)` 时点它同时收起两侧；左栏不再传 `narrow` / `onClose` |
| `apps/web/src/components/LeftRail.tsx` | 改 | 移除窄屏时那颗 ≡ 收起按钮（改由点对话区收起） |
| `docs/LAYOUT.md` / `EVAL.md` / `STATUS.md` / `FILE-LOG.md` | 改 | 第三批规格与第五十四节第二轮实测（14/14）、接续点 |

## 四十六、几点注意

---

1. **以提交时间为准。** 文件系统时间只反映「本机上的这份拷贝」——重新 clone、换机器、
   从压缩包解开会全部重置成解压时刻。
2. **本文档里的时间都在同一台机器、同一个时区（Asia/Shanghai）下采集。**
3. 表格里**「修改」比「最近提交」新**的文件，说明它在最后一次提交之后又被改过
   （尚未提交）。本文档与 TASKS.md 自身就属于这种情况。
4. 想只看「最近动过的文件」：

   ```bash
   git log --name-only --pretty=format:'%h %ad %s' --date=short -5
   git status --short
   ```
