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

## 四十六、2026-09-24：账户重构（账户密码 = 同步密码，添加账户分注册/登录）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/lib/account-auth.ts` | **新增** | `registerAccount` / `loginAccount` / `readAccountSyncInfo` / `selfEndpoint`：账户 ID + 密码 → 同步空间；注册先建服务端空间再建本地容器 |
| `apps/web/src/components/AccountPanel.tsx` | 改（基本重写） | 一账户一张卡片 + 「＋ 添加账户」卡片（注册 / 登录两个页签）+ 恢复码先显示再进入 + 高级服务器地址 |
| `apps/web/src/components/SyncPanel.tsx` / `SettingsDialog.tsx` | 改 | 已连接的账户不再显示「用户 id / 同步密码」三件套，改成状态卡；文案改成「账户密码就是同步密码」 |
| `apps/web/src/lib/sync.ts` | 改 | 导出 `SYNC_CONFIG_META_KEY`（注册/登录时要往别的账户库里写这份配置） |
| `apps/web/src/styles.css` | 改 | 账户卡片、添加账户、恢复码等样式 |
| `docs/SYNC.md` / `EVAL.md` / `STATUS.md` / `FILE-LOG.md` | 改 | §4.9.3 设计、第五十五节验证、接续点 |

## 四十七、2026-09-24：多设备同步精简为一个按钮

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/components/SyncPanel.tsx` | 改 | 已连接的账户：只留「同步」按钮 + 一行状态；其余（保存方式 / 状态明细 / 快照 / 设备与改密码 / 重新拉 / 断开）收进折叠的「高级」；删掉重复的信息卡与长段落 |
| `apps/web/src/components/SettingsDialog.tsx` | 改 | 「多设备同步」的说明压成两行 |
| `apps/web/src/styles.css` | 改 | `.sync-primary`（按钮 + 状态行）与 `.sync-advanced`（折叠区） |
| `docs/EVAL.md` / `STATUS.md` / `FILE-LOG.md` | 改 | 第五十五节追加、接续点、文件记录 |

## 四十八、2026-09-24：顺序 63（统一草稿 hook）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/lib/useDraftField.ts` | **新增** | 文本字段的本地草稿 + 防抖 300ms + 失焦提交 + 组合期不提交 + 同值不重复提交 |
| `apps/web/src/components/ScenePanel.tsx` | 改 | 地点 / 世界内时间 / 场景设定三处改用草稿 hook |
| `apps/web/src/components/MainHeader.tsx` / `CastDetail.tsx` | 改 | 对话名、角色显示名改用草稿 hook（空值不提交） |
| `apps/web/src/components/CastPanel.tsx` / `MemoryPanel.tsx` | 改 | 在 `map` 里的输入框各抽小组件（`CastNameInput` / `MemoryDraftArea`）：hook 不能在循环里调 |
| `docs/EVAL.md` / `TASKS.md` / `STATUS.md` / `FILE-LOG.md` | 改 | 第五十六节、任务 63 收口、接续点 |

## 四十九、2026-09-24：顺序 66 第一步（useNotices / useWebBridge）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/hooks/useNotices.ts` | **新增** | `error` / `warnings` / 安装引导 + 存储快满提醒；`Notice` 类型也搬到这里 |
| `apps/web/src/hooks/useWebBridge.ts` | **新增** | 网页版桥接状态 + sessionStorage 落盘 |
| `apps/web/src/App.tsx` | 改 | 两处状态改由新 hook 提供（解构沿用原名）；依赖数组按 Biome 提示补齐；1947 → 1905 行 |
| `docs/EVAL.md` / `TASKS.md` / `STATUS.md` / `FILE-LOG.md` | 改 | 第五十七节、任务 66 标「进行中（2/4）」、接续点 |

## 五十、2026-09-24：顺序 66 第二步（useImport）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/hooks/useImport.ts` | **新增** | 导入 PNG/JSON 角色卡与世界书、导入警告、内嵌世界书、导完收起手机左栏；`looksLikePng` / `looksLikeWorldBook` 一并搬来 |
| `apps/web/src/App.tsx` | 改 | 导入逻辑改调 hook；删掉搬走的两个判定函数；1905 → 1853 行 |
| `docs/EVAL.md` / `TASKS.md` / `STATUS.md` / `FILE-LOG.md` | 改 | 第五十七节补第二步与「为什么 useTurnRunner 留到下一轮」、任务 66 状态（3/4） |

## 五十一、2026-09-25：新世界入口与双角色开场修复（用户实测缺陷）

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/App.tsx` / `components/LeftRail.tsx` / `components/WorldTree.tsx` / `components/NewConversationDialog.tsx` / `styles.css` | 改 | 顶部新建独立世界，世界行内续开指定世界；双名称弹窗与续开提示 |
| `apps/web/src/lib/session.ts` | 改 | 新世界首条对话接收对话名、场景、地点和世界时间 |
| `apps/web/src/hooks/useTurnRunner.ts` / `lib/output-limit.ts` / `lib/output-limit.test.ts` | 改 / 新增 | 每角色一轮实际传输出 token 上限，并覆盖旧配置零预留量 |
| `packages/core/src/session/turn.ts` / `turn.test.ts` | 改 | 自动开场短化、多角色台词归属、模板展开和动作格式 |
| `packages/core/src/render/segments.ts` / `segments.test.ts` | 改 | 自动开场兼容字面换行，保留 URL、路径等原文 |
| `packages/core/src/prompt/assemble.ts` / `assemble.test.ts` | 改 | 本轮提示词强调玩家身份、未知信息与只写当前角色 |
| `docs/LAYOUT.md` / `TASKS.md` / `STATUS.md` / `EVAL.md` / `FILE-LOG.md` | 改 | 更新入口语义、用户缺陷与验证记录 |

## 五十二、2026-09-25：图标与设置交互第一轮

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/components/Icons.tsx` / `WorldTree.tsx` / `styles.css` | 改 | SVG 16/20 px 与统一描边；世界行续开入口改同款加号，手机触摸区 170×44 px |
| `apps/web/src/components/RuntimePanel.tsx` | 改 | 运行时视图选中态可读 |
| `apps/web/src/components/SettingsDialog.tsx` | 改 | 模态语义、焦点循环与回焦、异步存储反馈 |
| `apps/web/src/components/ProviderPanel.tsx` | 改 | Key 粘贴文案与保存动作一致，保存/读取状态及错误反馈 |
| `docs/EVAL.md` / `STATUS.md` / `TASKS.md` / `FILE-LOG.md` | 改 | 第一轮 UI/UX 评测与剩余真机清单 |

## 五十三、2026-09-25：手机信息层级和运行时键盘路径

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/components/ProviderPanel.tsx` | 改 | 设置里只保留一处「模型接入」标题 |
| `apps/web/src/components/RuntimePanel.tsx` / `App.tsx` | 改 | 手机上打开运行时面板先聚焦首页签，Esc 关闭并回焦顶栏 |
| `apps/web/src/styles.css` | 改 | 手机面板标签 13 px、全局按钮和链接的主题色键盘焦点环 |
| `docs/EVAL.md` / `LAYOUT.md` / `STATUS.md` / `TASKS.md` / `FILE-LOG.md` | 改 | 前后测量、键盘路径与真机边界 |

## 五十四、2026-09-25：DeepSeek 接入与回复完整性

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `apps/web/src/lib/providers.ts` / `components/ProviderPanel.tsx` | 改 | 新配置默认现行 DeepSeek 模型，旧模型配置提示迁移；不改已有密钥引用 |
| `apps/web/src/lib/output-limit.ts` / `output-limit.test.ts` | 改 | 现行 DeepSeek 思考模型不发 512 token 硬上限 |
| `packages/core/src/provider/openai-compatible.ts` / `tools.test.ts` | 改 | 识别过滤、截断、中止、坏 SSE 与提前断流；不把部分输出当作完成 |
| `apps/web/src/hooks/useTurnRunner.ts` | 改 | 空正文报错；重抽先生成并验证再替换旧回复 |
| `docs/STATUS.md` / `TASKS.md` / `EVAL.md` / `FILE-LOG.md` | 改 | 记录范围、假响应门禁、真实模型与上线结果 |

## 五十五、2026-09-25：角色沉浸提示词文档

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `docs/ROLEPLAY-PROMPT.md` | 新增 | 完整的角色沉浸模板、角色卡系统提示粘贴路径与服务商过滤边界 |
| `docs/STATUS.md` / `FILE-LOG.md` | 改 | 加入文档入口与文件记录 |

## 五十六、2026-09-25：角色卡高级系统提示默认值

| 文件 | 新增/修改 | 说明 |
| --- | --- | --- |
| `packages/core/src/model/card.ts` / `card.test.ts` | 改 / 新增 | 默认模板与旧空字段解析；新卡默认值单测 |
| `packages/core/src/compat/sillytavern/card.ts` / `card.test.ts` | 改 | 导入卡空字段用默认值，自定义提示不覆盖 |
| `packages/core/src/admin/tools.ts` / `tools.test.ts` | 改 | 管理员新建卡草稿沿用默认值 |
| `packages/core/src/prompt/assemble.ts` / `assemble.test.ts` / `budget.ts` / `types.ts` | 改 | 旧空字段运行时回退到默认模板；小预算只压缩默认提示 |
| `apps/web/src/components/CardDesigner.tsx` | 改 | 旧卡空字段在高级编辑器中显示实际默认值 |
| `packages/core/src/model/conversation.ts` / `prompt/assemble.ts` / `assemble.test.ts` | 改 | 当前对话可保存并装配独立的高级系统提示 |
| `apps/web/src/components/MainChat.tsx` / `styles.css` | 改 | 加号菜单加入高级提示编辑与显式保存，手机视口内可滚动 |
| `docs/ROLEPLAY-PROMPT.md` / `STATUS.md` / `TASKS.md` / `EVAL.md` / `FILE-LOG.md` | 改 | 使用路径、范围和验证记录 |

## 五十六半、2026-09-25：长对话质量（旁白腔 / 动作重复 / 回答模式）

顺序 67e。来源是 2026-09-25 用真实模型在侧边浏览器跑的 178 轮质量长跑
（实录与统计在 `%USERPROFILE%\.codex\visualizations\...\quality-run-transcript.json`，
结论见 EVAL 第六十八节）。

| 文件 | 改 / 新增 | 说明 |
| --- | --- | --- |
| `packages/core/src/model/conversation.ts` | 改 | `ConversationModes.replyLength` 三档（偏短 / 标准 / 偏长）与 `replyLengthOf`，缺省标准、认不出的值退回标准 |
| `packages/core/src/prompt/reply-style.ts` | 新增 | 三档长度规矩 + 反重复规矩（允许连续多个不同动作、不重复同一动作、动作句不拿自己的名字当主语、不复述已答过的事） |
| `packages/core/src/prompt/assemble.ts` | 改 | 新增可丢弃块 `reply-style`（优先级 850，仅低于本轮指令），进 system 提示 |
| `packages/core/src/index.ts` | 改 | 导出 `prompt/reply-style.js` |
| `packages/core/src/prompt/assemble.test.ts` | 改 | 缺省与非法值、三档互斥、反重复规矩进正文，共 5 条 |
| `apps/web/src/components/MainChat.tsx` | 改 | 输入区加号菜单里加「回答长度」三个单选项，写回对话模式 |
| `apps/web/src/components/CardDesigner.tsx`、`packages/core/src/compat/sillytavern/card.ts` | 改（格式） | 这两处是另一条会话的未提交改动；`biome check` 报格式/导入顺序错误，本批顺手格式化，语义未改 |
| `docs/STATUS.md` / `TASKS.md` / `EVAL.md` / `FILE-LOG.md` | 改 | 本轮范围、实现与验证记录 |

## 五十七、2026-09-25：顺序 68（账单 `since` 下推与汇总不排序）

TASKS 第〇节顺序 68。用户裁定「A+B 推进」；原方案里的 `limit` 下推与增量汇总按实测拆开
（前者不做，后者记成顺序 80）。做法、实测数字与未验项见 EVAL 第六十九节。

| 文件 | 改 / 新增 | 说明 |
| --- | --- | --- |
| `packages/core/src/storage/usage.ts` | 改 | `UsageRecord.updatedAt`（与 `createdAt` 恒等、不参与同步）；内部 `read()` 把 `since` 下推到 `listSince`（`inclusive`）；`list()` 自己按 `(createdAt, id)` 定序；`summary()` 不再走 `list()`；`summarizeUsage` 分组并列按 key 定序（与输入顺序无关） |
| `packages/core/src/platform/entity-store.ts` | 改 | `listSince` 增加 `options.inclusive`（缺省仍是严格大于，同步水位线语义未变） |
| `packages/core/src/platform/memory-store.ts` | 改 | 内存实现支持 `inclusive`，语义与索引实现逐条对齐 |
| `apps/web/src/lib/db.ts` | 改 | IndexedDB 实现按 `inclusive` 决定 `IDBKeyRange` 下界含不含等于（**未动 schema 版本**） |
| `packages/core/src/storage/repository.ts` | 改 | `SCHEMA_VERSION` 10 → 11；迁移 11：把老账单的 `updatedAt` 归一到 `createdAt`（否则索引漏掉老账单、`since` 安静少算钱） |
| `packages/core/src/storage/usage.test.ts` | 改 | 顺序 68 定点单测 +8：不变量、含等于边界、下推 vs 整表逐条对账（含 `limit`、并列同一毫秒）、汇总顺序无关、不走存储层排序、老账单被漏掉的复现、迁移 11、账单不在同步白名单 |
| `packages/core/src/storage/repository.test.ts` | 改 | `listSince` 等价性测试扩到 `inclusive`；v10 迁移测试的 `applied` 钉成 `[10, 11]` |
| `packages/core/src/storage/budget.test.ts` | 改 | 构造汇总入参时补上 `updatedAt`（类型新增字段） |
| `docs/STATUS.md` / `TASKS.md` / `EVAL.md` / `FILE-LOG.md` | 改 | 本轮范围、实测数字、没做与没验的部分；新增顺序 80 |

## 五十八、2026-09-25：无限制模式（正文改为用户数据）

用户点名（记成顺序 68a）：把输入区「＋」里的「高级系统提示 · 当前对话」文本框换成一个对话级开关。
**中途翻过一次案**：第一版把正文做成代码常量，被查出会编译进**公开托管**的网页包（用户说那是商业
机密），于是改成「正文 = 用户数据，存本机 meta」。做法、泄露复核与验证见 EVAL 第七十节。

| 文件 | 改 / 新增 | 说明 |
| --- | --- | --- |
| `packages/core/src/prompt/unlimited.ts` | 新增→重写 | 第一版是正文常量；现在**只留 `unlimitedPromptOf(text)`**（空/全空白 → `null`），顶上写了「为什么代码里不能放正文」的来龙去脉 |
| `packages/core/src/model/conversation.ts` | 改 | `ConversationModes.unlimited` + `unlimitedModeOf()`（缺省关）；`defaultConversationModes()` 带上 `unlimited: false`；`advancedSystemPrompt` 注释改成「旧字段、仍生效」 |
| `packages/core/src/prompt/assemble.ts` | 改 | `AssembleInput.unlimitedPrompt`（正文由调用方传，core 不落盘不打包）；导出 `UNLIMITED_BLOCK_ID` 与 `buildUnlimitedModeBlock()`（`droppable: false`、`PRIORITY.system`）；旧「高级系统提示」块标签加「（旧）」 |
| `packages/core/src/storage/repository.ts` | 改 | `META_KEYS.unlimitedPrompt = 'modes.unlimitedPrompt'`：正文本机存、**不参与同步** |
| `packages/core/src/index.ts` | 改 | 导出 `prompt/unlimited.js` |
| `packages/core/src/prompt/assemble.test.ts` | 改 | 7 条：缺省关、空正文不给块、块形状、开关开+有正文进 `messages[0]`、开关开+无正文不加块、开关关+有正文不加块、旧字段仍装配 |
| `apps/web/src/lib/useUnlimitedPrompt.ts` | 新增 | 读写本机 meta 的 hook（返回对象 memo 化，符合顺序 59 的约定） |
| `apps/web/src/hooks/useTurnRunner.ts` | 改 | 装配前现读一次正文并传进 `runTurn` 的输入（刚粘好就发消息也不会慢一拍） |
| `apps/web/src/components/MainChat.tsx` | 改 | 加号菜单：`MODE_OPTIONS` 里的「无限制模式」勾选框 + 粘贴框 + 「保存提示词」+ 字数/未填说明；旧字段非空时说明 + 「清空旧提示」 |
| `apps/web/src/App.tsx` | 改 | 接上 `useUnlimitedPrompt(db)` 并把 api 传给 `MainChat` |
| `apps/web/src/styles.css` | 改 | `.mode-menu-button`（两个菜单按钮共用）+ 粘贴框样式 `.mode-menu-label` / `.mode-text-input` |
| `docs/ROLEPLAY-PROMPT.md` | 改 | 「当前对话的额外提示：无限制模式」：粘贴位置改成应用内、四条须知、以及「正文不进代码」的原因 |
| `docs/STATUS.md` / `TASKS.md` / `EVAL.md` / `FILE-LOG.md` | 改 | 本轮范围、泄露复核、验证记录；新增顺序 68b（提示词随账户加密同步） |

> 本批还有一个**不进仓库**的产物：`secrets/unlimited-prompt.txt`（`.gitignore` 已挡住）——
> 用户粘贴的正文从代码里取出来存这儿，用作泄露复核的参照物。**不要提交它。**

## 五十九、2026-09-26：审计第一批（顺序 81，本机助手加固）+ 审计 58 条归账

审计报告 `docs/AUDIT-2026-09-26.md`（提交 `71a26be`）里的 A1/A13/C19/C20 四条 P0 写在分支提交 `96120d9` 上，
本批**合入 main**（合并提交 `acb93dd`，无冲突），另补 `.gitignore` 两行与四处文档。做法与验证见 EVAL 第七十一节。

| 文件 | 改 / 新增 | 说明 |
| --- | --- | --- |
| `tools/local-bridge/policy.mjs` | 新增（`96120d9`） | 155 行**纯函数**：`DEFAULT_ALLOWED_ORIGINS`、`parseOriginList`/`parsePort`、`isAllowedHost`、`isAllowedOrigin`、`isAuthorized`（常量时间）、`checkAccess`、`clampTimeout`、`readLimitedBody`（超限 413）、`createSerialQueue`（排队上限 429） |
| `tools/local-bridge/policy.test.mjs` | 新增（`96120d9`） | 299 行 / **15 条断言 / 5 suites**，其中 3 条真起进程（外来 Origin 被拒、令牌必带 Bearer、非法端口启动即退出）；**`pnpm test` 跑不到它**（`tools/*` 不在 workspace），要手动 `node --test` |
| `tools/local-bridge/server.mjs` | 改（`96120d9`） | 每个请求先 `checkAccess`（Host 必须 127.0.0.1/localhost:PORT，Origin 走白名单，可选令牌）；`cors()` 改成回显白名单 + `vary: Origin` + `access-control-allow-private-network`，**不再回 `*`**；被拒的请求不回 CORS 头；`--port`/`--cdp` 走 `parsePort` |
| `tools/local-bridge/README.md` | 新增（`96120d9`） | 白名单/令牌怎么配；**9222 调试端口的风险**（本机任何进程都能完全控制那个 Chrome，必须独立 `--user-data-dir`） |
| `tools/fake-model/server.mjs` | 改（`96120d9`） | 只放行本机来源（任意端口），不再回 `*` |
| `tools/desktop/launch.mjs` | 改（`96120d9`） | `DRAMATIS_PORT` 必须 1–65535 整数，否则启动即报错 |
| `.gitignore` | 改 | 追加 `.claude/`（agent worktree，各带一份 node_modules）与 `tmp-test-cards/`（真实角色卡）——不忽略的话一次 `git add -A` 会把它们提交进去；`.claude/` 之前只写在 `.git/info/exclude` 里，是**本机私有**的绕法（biome 会因 worktree 里的嵌套 `biome.json` 直接报错退出，挡住 `pnpm lint`） |
| `docs/TASKS.md` | 改 | 新增顺序 **81–86** 六行；新增「审计遗留」小节：58 条的归属表、4 条重复实现、**5 条没人修**、**2 条只接了一半**、顺序 82 的三处必须先改 |
| `docs/EVAL.md` | 改 | 新增**第七十一节**：审计第一批的原状→现状对照、五项门禁、手动 15 条测试、行为变更（白名单从「谁都能调」收紧）、没验的三条、以及 `tools/*` 不在门禁里的结构性缺口 |
| `docs/STATUS.md` | 改 | 新增「2026-09-26：审计遗留归账 + 顺序 81 落地」一段与下一步（82–86，其中 84/85 必须等脏文件提交） |

> 本批**没有 push、没有部署**（用户只说了做主集成）。合并进来的 `96120d9` 是别人写的，本批只做集成 + 补漏 + 文档。

## 六十、2026-09-26：顺序 82（审计第二批合入 main + 三处必修）

分支 `worktree-agent-a6adfa051fc0cc2bd`（A5/A11/A12/B3/B4/B8/B11/B12/B14/C1/C2/C4/C5/C6/C7 十五条）合入 main
（合并提交 `5014509`），随后在 main 上改掉只读复核判出的**三处必须先改**。做法与验证见 EVAL 第七十二节。

| 文件 | 改 / 新增 | 说明 |
| --- | --- | --- |
| `packages/core/src/storage/repository.ts` | 改（合入 + 本批） | 合入：v3 迁移、`updateEntity` 单事务、`stampUpdatedAt`、`deleteMemory` 软删 + `undoConsolidation` 等；本批新增 `listMetaKeys(prefix)` / `deleteMeta(key)`，并把 v3 守卫判据换成「该 room 是否已有 `kind === 'main'` 且未删的 conversation」，命中就接着用那条主线 |
| `packages/core/src/storage/archive.ts` | 改（合入 + 本批） | 合入：`buildIdMaps` / `remap*` 一整套引用改写 + 导入回滚；本批把标记改成 `IMPORT_PENDING_KEY_PREFIX = 'archive.importPending:'` + `newId()` 分键，加 `IMPORT_PENDING_STALE_MS = 5 * 60_000`，认老版本单键 `archive.importPending`，`recoverInterruptedImports` 返回 `{ rooms, stillPending }` |
| `apps/web/src/lib/session.ts` | 改（本批） | `useDatabase` 在 `migrate()` 之后调用 `recoverInterruptedImports`；`BootReport` 新增 `recoveredImports`，回滚结果只进 `console.warn`（界面提示没做，`App.tsx` 被另一条会话占着） |
| `packages/core/src/storage/archive-roundtrip.test.ts` | 新增（合入）/ 改（本批） | 322 行往返测试；本批把 C7 那组扩到 6 条：中途失败不留标记、页面被关掉留下的标记、另一个标签页还活着时不动它、认不出来的标记直接删、**老版本单键**（太新不动 / 死透才收拾）、正常导入不留标记 |
| `packages/core/src/storage/audit-repository.test.ts` | 新增（合入）/ 改（本批） | 本批新增「断在『主线已建、归属没改完』之间：重跑接着用那条主线」——包装 `store.put` 在写 messages 时抛「断电」；把守卫改回旧判据该测试会变红 |
| 其余合入文件（`a6adfa`） | 改 | `apps/web/src/lib/{db.ts,worker.ts}`、`compat/sillytavern/worldbook.ts`、`memory/{summary.ts,summary-cursor.test.ts}`、`platform/{background-runner.ts,background-runner.test.ts,entity-store.ts,memory-store.ts}`、`prompt/{assemble.ts,assemble.test.ts,audit-prompt.test.ts,budget.ts,budget-equivalence.test.ts}`、`storage/{archive.ts,archive.test.ts}`（合计 19 文件 1695+/266-） |
| `docs/TASKS.md` | 改 | 82 行改成 ✅；「顺序 82 合并前必须先改的三处」改成办完记录；新增「顺序 82 自己带出来的遗留」四条与**顺序 83 的只读复核回执**（可信 12 条 / 有疑 3 条 / 合并前要拍板 3 处） |
| `docs/EVAL.md` | 改 | 新增**第七十二节**：三处必修的做法与证据、意义校验（守卫改回旧判据测试变红）、五项门禁、六条「没验的 / 已知遗留」 |
| `docs/STATUS.md` | 改 | 新增「2026-09-26：顺序 82 落进 main」一段与下一步（83–86），并把上一节的「下一步」标注为当时状态 |
| `docs/FILE-LOG.md` | 改 | 本节；顺手把上一节编号从「六十」改成**五十九**（`422782d` 里写成了六十、把「几点注意」写成六十一，五十九空着） |

> 本批**没有 push、没有部署**。合并进来的 15 条是别人写的，本批只做集成 + 三处必修 + 文档。

## 六十一、2026-09-26：顺序 83（审计第三批合入 main + 三条「有疑」补齐）

分支 `worktree-agent-a063c593632cf9c7c`（A3/A4/A6/A7/A8/A9/B1/B16/C8–C12/C14/C15 十五条）合入 main（合并提交 `6ce2b89`），
随后在 main 上按用户裁定补齐复核判「只做了一半」的三条（A4 接线 / A9 新建也 ≥6 / B1 入口串行化）。做法与验证见 EVAL 第七十三节。

| 文件 | 改 / 新增 | 说明 |
| --- | --- | --- |
| `apps/web/src/lib/sync-queue.ts` | **新增**（逐字采用 `a5ef9` 分支的同一份） | `SerialQueue` / `createSerialQueue()`（tail 链，前一个失败不卡后面的）/ `withCrossTabLock(name, task)`（有 `navigator.locks` 就用）/ `withCrossTabLockIfAvailable`（给顺序 84 的后台任务 drain 留的，当前无生产调用者） |
| `apps/web/src/lib/sync-queue.test.ts` | **新增**（同） | 4 条：串行不重叠、前一失败不卡后、无 locks 直跑、有 locks 时走锁 |
| `apps/web/src/lib/password-policy.ts` | **新增**（同） | `MIN_PASSWORD_LENGTH = 6`、`assertPassword`、`passwordStrength`、`passwordStrengthHint` |
| `apps/web/src/lib/password-policy.test.ts` | **新增**（同） | 3 条 |
| `apps/web/src/lib/account-auth.ts` | 改 | `MIN_PASSWORD_LENGTH` 与 `assertPassword` 改为 `export { … } from './password-policy'`——口令下限只留一处实现，`components/AccountPanel.tsx` 的 import 照旧可用 |
| `apps/web/src/lib/sync.ts` | 改 | 本批的 A4/A9/B1 三处：`runExclusive`（串行队列 + Web Locks，锁名 `dramatis-sync:<密码>`）；`doSync` 实体改名 `syncOnce`，新的 `doSync` 排队后先复查空间；`connect` 新建分支 `assertPassword`、created 之后 `resetSyncState`；`rotatePassword` 改用 `assertPassword`；`restoreSnapshot` 包进 `runExclusive` 并事后 `resetSyncState`；`resync` 换用 `resetSyncState` |
| 其余合入文件（`a063c`） | 改 | `packages/core/src/sync/{sqlite,server,types,http,…}.ts`（受保护的 `ALTER TABLE` 加 `epoch` / `record_count` / `byte_count`；配额 50 000 条 / 256 MB；限流 120 / 20 / 30 次每分；`SyncResetReason`、`SyncReport.reset`）、`admin/bridge*`、`platform/key-vault*`、`tools/sync-server/src/main.ts`、`docs/{SYNC,SYNC-DEPLOY}.md`（合计 24 文件 1991+/363-） |
| `docs/TASKS.md` | 改 | 83 行改 ✅；归属表三行更新；「重叠实现」补写「A9/B1 的重叠已在顺序 83 消掉」；新增「顺序 83 带出来的遗留」四条与**顺序 84 的只读复核回执**（可信 12 / 有疑 3 / 合并前 5 项） |
| `docs/EVAL.md` | 改 | 新增**第七十三节**：分支带进来的东西、三条有疑的改法表、为什么采用 `a5ef9` 的模块、五项门禁、七条「没验的 / 已知遗留」 |
| `docs/STATUS.md` | 改 | 新增「2026-09-26：顺序 83 落进 main」一段与下一步（84 真正只看两条、部署等 84/85 一起上） |
| `docs/FILE-LOG.md` | 改 | 本节；「几点注意」顺延为**六十三**（顺序 86、顺序 71 之后又两次顺延，顺序 84/85 收尾后现为**六十五**，整批上线后现为**六十六**，顺序 88 后现为**六十七**，顺序 89 后现为**六十八**，顺序 90 后现为**六十九**，顺序 92 后现为**七十**，顺序 91 后现为**七十一**，顺序 78 后现为**七十二**） |

> 本批**没有 push、没有部署**（服务端那批要重新部署才生效，用户裁定等 84/85 合完一起上）。

## 六十二、2026-09-26：顺序 86（审计遗留里没人修的五条）

审计盘查核出**五条没有任何分支在修**的三条代码问题在本批修掉（B6/B9/B15），B18 由用户裁定不改默认，B10 留给正在改它的那条分支。
做法、实测与遗留见 EVAL 第七十四节。

| 文件 | 改 / 新增 | 说明 |
| --- | --- | --- |
| `packages/core/src/storage/usage.ts` | 改 | **B9**：`CurrencyCost { currency, cost, pricedCalls }`、`UsageTotals.costs`；`addInto` 按币种 find-or-push（不再累加成一个数）；`byCurrencyRank`（条数降序、并列按币种名升序）、`finalizeTotals`（最主要的那一种写回 `cost`/`currency`）；`summarizeUsage` 四处分组账都过它；`emptyTotals` 补 `costs: []` |
| `packages/core/src/storage/usage.test.ts` | 改 | +4（→ 21）：币种各自累加、并列定序与输入顺序无关、没单价不产生币种条目、分组账各自带币种 |
| `packages/core/src/compat/sillytavern/inflate.ts` | 改 | **B15**：`MAX_INFLATED_BYTES = 8 * 1024 * 1024`、`InflateTooLargeError`、`readAllWithLimit(stream, limit)`（边读边数；超限先 `cancel()` 再抛，`finally` 里 `releaseLock()`）；`streamInflate` 改走它 |
| `packages/core/src/compat/sillytavern/png.ts` | 改 | **B15**：逐块 try/catch——`InflateUnavailableError` 仍上抛，其余推 `code: 'png.chunk-failed'` 警告（带 `关键字 <keyword>`）并跳过该块 |
| `packages/core/src/compat/sillytavern/png.test.ts` | 改 | +6（→ 20）：上限、顺序拼回、永不结束的 pull 流（证明边读边数 + `cancel()`）、真压缩炸弹、坏块跳过、解压能力缺失仍上抛 |
| `packages/core/src/compat/sillytavern/card.ts` | 改 | **B15**：`importCardFromPng` 的 `reason` 新增 `failed > 0` 分支（「另有 N 个数据块读不出来、已被跳过…」） |
| `packages/core/src/admin/tools.ts` | 改 | **B6**：`mentioned()`（`undefined`/`null` = 没提，空串 = 清空）；`AdminToolContext.cards`/`worldBooks`；`parseCardDraft`/`parseWorldBookDraft` 以现有素材为底做字段级合并（世界书同名条目复用原 id 与设置）；`alternateGreetings` 进 schema、去掉 `required: ['name','description']`；两份 draft 带 `baseUpdatedAt` |
| `packages/core/src/admin/tools.test.ts` | 改 | +7（→ 24）：改卡只写一个字段其余全保、省略 name/description、空串 vs null、数组整份替换、`baseUpdatedAt`（改卡=卡自身 `updatedAt`／新建=null）、`alternateGreetings` 在声明里、世界书条目 id 与设置复用 |
| `packages/core/src/model/message.ts` | 改 | **B6**：`AdminArtifact.baseUpdatedAt?: string \| null` 与 `conflict?: string` |
| `packages/core/src/storage/repository.ts` | 改 | **B6**：`adoptAdminArtifact` 写库前调私有 `conflictOf()`；冲突时只把 `conflict` 写到草稿上（status 仍 `pending`、`targetId` 仍 null），成功时抹掉 `conflict` |
| `packages/core/src/storage/artifact-conflict.test.ts` | **新增** | 6 条：起草后被改 → 拒采纳且不覆盖用户改动、冲突可持久化读回、没改过正常采纳、新建永不冲突、目标被删、世界书同一条路 |
| `apps/web/src/lib/usage.ts` | 改 | **B9**：`formatCost` 主币种后追加「另计 …」（`totals.costs.slice(1)`） |
| `apps/web/src/lib/admin.ts` | 改 | **B6**：`draftToArtifact` 带 `baseUpdatedAt`；两处 `context` 补 `cards`/`worldBooks` |
| `apps/web/src/components/SideChat.tsx` | 改 | **B6**：草稿卡显示 `⚠️ {conflict}`，冲突时采纳按钮禁用（未改 `styles.css`，`.hint.warn` 已存在） |
| `docs/TASKS.md` | 改 | 86 行改 ✅ + 新增**顺序 87**（额度上限按币种比较，顺序 86 带出来的）；归属表把 B6/B9/B15（✅）、B18（裁定不改）、B10（仍待做）拆成三行；新增「顺序 86 怎么处理的」表与四条遗留 |
| `docs/EVAL.md` | 改 | 新增**第七十四节**：B9 改法与「不做汇率」的理由、B15 的上限与坏块策略、B6 的五处落点、B18 的用户裁定原文与**如实记下的风险**、五项门禁、七条遗留 |
| `docs/STATUS.md` | 改 | 新增「2026-09-26：顺序 86 落进 main」一段；顺序 83 那段的「下一步」里去掉已完成的 86 |
| `docs/FILE-LOG.md` | 改 | 本节；「几点注意」顺延为**六十四**（顺序 71 之后） |

> 本批**没有 push、没有部署**。**B10 仍未修**（别人那条分支正在改 `provider/openai-compatible.ts`）。
> 顺带发现：这次 `pnpm build` 的产物里含**另一条会话未提交的头像/立绘改动**，所以包体数字（641.71 kB）不代表本批增量。

## 六十三、2026-09-26：顺序 71（token 估算校准）

审计 B12 报的「估算偏低」里，**结构开销与 5% 安全余量**早在顺序 82 就落进了 `assemble.ts`；
本批只做剩下那一半：**让估算能和真实值配对**，从而在不联网、没有 tokenizer 的前提下拿到实测比例。
不猜公式、不自动改口径——真机数字出来之前，默认除数仍是 4。做法、实测与遗留见 EVAL 第七十五节。

| 文件 | 改 / 新增 | 说明 |
| --- | --- | --- |
| `packages/core/src/token/estimate.ts` | 改 | 字面量 4 提成 `NARROW_CHARS_PER_TOKEN`（带注释：改口径要走校准报告，别手改数字）；`estimateTokens` 行为**一字未变** |
| `packages/core/src/token/calibrate.ts` | **新增** | `TokenPair`/`TokenSample`/`CalibrationReport`/`CalibrationOutlier`；`ratioOf`、`suggestedNarrowDivisorFor`（`4/ratio` 钳在 `[2,6]`，保留一位小数）、`calibrateCounts`（只有两个数）、`calibrateTokenCounter`（带原文，可换计数器）、`counterFromCalibration`（按比例包一层计数器，**不自动生效**）、`formatCalibration`；内部 `buildReport` **先求和再相除** |
| `packages/core/src/token/calibrate.test.ts` | **新增** | 12 条：无样本不下结论、估准/低估/高估、除数上下界、不可用样本（0/NaN/Infinity）丢掉、求和而非逐条平均（`{10,20}+{1000,1000}`）、`worst` 排序、原文预览折行截断、自定义计数器、放大计数器命名与取整 |
| `packages/core/src/token/estimate.test.ts` | 改 | +2（→ 8）：常量就是 4 且 `abcd`/`abcde` 的边界；`hello` 故意估成 2（保守） |
| `packages/core/src/storage/usage.ts` | 改 | `UsageRecord.promptEstimate`、`RecordUsageInput.promptEstimate`、`UsageTotals.calibration: { calls, estimated, actual }`（**估算与真实都 > 0 才计**）、`usageCalibration(totals)`；`record()` 把缺失/负数清洗后写 null；**不存正文** |
| `packages/core/src/storage/usage.test.ts` | 改 | +6（→ 27）：只有两半都有的才配对（`promptTokens: 0` 与没估算的不计）、从汇总读比例（1.3 → 除数 3.1）、无样本不下结论、没填存 null、分组账各带配对、老账本缺字段不炸 |
| `packages/core/src/index.ts` | 改 | 补 `export * from './token/calibrate.js';` |
| `apps/web/src/hooks/useTurnRunner.ts` | 改 | 主生成记账多带一行 `promptEstimate: generation.prompt?.tokenEstimate ?? null`（生产里唯一 `assemblePrompt` 调用点在 `packages/core/src/session/turn.ts:295`） |
| `apps/web/src/lib/turn-bookkeeping.ts` | 改 | `recordModelCall` 的入参加 `promptEstimate?: number \| null` 并写进 `db.ledger.record` |
| `apps/web/src/lib/turn-bookkeeping.test.ts` | **新增** | 3 条：估算与真实一起入账、没估算写 null（网页版桥接/后台分析那几条路）、`db` 为 null 时直接返回 |
| `apps/web/src/lib/usage.ts` | 改 | `CALIBRATION_MIN_SAMPLES = 10`、`formatCalibrationNote(totals)`（样本不够返回 null；相差 < 5% 说「基本一致」，否则说「少/多 N%」并点明预算守卫会偏） |
| `apps/web/src/lib/usage.test.ts` | **新增** | 7 条：B9 文案 2 条（「¥30.00，另计 $5.00」、无单价 null）+ 顺序 71 文案 5 条 |
| `apps/web/src/components/UsagePanel.tsx` | 改 | 「用量与花费」面板底部加一行 `.hint`（`calibrationNote === null` 不渲染；未改 `styles.css`） |
| `docs/TASKS.md` | 改 | 71 行改 ✅（写明「口径本身仍等真机样本」）+ 明细段落追加结论 |
| `docs/EVAL.md` | 改 | 新增**第七十五节**：为什么不动公式、三条落点、测试、两个实现坑、五项门禁、遗留 |
| `docs/STATUS.md` | 改 | 新增「2026-09-26：顺序 71 落进 main」一段 |
| `docs/FILE-LOG.md` | 改 | 本节；「几点注意」顺延为**六十四**（顺序 84/85 收尾后现为**六十五**，整批上线后现为**六十六**，顺序 88 后现为**六十七**，顺序 89 后现为**六十八**，顺序 90 后现为**六十九**，顺序 92 后现为**七十**，顺序 91 后现为**七十一**，顺序 78 后现为**七十二**） |

> **没 push、没部署。** 校准比例本身**仍是待验证**：本机没有真实 Key、也没有服务端 `usage` 可对照，
> 所以「低估多少」要等用户在真机上跑够 10 轮生成之后看那一行提示（或 `usageCalibration` 的返回值）。

## 六十四、2026-09-26：顺序 84 / 85 合入 main 与 lint 收尾（含代提交）

审计那 58 条的最后两批分支这一天才进得来——卡点不是代码，是**另一条会话的 24 项未提交改动**（`App.tsx`/`styles.css`/`components/*.tsx`）。
用户裁定「我代提交，解开 84/85」+「原图不进仓」之后，按 `3c2859f`（代提交）→ `0ad316d`（顺序 84）→ `554d5d2`（顺序 85）→ `655230c`（lint 收尾）四条落盘。做法、门禁与遗留见 EVAL 第七十六节。

| 文件 | 改 / 新增 | 说明 |
| --- | --- | --- |
| `.gitignore` | 改 | 新增 `art/source/`（48 张原图 ~114 MB 只留本机，用户裁定）；顺序 85 那侧还带来 `tmp-test-cards/`、`.claude/` 两段，冲突处**两边都留** |
| `apps/web/public/{favicon,icon-192,icon-512,icon-maskable-192,icon-maskable-512}.png` | 改 | 代提交：图标换新（二进制） |
| `apps/web/public/brand/icon-master.png`、`tools/art/prepare-assets.py` | **新增** | 代提交：图标母版与生成脚本（重跑它可再生成 icons / WebP / 缩略图） |
| `apps/web/public/portraits/**`（144 个 `.webp` + `thumbs` / `avatars`） | **新增** | 代提交：角色立绘与头像（21.7 MB）；`apps/web/src/lib/portraits.ts` 映射到稳定路径 `/portraits/<NN>.webp` |
| `apps/web/src/lib/{portraits.ts,portraits.test.ts,avatar-crop.ts,avatar-crop.test.ts,portrait-catalog.json}`、`apps/web/src/components/AvatarCropper.tsx` | **新增** | 代提交：立绘目录、裁切算法与裁切界面（用户上传图与裁切头像随卡存本地库） |
| `apps/web/src/components/{CardDesigner,CastDetail,CastRail,MainChat,MessageBody,MessageItem,StreamingBubble}.tsx`、`apps/web/src/App.tsx`、`apps/web/src/styles.css` | 改 | 代提交：立绘选择、角色展示与聊天界面调整 + 样式 |
| `art/README.md`、`art/review-faces.jpg`、`art/review-portraits.jpg` | **新增** | 代提交：立绘候选集说明（`19`/`21` 已删、编号留空）与两张总览图；原图目录不入仓 |
| `apps/web/public/sw.js` | 改（顺序 84） | 静态白名单加上 `/portraits/`、`/brand/`（否则装到桌面后立绘/头像离线破图） |
| `apps/web/src/lib/task-queue.ts` | 改（顺序 84） | `claim()` 改成 `updateEntity` 原子 CAS（原来 get→put 有 TOCTOU；不再绕开 core 的 `take()`） |
| `.github/workflows/ci.yml` | 改（顺序 85） | actions 固定到 SHA、加 `build:sync-server` 步骤、`contents: read` 权限 |
| `apps/web/package.json`、`apps/web/tsconfig.tools.json`、`package.json`、`pnpm-workspace.yaml`、`biome.json` | 改（顺序 85） | `typecheck` 多跑 `tsc -p tsconfig.tools.json`；engines `node: >=22.5`；删掉冷静期的 `minimumReleaseAgeExclude`；`linter.preset`；给 `**/*.css` 关掉 `noDescendingSpecificity` |
| `deploy/{Caddyfile.example,README.md,install-server.sh,nginx-8443.conf.example}`、`deploy/nginx-security-headers.conf` | 改 / **新增** | 顺序 85：部署配置与安全响应头 |
| `apps/web/src/lib/sync.ts` | 改（收尾） | 去掉合并残留的未用 import `parseSnapshot` |
| `apps/web/src/components/{AvatarCropper,CardDesigner}.tsx` | 改（收尾） | 两个带 `aria-label` 的 `div` 改 `<section>`（`div` 不支持 `aria-label`，`role="group"` 又会撞 `useSemanticElements`）；换卡清草稿的 `useEffect` 加 `biome-ignore` |
| `docs/TASKS.md` | 改 | 84 / 85 两行改 ✅；新增「当天那批脏改动怎么处理的」段；两条结构性缺口更新（lint 已全绿、`tools/*` 仍未补） |
| `docs/EVAL.md` | 改 | 新增**第七十六节**：四条 commit、代提交的两道检查、合并与 `.gitignore` 冲突解法、依赖插曲、lint 三处修法、五项门禁、六条遗留 |
| `docs/STATUS.md` | 改 | 新增「2026-09-26：顺序 84 / 85 合入 main」一段 |
| `docs/FILE-LOG.md` | 改 | 本节；「几点注意」顺延为**六十五**（整批上线后现为**六十六**，顺序 88 后现为**六十七**，顺序 89 后现为**六十八**，顺序 90 后现为**六十九**，顺序 92 后现为**七十**，顺序 91 后现为**七十一**，顺序 78 后现为**七十二**） |

> 四个提交当时**未 push、未部署**，已在 **2026-09-26 整批上线**（见下一节）。审计那 58 条至此全部在 main；但 `tools/*` 仍不在 `pnpm-workspace.yaml`、B10 未做、B11/B12 只接一半，
> 服务端那批（配额 / 限流 / `spaces.epoch`）已在下一节记录的部署中生效。

## 六十五、2026-09-26：整批上线（push + 服务端 / nginx / 网页重新部署）

这一节**没有新增或修改仓库文件**（部署件都来自上面的提交），只记录「什么时候把哪一份放到了线上」，以及
`docs/STATUS.md` / `docs/TASKS.md` / `docs/EVAL.md` 三份文档为它改了什么。服务器私有信息（域名 / 地址 / 凭据）仍只在 `deploy/LOCAL-NOTES.md`（gitignore，不入仓）。

| 对象 | 动作 | 内容 |
| --- | --- | --- |
| `origin/main` | push | `789f744..aa4f724`（顺序 81–86、顺序 71、代提交 `3c2859f`、审计报告 `71a26be` 一起上去） |
| `/opt/dramatis-sync/dist` | 换 | 新构建；旧目录留成 `dist.bak-20260926-183042` |
| `/opt/dramatis-sync/{backup.mjs,start.mjs,README.md,.env.example}` | 换 / 不动 | `backup.mjs` 换成带审计 C16 `keep >= 1` 校验的版本；`start.mjs` 与线上逐字节一致 |
| `/opt/dramatis-sync/deploy/` | 换 | 来自 `554d5d2`；`LOCAL-NOTES.md` 误拷上去后**已删除** |
| `/etc/systemd/system/dramatis-sync.service` | 换（加固） | `deploy/install-server.sh` 重写：`ProtectSystem=strict`、`ProtectHome=true`、`PrivateDevices=true`、`ProtectKernelTunables/Modules/ControlGroups`、`RestrictAddressFamilies=…`、`RestrictSUIDSGID`、`LockPersonality`、`UMask=0077` |
| `/var/lib/dramatis-sync/sync.db` | 自动迁移 | `spaces.epoch` 补 4 行；`heads.record_count`/`byte_count` 回填；行数不变（4 空间 / 641 记录） |
| `/etc/nginx/snippets/dramatis-security-headers.conf` | **新增** | 来自 `deploy/nginx-security-headers.conf`（审计 A15） |
| `/etc/nginx/sites-available/dramatis` | 改 | 三处：server 级与 `location = /sw.js` 各 include 安全头；`location /sync/` 加 `client_max_body_size 8m`；保留 `listen 8443 ssl http2;` |
| `/var/www/dramatis` | 换 | `assets/index-9bjwPXDa.js`、`assets/index-aDHWLtbR.css`、`/portraits/{,thumbs/,avatars/}`、`brand/icon-master.png`、新图标、`sw.js` 8852 B（`dramatis-shell-v2`）；旧目录留成 `dramatis.bak-20260926-183139` |
| `docs/STATUS.md` | 改 | 顶部新增「整批上线」一节，并把它下面各节的「未 push、未部署」改正 |
| `docs/TASKS.md` | 改 | 84 / 85 两行改 ✅；审计报告「尚未 push」改正；服务端那批「要重新部署才生效」改成已部署 |
| `docs/EVAL.md` | 改 | 新增**第七十七节**（push、服务端、nginx、网页、备份、三个坑、没验的五条）；第七十六节第 1/6 条改正 |
| `docs/FILE-LOG.md` | 改 | 本节；「几点注意」顺延为**六十六**（顺序 88 后现为**六十七**，顺序 89 后现为**六十八**，顺序 90 后现为**六十九**，顺序 92 后现为**七十**，顺序 91 后现为**七十一**，顺序 78 后现为**七十二**） |

## 六十六、2026-09-26：顺序 88（审计 B10 流式失败边角）

那一份改动来自 `.claude/worktrees/agent-a6adfa051fc0cc2bd` 里**未提交**的两份文件（`Copy-Item` 取回 main，不是 merge）；本批加了 4 条测试、改了 `DeltaPayload.error` 的类型与注释，并补了四处文档。

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `packages/core/src/provider/openai-compatible.ts` | 改 | `ProviderConfig.onWarning?`；`errorMessageOf()`（200 + `error` 体）；`assertComplete(reason, warn)`（只拦 `length`/`max_tokens`/`content_filter`/`insufficient_system_resource`/`aborted`，其余记警告）；`dataPayloadsOf()`（规范多行 `data:` 与单换行网关）；非流式回退改成读文本 + `JSON.parse`（非 JSON / 错误体 / 没有 `choices[0]` 都抛 `ProviderError`）；`iterateSse` 的 `finally` 先 `await reader.cancel()`；`DeltaPayload.error` 放开成 `unknown` |
| `packages/core/src/provider/openai-compatible.test.ts` | **新增** | 16 条：非流式错误体 5 条、流里夹错误体 2 条、未知 `finish_reason` 7 条（`it.each` 4 条 + `LENGTH`/`max_tokens`/非流式）、多行 `data:` 2 条、提前退出 `cancel` 1 条 |
| `docs/TASKS.md` | 改 | 计划表新增**顺序 88** 行；归属表 B10 改 ✅；顺序 86 的 B10 行改成「顺序 88 补上」；新增「顺序 88 怎么处理的」表与三条遗留 |
| `docs/STATUS.md` | 改 | 顶部新增顺序 88 一节（在「整批上线」之后）；84/85 那节的「仍未做」里去掉 B10 |
| `docs/EVAL.md` | 改 | 新增**第七十八节**（来源、5 个审计点的改法表、测试清单、五项门禁、六条遗留） |
| `docs/FILE-LOG.md` | 改 | 本节；「几点注意」顺延为**六十七** |

## 六十七、2026-09-26：顺序 89（初始好感 40% + 手动滑杆 + 各模式落到提示词 + 默认系统提示换成用户的系统预设）

用户当天的体验反馈第一批：角色一上场就敌对（好感要从 0 提到 40，且要能手动调）、「＋」里各种模式不生效、无限制模式的词不可更改也不可阅读。一处常量 `INITIAL_PLAYER_AFFINITY = 0.4` 贯穿新建实例 / 补关系边 / 迁移三条路径。

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `packages/core/src/model/instance.ts` | 改 | 新增 `INITIAL_PLAYER_AFFINITY = 0.4`（doc 写明三处共用与「以前是 0，一开口就敌对是体验问题」） |
| `packages/core/src/session/setup.ts` | 改 | `createInstanceFor` 里对玩家的关系边用 `INITIAL_PLAYER_AFFINITY`（其余四个维度仍是 0） |
| `packages/core/src/memory/affect.ts` | 改 | `ensureRelationship` 补边时只对 `PLAYER` 用 0.4；新增 `setRelationshipField()`（按维度夹紧、不受单轮上限约束、写「手动调整」记录、**值没变返回同一个对象**） |
| `packages/core/src/storage/repository.ts` | 改 | `SCHEMA_VERSION` 11 → **12**；迁移 v12 只提「从未动过」的对玩家好感（`affinity === 0 && history.length === 0`），盖 `updatedAt` + 追加可撤销记录 |
| `packages/core/src/model/card.ts` | 改 | `DEFAULT_CARD_SYSTEM_PROMPT` 整段换成用户的系统预设（仅格式段按引擎写法：动作行 `#` 开头、对白不加引号）；预设里那句具体题材要求判定为误贴、未收 |
| `packages/core/src/prompt/assemble.ts` | 改 | `describeModes` 补齐：无限制模式下先出「最高约束」并**不再输出** `playerFirst`/`silent`；`historyMode: recap-aware` 补一条场记指令；`replyLength`/`intentFirst` 故意不重复 |
| `apps/web/src/lib/session.ts` | 改 | 新增 `setRelationship(id, field, value)`（`saveInstance` + `setSnapshot`，跳过「值没变」的那次写库） |
| `apps/web/src/components/CastDetail.tsx` | 改 | 角色详情加一根 0–100% 好感滑杆（`useDraftField` 包着，拖动只改草稿、停手 300ms 落库一次）；**未改 `styles.css`**（避免与另一条会话抢文件） |
| `apps/web/src/App.tsx` | 改 | `CastDetail` 用法接上 `onSetRelationship` |
| `apps/web/src/components/MainChat.tsx` | 改 | 无限制模式删掉粘贴框、「保存提示词」按钮与本地草稿 state，**连字数也不显示**，只说明「已配置 / 尚未配置」；改正那句「提示词住在代码里的常量」的过时注释 |
| `packages/core/src/memory/affect.test.ts` | 改 | +7 条（补边 0.4 / 对别人仍是 0 / 手动调整记录与不受单轮上限 / 四维夹紧 / 值没变返回同一对象 / 好感不参与情绪褪色 / 手动调整可撤销） |
| `packages/core/src/session/setup.test.ts` | **新增** | 2 条（新实例对玩家 0.4、其它维度 0、history 为空；开新世界同一口径） |
| `packages/core/src/storage/repository.test.ts` | 改 | +4 条（v12 的三种情况 + 重复跑不越提越高）；钉死迁移清单的断言补成 `[10, 11, 12]` |
| `packages/core/src/model/card.test.ts` | 改 | +3 条（新预设保留点名的要求、格式段用引擎写法且不含「双引号」、禁止替玩家写对白） |
| `packages/core/src/prompt/assemble.test.ts` | 改 | +3 条（无限制模式下「最高约束」在而 `playerFirst`/`silent` 不在；场记指令随 `historyMode` 开关；新实例的好感真的进提示词 `好感 +0.40`） |
| `docs/TASKS.md` | 改 | 计划表新增**顺序 89 / 90 / 91** 三行（89 ✅）；新增「顺序 89 怎么处理的」表与四条遗留 |
| `docs/STATUS.md` | 改 | 顶部新增顺序 89 一节（在顺序 88 之后） |
| `docs/EVAL.md` | 改 | 新增**第七十九节**（来源与三条裁定、0.4 的三处口径与 v12 三条判断、手动调整、`describeModes`、系统预设、测试清单、五项门禁、六条遗留） |
| `docs/FILE-LOG.md` | 改 | 本节；「几点注意」顺延为**六十八**（1166 / 1223 / 1252 / 1276 四处的交叉引用补上「顺序 89 后现为**六十八**」，顺序 90 后现为**六十九**，顺序 92 后现为**七十**，顺序 91 后现为**七十一**，顺序 78 后现为**七十二**） |

## 六十八、2026-09-26：顺序 90（删掉卡上的场景设定 / 开场白 / 对话示例 / 高级字段，撤下「本场场记」，编辑区不再滑动）

用户当天体验反馈第二批，三条裁定：「彻底删除已有数据」「两个都要（自动长高 + 拖动隔离）」「本场场记整块不显示」。`Card` 一次少 7 个字段，靠迁移 v13 + 三条写入通道上的 `stripRemovedCardFields` 把老数据也清掉。

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `packages/core/src/model/card.ts` | 改 | `Card` 删 `scenario`/`firstMessage`/`alternateGreetings`/`exampleMessages`/`systemPrompt`/`postHistoryInstructions`/`creatorNotes`，删 `resolveCardSystemPrompt()`；新增 `REMOVED_CARD_FIELDS` 与 `stripRemovedCardFields(record)`（无该字段时返回 `null`） |
| `packages/core/src/storage/repository.ts` | 改 | `SCHEMA_VERSION` 12 → **13**；迁移 v13 剥卡上遗留字段（**不盖 `updatedAt`**、幂等）；`saveCard`/`putSyncRecord`/`listSyncRecords` 三处各剥一次 |
| `packages/core/src/render/segments.ts` | 改 | 删 `normalizeCardExample()`、`SPEAKER_LABEL`、`normalizeGreetingBreaks()` |
| `packages/core/src/session/turn.ts` | 改 | 删整段自动开场（`MAX_AUTOMATIC_GREETING_LENGTH`、`GREETING_FIELD_LABELS`、`normalizeGreetingLine`、`prepareAutomaticGreeting`、`createGreetingMessage`）与随之无用的 import |
| `packages/core/src/session/setup.ts` | 改 | 新世界的场景摘要改成空串 |
| `packages/core/src/prompt/assemble.ts` | 改 | 人物块不再拼对话示例；基本规则正文走 `options.systemPrompt ?? DEFAULT_CARD_SYSTEM_PROMPT` |
| `packages/core/src/compat/sillytavern/card.ts` | 改 | 映射删 7 字段、删 `missing-greeting` 警告；**`KNOWN_DATA_KEYS` 七个 key 保留**（删了会被扫进 `extensions` 复活） |
| `packages/core/src/admin/tools.ts` | 改 | `upsert_character_card` schema 删 5 个 property、`parseCardDraft` 不再解析、`KNOWN_ARGS` 只留六个 |
| `packages/core/src/admin/prompt.ts` | 改 | 删掉预览里的「开场白」一行 |
| `apps/web/src/lib/session.ts` | 改 | 删 `buildGreetings` 与两处调用；新对话场景摘要留空 |
| `apps/web/src/components/CardDesigner.tsx` | 改 | 删场景设定 / 开场白 / 备选开场白 / 对话示例 / 系统提示 / 后置指令与「展开高级字段」折叠块；作者 / 版本 / 标签 / 来源改为直接可见 |
| `apps/web/src/components/CastDetail.tsx` | 改 | 删「场景：」一行 |
| `apps/web/src/components/SideChat.tsx` | 改 | 草稿预览从「开场白」改成看「设定」（`description`） |
| `apps/web/src/components/ScenePanel.tsx` | 改 | 「本场场记」整块撤下（后台整理与提示词注入不变） |
| `apps/web/src/styles.css` | 改 | 全局 `textarea` 用 `field-sizing: content` + `overflow: hidden` + `overscroll-behavior: contain` + `touch-action: pan-y` + `resize: none`；聊天输入框退回 `field-sizing: fixed`；删 `.recap`/`.recap-text` |
| `apps/web/tools/world-seed-probe.ts` | 改 | `cardFor()` 不再收 `scenario`（它在 `tsconfig.tools.json` 的 typecheck 范围内） |
| `packages/core/src/model/card.test.ts` | 改 | +1 条（7 个字段都不在卡上，用 `key in card`） |
| `packages/core/src/compat/sillytavern/card.test.ts` | 改 | +1 条（带全部 7 键的卡解析后字段不在卡上、`extensions` 仍为 `{}`） |
| `packages/core/src/admin/tools.test.ts` | 改 | +1 条（5 个字段不再进 schema；再传会被点名为不认得的参数） |
| `packages/core/src/storage/repository.test.ts` | 改 | +5 条（v13 迁移剥字段且其余原样 / `saveCard` 剥 / `putSyncRecord` 剥 / `listSyncRecords` 剥 / 干净新卡不被无谓重写）；钉死迁移清单的断言补成 `[10, 11, 12, 13]` |
| 另 9 个 core 测试文件 | 改 | 夹具删掉被删字段的行：`session/turn.test.ts`（截到 157 行，删整个自动开场 `describe`）、`render/segments.test.ts`、`prompt/assemble.test.ts`、`prompt/worldbook-placement.test.ts`、`storage/conversation.test.ts`、`storage/artifact-conflict.test.ts`、`storage/artifact-revoke.test.ts`、`eval/baseline.test.ts`、`eval/extraction-prompt.test.ts`、`eval/prompt-samples.test.ts`、`admin/turn.test.ts` |
| `docs/ROLEPLAY-PROMPT.md` | 改 | 整篇重写：默认系统提示改成「只有代码一处来源」（`DEFAULT_CARD_SYSTEM_PROMPT`，正文不在文档里重复）、删掉「展开高级字段 → 系统提示」的改法、无限制模式改成「只有开关、无正文」；补一节说明顺序 90 删掉的那 7 个字段去哪了 |
| `docs/{ADMIN-CONSOLE,DESIGN,LAYOUT,ROADMAP}.md` | 改 | 只加「顺序 90 起……」的注释：管理员看不到卡内容这条边界照旧（开场白已无此字段）、Card 概念行去掉开场白、场记块不再显示 + 场景简介不再来自卡、草稿预览改看 `description`、`scene.summary` 来源改写 |
| `docs/TASKS.md` | 改 | 计划表第 90 行改 ✅；新增「顺序 90 怎么处理的」表与五条遗留 |
| `docs/STATUS.md` | 改 | 顶部新增顺序 90 一节（在顺序 89 之前） |
| `docs/EVAL.md` | 改 | 新增**第八十节**（来源与三条裁定、删了什么、迁移 v13 与三条复活通路、两个都要的落法、测试清单、五项门禁、七条遗留） |
| `docs/FILE-LOG.md` | 改 | 本节；「几点注意」顺延为**六十九**（1166 / 1223 / 1252 / 1276 四处的交叉引用补上「顺序 90 后现为**六十九**」，顺序 92 后现为**七十**，顺序 91 后现为**七十一**，顺序 78 后现为**七十二**） |

## 六十九、2026-09-26：顺序 92（无限制模式的正文改成「仓库里固定一份」）

用户改口径：无限制模式的正文是所有对话共用的一份固定词，要放进仓库并告知粘在哪里；四个选项中用户选「仓库里指定一个文件给你粘（最省事，但会泄露）」，即接受正文进公开产物。新建粘贴位，两个入口都取同一个常量，删掉只服务旧本机键的 hook 与 `META_KEYS.unlimitedPrompt`。

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `apps/web/src/prompt/unlimited-preset.txt` | **新增** | 粘贴位：**整份文件的内容就是正文**（不加注释/标题行）；落进 main 时是**空文件**，**2026-09-27 用户已粘上（9059 B / 102 行，`trim()` 后 3325 字符，提交 `14d1b96`）** |
| `apps/web/src/prompt/unlimitedPreset.ts` | **新增** | `import raw from './unlimited-preset.txt?raw';` + `export const UNLIMITED_PROMPT = raw.trim();`，doc 记「往哪儿粘」「为什么和顺序 89 的说法反了」「它怎么进提示词」 |
| `apps/web/src/App.tsx` | 改 | `useUnlimitedPrompt(db)` → `UNLIMITED_PROMPT`；import 换成 `./prompt/unlimitedPreset`；doc 注释重写成「仓库固定一份、会进公开网页包」 |
| `apps/web/src/components/MainChat.tsx` | 改 | prop 类型 `UnlimitedPromptApi` → `string`；`unlimitedReady` 用 `unlimitedPrompt.trim()`；「＋」菜单的注释与文案改成「仓库里固定一份／已随应用一起固定提供（正文不在此显示）」 |
| `apps/web/src/hooks/useTurnRunner.ts` | 改 | `getMeta(META_KEYS.unlimitedPrompt)` → `UNLIMITED_PROMPT`；删掉只为它存在的 `repository` 变量、`META_KEYS` import 与依赖数组项 |
| `apps/web/src/lib/useUnlimitedPrompt.ts` | **删** | 整个文件（含 `UnlimitedPromptApi`）——旧本机键的读写通路 |
| `packages/core/src/storage/repository.ts` | 改 | `META_KEYS` 删掉 `unlimitedPrompt: 'modes.unlimitedPrompt'`（残留值从本批起不读不写，不做清理） |
| `packages/core/src/prompt/unlimited.ts` | 改 | 顶部来龙去脉整块换新（正文现在在 `apps/web/src/prompt/unlimited-preset.txt`；旧键不再读写） |
| `packages/core/src/prompt/assemble.ts` | 改 | `AssembleInput.unlimitedPrompt` 的 doc、`buildUnlimitedModeBlock` 与装配处的注释改成新口径（契约不变：core 只认参数） |
| `packages/core/src/prompt/assemble.test.ts` | 改 | 那组说明注释改成「core 只认 `AssembleInput.unlimitedPrompt`，来源换过两次」 |
| `docs/ROLEPLAY-PROMPT.md` | 改 | 无限制模式一节整节重写（原文说「只存在你自己的浏览器里」，与本批相反）；「改这段文字」改成改仓库文件后重新构建 |
| `docs/TASKS.md` | 改 | 计划表第 92 行 ✅；新增处理表与五条遗留；顺序 89 第一条遗留标注「顺序 92 已解」 |
| `docs/STATUS.md` | 改 | 新增顺序 92 一节（在顺序 90 之前）；文档地图里 `ROLEPLAY-PROMPT.md` 那行补上「与无限制模式固定正文」 |
| `docs/EVAL.md` | 改 | 新增**第八十一节**（来源原话、先查再改的结论、四个选项与选择、正文位、两个入口、撤掉的旧通路、界面、测试与门禁含第一轮 lint 红、六条遗留） |
| `docs/FILE-LOG.md` | 改 | 本节；「几点注意」顺延为**七十**（1166 / 1223 / 1252 / 1276 / 1315 五处的交叉引用补上「顺序 92 后现为**七十**，顺序 91 后现为**七十一**，顺序 78 后现为**七十二**」） |

**2026-09-27 补（同一个顺序号 92，单独一个提交 `14d1b96`）**：用户把固定正文粘进粘贴位（9059 B / 102 行，`trim()` 后 3325 字符），随后只重新部署了**前端**。

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `apps/web/src/prompt/unlimited-preset.txt` | 改 | 填入正文；`git ls-files --eol` = `i/lf w/crlf`（`.gitattributes` 是 `* text=auto eol=lf`，与仓库其它文本文件一致） |
| `docs/ROLEPLAY-PROMPT.md` | 改 | 「留空等于没有」那条改成「2026-09-27 起已经不是空的」 |
| `docs/TASKS.md` | 改 | 计划表 92 行补「2026-09-27 补」；处理表的正文位、遗留两条、真机那条同步成「已粘贴 / 前端已上线 / push 当时未成」 |
| `docs/STATUS.md` | 改 | 新增「2026-09-27：顺序 92 补——正文粘贴完成、前端单独上线（push 当时未成）」一节；顺序 92 那节里的「空文件」与「本批未 push、未部署」一并改口 |
| `docs/EVAL.md` | 改 | 第八十一节末尾追加「2026-09-27 补：正文粘贴完成 + 前端单独上线（push 当时未成）」，并把遗留第 1/2/6 条改口 |
| `docs/FILE-LOG.md` | 改 | 本节这段与上面那一行 |
| （仓库外）`deploy/LOCAL-NOTES.md` | 改 | 记了这次上线的备份目录与命令（本机私有、不提交） |

**2026-09-27 补二（同一个顺序号 92，单独一个提交）**：把这批里所有「push 未成」的说法改成「push 完成」——`git push origin main` 前三次分别撞上「Clash Verge GUI 没开 / 绕代理直连被重置 / 代理开了仍被重置」，最后 `git -c http.version=HTTP/1.1 -c http.postBuffer=524288000 push origin main` 成功（`a1dc78a..1cf1eab`，`origin/main` = `1cf1eab`），并把 `http.version=HTTP/1.1` 写进本仓库本地配置。本次重跑五项门禁全绿、构建产物哈希可复现（仍是 `index-BBkcTtuN.js`），**没有重新部署**。

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `docs/STATUS.md` | 改 | 上一节标题改成「…前端单独上线、**push 完成**（`a1dc78a..1cf1eab`）」；原「push 卡住」一条重写成「push 完成」全过程（三次失败 + 成功命令 + 本地配置） |
| `docs/EVAL.md` | 改 | 第八十一节「补」一节标题与 push 一条改成「当时未成（已解）」，并新增「补二：push 完成 + 文档改口」一小节 |
| `docs/TASKS.md` | 改 | 计划表 92 行的尾巴与处理表「真机没验」一条改成「push 已完成」 |
| `docs/FILE-LOG.md` | 改 | 本节这段；上面那段里的三处「push 未成」改成「push 当时未成」 |
| （仓库外）`deploy/LOCAL-NOTES.md` | 改 | 追加 push 成功的命令与 `http.version=HTTP/1.1` 这条经验（本机私有、不提交） |

这次改口的提交本身也一并 `git push`（`1cf1eab..4769268`），所以文档里不再写死「`origin/main` = 某个 hash」，一律写「**以远端为准**」；真机 / 真实模型验证仍归 Codex。

## 顺序 93、2026-09-27：界面视觉系统与 SVG 图标（进行中）

本批在隔离分支 `codex/ui-visual-refresh` 上进行，尚未 push 或部署。方案、计划与阶段验收分别见 `UI-VISUAL-OPTIMIZATION-PROPOSAL-2026-09-27.md`、`superpowers/plans/2026-09-27-ui-visual-refresh.md` 和 EVAL 第八十二节。

| 文件 | 动作 | 本阶段内容 |
| --- | --- | --- |
| `docs/UI-VISUAL-OPTIMIZATION-PROPOSAL-2026-09-27.md` | 新增 | 用户批准的叙事剧场视觉方案，后补 SVG 图标与微动效范围 |
| `docs/superpowers/plans/2026-09-27-ui-visual-refresh.md` | 新增 | 分批实施、浏览器视觉验收、五项门禁与四份文档随代码更新的清单 |
| `apps/web/src/styles.css` | 改 | 三主题语义令牌、字级与焦点环；后续分区调整继续记在本节 |
| `apps/web/src/lib/appearance.ts` | 改 | 三张主题卡的色板与文案对齐新配色 |
| `apps/web/src/components/Icons.tsx` | 改 | 在原有 5 个 SVG 上增加关闭、层级方向、设置、归档、编辑图标 |
| `packages/core/src/prompt/budget-equivalence.test.ts` | 改 | 现有 3000 条历史等价性用例稳定运行超过默认 5 秒；诊断确认断言通过后仅将该用例等待上限设为 15 秒，详见 EVAL 第八十二节 |
| `docs/TASKS.md` | 改 | 总表增加顺序 93，记录阶段状态 |
| `docs/STATUS.md` | 改 | 顶部记录本次隔离开发的接续点 |
| `docs/EVAL.md` | 改 | 新增第八十二节，逐批写实测与未验证项 |
| `docs/FILE-LOG.md` | 改 | 本节 |

第二批（输入区加号与菜单）：`apps/web/src/components/MainChat.tsx` 增加按钮与菜单关联、Esc 关闭后的焦点返回；`apps/web/src/styles.css` 增加加号旋转、打开态和菜单入场反馈及减少动效覆盖；四份项目记录同步追加浏览器样例、验证边界和阶段状态。`docs/UI-VISUAL-OPTIMIZATION-PROPOSAL-2026-09-27.md` 清理日期行末空格。

第三批审批样例：新增 `docs/visual-samples/main-chat-prototype.html`，展示桌面与手机主对话、空状态、亮背景和输入焦点；更新 `docs/UI-VISUAL-OPTIMIZATION-PROPOSAL-2026-09-27.md` 的已批准状态，以及 `docs/TASKS.md`、`docs/STATUS.md`、`docs/EVAL.md` 和本日志的样例审阅接续点。产品主阅读组件尚未批量修改。

样例获批后的产品落地：`apps/web/src/styles.css` 新增三主题阅读表面、消息/空状态/背景遮罩和图标布局，浅色与深色蓝色强调值不变；`apps/web/src/components/MainChat.tsx` 把主对话空态改成审阅通过的舞台引导；`apps/web/src/components/MessageItem.tsx` 给玩家消息加头像；`apps/web/src/components/Icons.tsx` 扩充外观、账户、数据、记忆、用量和文档 SVG；`apps/web/src/components/TopBar.tsx`、`WorldTree.tsx`、`SettingsDialog.tsx`、`RuntimePanel.tsx` 接入共用图标并保留文字/可访问名称。方案文档、TASKS、STATUS、EVAL 和本日志同步记录用户批准与浏览器验收边界。产品改动提交为 `84690e8`；审阅后 `apps/web/src/styles.css` 又在 `8cf9419` 将深色主按钮字改深，修正对比度。两次代码提交均已推送 `origin/main` 并仅部署网页静态产物；最终部署验收见 EVAL 第八十二节。

## 顺序 94、2026-09-27：用户定稿应用图标

| 文件 | 动作 | 本批内容 |
| --- | --- | --- |
| `apps/web/public/brand/icon-master.png` | 改 | 用户提供的 1254 × 1254 PNG 原样成为图标母版 |
| `apps/web/public/{icon-192,icon-512,icon-maskable-192,icon-maskable-512,favicon}.png` | 改 | 由母版生成的四个安装图标及浏览器图标 |
| `tools/art/prepare-assets.py` | 改 | 支持只生成图标；maskable 使用白色留白和圆角裁切 |
| `apps/web/public/sw.js`、`apps/web/src/pwa/sw-policy.test.ts` | 改 | 缓存版本升至 v3 并测试，刷新同路径图标 |
| `docs/APP-ICON-SELECTED-2026-09-27.md` | 新增 | 用户定稿、母版哈希、衍生规格与验收边界 |
| `docs/{TASKS,STATUS,EVAL,FILE-LOG}.md` | 改 | 顺序 94 的任务、状态、验证和文件记录 |

代码及首轮文档提交为 `8e6551d`，已推送 `origin/main`；本段追加部署验收记录。仅替换线上网页静态目录，旧目录留为 `/var/www/dramatis.bak-icon-8e6551d`。

## 顺序 95、2026-09-27：手机桌面图标近景修正

| 文件 | 动作 | 本批内容 |
| --- | --- | --- |
| `tools/art/prepare-assets.py` | 改 | 母版近景裁切坐标、Android 留白与新安装入口图标生成 |
| `apps/web/public/{icon-192,icon-512,icon-maskable-192,icon-maskable-512,favicon}.png` | 改 | 近景图标替换上一版全画布缩放产物 |
| `apps/web/public/{icon-home-192,icon-home-512,icon-home-maskable-192,icon-home-maskable-512,apple-touch-icon}.png` | 新增 | 新 URL 的 Android 和 iPhone 安装图标 |
| `apps/web/public/manifest.webmanifest`、`apps/web/index.html` | 改 | Android/iPhone 桌面安装改用新图标 URL |
| `apps/web/public/sw.js`、`apps/web/src/pwa/sw-policy.test.ts` | 改 | 缓存版本 v4、新图标静态白名单与断言 |
| `docs/APP-ICON-SELECTED-2026-09-27.md`、`docs/{TASKS,STATUS,EVAL,FILE-LOG}.md` | 改 | 记录用户真机反馈、近景取舍及验收 |

修复提交 `8e16b90` 已推送 `origin/main` 并仅部署网页；本段补充上线后的验收结果。旧网页留在 `/var/www/dramatis.bak-icon-focus-8e16b90`。

## 顺序 91、2026-09-27：两个体验反馈 bug（逐笔落库与流式交接）

本批只动了网页应用，未改 core、未改同步服务端；本地提交，**未 push、未部署**。

| 文件 | 动作 | 本批内容 |
| --- | --- | --- |
| `apps/web/src/components/SceneDialog.tsx` | 改 | 「场景设定」改用 `useDraftField`（停手 300ms 或失焦才落库、输入法组合期不写库）；关闭弹窗的每条通路先 `flush()` |
| `apps/web/src/lib/stream-store.ts` | 改 | `StreamState` 新增 `handoffId`；新增 `handoffStreamState(scope, messageId)`（只写标记、phase 转 idle、正文与推理保留） |
| `apps/web/src/components/StreamingBubble.tsx` | 改 | 新增 `lastMessageId` prop：消息列表里出现交接的那条 id 时立刻收掉自己并清 store（在同一次 React 提交里完成，不空窗也不重影） |
| `apps/web/src/components/MainChat.tsx` | 改 | 渲染 `StreamingBubble` 时传 `lastMessageId`；消息列表外面包 `BusyContext.Provider` |
| `apps/web/src/components/MessageItem.tsx` | 改 | `busy` 不再逐条走 prop：抽出 `RowActions`（订阅 `useBusy()`）与 `BusyButton`；`MessageList` 去掉 `busy`，翻转时不再重画整表 |
| `apps/web/src/hooks/useTurnRunner.ts` | 改 | 落盘后的 `resetStreamState` 换成 `handoffStreamState('main', line.id)`；三处开流补 `handoffId: null` |
| `apps/web/src/lib/busy-context.ts` | 新增 | `BusyContext`（默认 `false`）与 `useBusy()`；应用里第一个 context |
| `apps/web/src/lib/stream-store.test.ts` | 改 | 新增「交接」用例；两条老用例的 `toEqual` 补 `handoffId: null` |
| `docs/{TASKS,STATUS,EVAL,FILE-LOG}.md` | 改 | 顺序 91 的计划行、处理表与遗留、状态接续点、EVAL 第八十五节与本节 |

推送与上线（2026-09-28 补）：`cff5149` 已快进推送到 `origin/main`（`f3be8c4..cff5149`）；`tools/` 与 `packages/core/src/sync/` 无改动 ⇒ 只上传并切换 `apps/web/dist`，旧网页留为 `/var/www/dramatis.bak-20260928-202632`。线上首页 200 / 1366 B 且引用新的 `assets/index-C5Ydp3Hw.js`（200 / 659406 B），`/sync/health` 200，同步服务未重启。真机与真实模型验证仍归 Codex。

## 顺序 78、2026-09-30：一轮内多个角色作答（多名角色接话）

顺序 78 的代码在分支 `codex/task-78-multi-speaker`（6 个提交：`f47a8fc` 纯函数多人发言选择器 → `1249a6c` 导演契约与人数上限 → `2f8c489` 自动生成接线 → `7512517` 逐条流交接 → `cdb798a` 逐人桥接与单轮用量 → `28282f4` 桥接恢复与逐人动作约束）上完成，2026-09-30 以 `--ff-only` 快进合入本分支（`637672f..28282f4`，27 文件 2396+/159-）。下表按合并进来的内容记文件，四份项目记录随后补齐。

| 文件 | 动作 | 本批内容 |
| --- | --- | --- |
| `packages/core/src/director/turn-speakers.ts` | **新增** | `directAddressees`（句首称呼与 `@显示名` 的窄规则）与 `selectTurnSpeakers`（直接称呼 → 导演有效计划 → 规则保底；`ready` / `no-eligible-speaker` / `too-many-addressed`） |
| `packages/core/src/director/turn-speakers.test.ts` | **新增** | 强制称呼、超上限拒绝、cut_in 排序、去重、三人上限、单人负分兜底、静默只做动作 |
| `packages/core/src/model/conversation.ts` | 改 | `DEFAULT_MAX_SPEAKERS = 2`、`HARD_MAX_SPEAKERS = 3`、`speakerLimitOf()`；`ConversationModes.maxSpeakers?: 1 \| 2 \| 3`；`defaultConversationModes()` 写 2 |
| `packages/core/src/model/conversation.test.ts` | 改 | 缺字段与脏值都退回 2，显式 1 / 3 保留 |
| `packages/core/src/director/intent-plan.ts` | 改 | 多人导演提示词（人数上限、上一条意图、动作条件、严格 JSON）、`IntentPlanEntry.key`、`pickPlannedSpeakers` |
| `packages/core/src/director/intent-plan.test.ts` | 改 | 两人计划都保留；重复 key、key/name 错配、场外与 offscreen 过滤；hold_back 合法；旧 name 单字段兼容 |
| `packages/core/src/prompt/assemble.ts` | 改 | 生成指令块新增「你是第 X 位、共 N 位」「不复述前人已答内容」「不替其他角色说话/决定动作/写内心」 |
| `packages/core/src/prompt/assemble.test.ts` | 改 | 后续位只见本轮公开消息与自身视角召回；反重复指令不可丢弃 |
| `packages/core/src/index.ts` | 改 | 导出 `turn-speakers` |
| `apps/web/src/hooks/useTurnRunner.ts` | 改 | `handleSend` 预检（场景／合格名单／角色卡／直接称呼超限）→ `selectTurnSpeakers` → 逐人 `recallFor` + 生成 + 记账 + 落盘（同一 `turnId`）+ `waitForStreamHandoff`；首位失败落动作保底并释放忙态 |
| `apps/web/src/hooks/useTurnRunner.test.tsx` | **新增** | 导演两人只调用一次；两次生成各自记账、同轮顺序落盘；保底与停止；网页桥接逐位装配 |
| `apps/web/src/lib/stream-store.ts` | 改 | `waitForStreamHandoff` / `acknowledgeStreamHandoff`（按 messageId 的交接屏障，默认 2000ms 超时） |
| `apps/web/src/components/StreamingBubble.tsx` | 改 | 改为确认同一 ID 进入已提交列表后才收掉自己并放行下一位 |
| `apps/web/src/components/StreamingBubble.test.tsx` | **新增** | 交接收流；延迟确认不能清掉下一位的流 |
| `apps/web/src/components/MainChat.tsx` | 改 | 「＋／对话模式」面板新增「本轮最多回应人数」三档（1 人／2 人（默认）／3 人） |
| `apps/web/src/lib/bridge-store.ts` | **新增** | `PendingBridgeTurn` 与 `WebBridgeState.pendingTurn`（逐人贴回、刷新恢复） |
| `apps/web/src/lib/bridge-store.test.ts` | **新增** | 逐位推进；旧单人桥接状态仍可继续 |
| `apps/web/src/components/WebBridgePanel.tsx` | 改 | 显示「第 X／N 位」、逐份贴回与跳过 |
| `apps/web/src/App.tsx` | 改 | 桥接按 `pendingTurn.nextIndex` 处理首份批量落盘与后续装配 |
| `apps/web/src/lib/usage.ts` | 改 | `latestTurn`（按 `turnId` 从现有流水汇总） |
| `apps/web/src/components/UsagePanel.tsx` | 改 | 新增「最近一轮」明细 |
| `apps/web/src/components/UsagePanel.test.tsx` | **新增** | 「最近一轮」渲染 |
| `apps/web/src/components/RuntimePanel.tsx` | 改 | 透传 `usage.latestTurn` |
| `docs/TASK-78-MULTI-SPEAKER-DESIGN.md` | **新增** | 设计基线（353 行；2026-09-28 随分支落盘，2026-09-30 随合并进主干） |
| `docs/superpowers/plans/2026-09-28-task-78-multi-speaker.md` | **新增** | 五步实施计划 |
| `docs/{TASKS,STATUS,EVAL,FILE-LOG}.md` | 改 | 顺序 78 的计划行、处理表与遗留、状态接续点、EVAL 第八十六节与本节 |

合并后主干工作区跑完五项门禁（数字见 EVAL 第八十六节）。随后 `4ee7edd` 推到 `origin/main`（`637672f..4ee7edd`），因同步服务端源码没变（`git log 637672f..4ee7edd -- tools/ packages/core/src/sync/` 为空）只换网页：Windows 正式机的 `D:\Dramatis\web\dist` 换成 `assets/index-aDLBA72A.js`（676240 B，与本地构建逐字节相同），旧目录留成 `dist.bak-20260930-005711`；线上首页 200 且引用新资源，`/sync/health` 200。

## 顺序 77、2026-09-30：重抽与改归属的一批写入事务化（IndexedDB 真事务、内存后端快照回滚）

来源是 2026-09-26 深度审计的存储原子性条目，2026-09-30 在顺序 97 之后同一天做掉。动手前先只读勘查：全库只有一张 object store（`keyPath: ['collection','id']`），逻辑集合靠 `collection` 字段区分；重抽与「改归属」各碰 4 个集合，而 `EntityStore` 只有单条 CAS、没有任何跨记录原语，且同步没有 outbox（靠 `updatedAt > 水位线` 推）⇒ 事务必须覆盖 `updatedAt` 盖章，同步侧不用一起改。改法是把 `EntityStore` 的事务扩成**可选**原语，IndexedDB 侧接上真 `readwrite` 事务、内存后端用快照回滚，再把重抽／改归属那批写入收进一个事务。

| 文件 | 动作 | 本批内容 |
| --- | --- | --- |
| `packages/core/src/platform/entity-store.ts` | 改 | `EntityStore` 新增可选 `transaction?<T>(run: (scope: EntityStore) => Promise<T>)`；新导出 `withStoreTransaction(store, run)`（没实现就 `return run(store)`） |
| `apps/web/src/lib/db.ts` | 改 | `createIndexedDbEntityStore` 拆成「库连接来源」+ `createStoreFromSource(source, runTransaction?)`；事务版 `db.transaction(STORE,'readwrite')`、作用域内读写走 `tx.store`、成功 `await tx.done`、出错 `tx.abort()`；`DramatisDb` 暴露 `store` |
| `packages/core/src/platform/memory-store.ts` | 改 | `transaction` = 快照所有集合 Map → run → 出错清空后按快照恢复再重抛（注释：不隔离并发事务） |
| `apps/web/src/lib/turn-write.ts` | **新增** | `rewriteTurnWrites`（一个事务里「改写消息 → 清任务键 → 软删该轮记忆 + `undoConsolidation` → 逐条还原情绪」，消息不在库里就什么都不撤）与 `revertTurnWrites` |
| `apps/web/src/lib/session.ts` | 改 | 新增 `rewriteTurn`（返回 `Message \| null`）；`revertTurn` 改走 `revertTurnWrites`；两者成功后 `setSnapshot` 对齐 messages / memories / instances |
| `apps/web/src/hooks/useTurnRunner.ts` | 改 | `handleRegenerate` 落盘换成 `session.rewriteTurn`、删掉三步 try/catch 汇总；`handleReassignMessage` 原先**无 catch** 的三步写入换成同一个调用；只有「重新排这一轮的分析」留在事务外并单独报 |
| `packages/core/src/platform/memory-store.test.ts` | **新增** | 内存后端 `update` / `transaction` 与回滚（7 条） |
| `apps/web/src/lib/turn-write.test.ts` | **新增** | 6 条：成功路径、中途失败整批回滚（含 `remove` 被撤销）、无 `transaction` 的后端退化成顺序执行、消息不存在时不动任何东西、`revertTurnWrites` 单跑、`withStoreTransaction` 抛错整批不落 |
| `apps/web/src/hooks/useTurnRunner.test.tsx` | 改 | 夹具补 `session.rewriteTurn` 桩与 `analysisFails` / `rewriteReturnsNull` 开关；原「后台回滚失败」一条拆成「事务失败按整次失败报」与「重排分析失败只发警告」两条 |
| `docs/{TASKS,STATUS,EVAL,FILE-LOG}.md` | 改 | 顺序 77 计划行改成已完成并写清做法、状态接续点、EVAL 第八十九节与本节；顺序 96/97 相关小节里「真事务仍然没有」的说法一并改成「顺序 77 当天收口」 |

五项门禁：`pnpm typecheck` 0；`pnpm lint` `Checked 293 files` 0 error / 0 warning；`pnpm test` Core 73 文件 / 833 条 + Web 18 文件 / 82 条全过；`pnpm build` 0（`dist/assets/index-CuPsB7O6.js` 680.10 kB / gzip 218.26 kB）；`pnpm build:sync-server` 0。本批**已随 2026-09-30 整批 push、网页已换版**（STATUS 顶部「整批上线」一节）；IndexedDB 真事务在 Node 里没有测试基建（无 `indexedDB`、无 `fake-indexeddb`），浏览器里的原子性与并发归 Codex 真机验，边界见 EVAL 第八十九节。

## 顺序 97、2026-09-30：重抽只重生成被点的那一位（同轮其他人原样保留）

用户 2026-09-30 拍板的语义。改之前重抽是「删掉这一轮**全部**角色回复、再另起一条新消息，然后整轮重排」——顺序 78 之后一轮可以有两三条角色回复，点最后一条会把前面那位刚说的话一起抹掉；新回复还会换 id、换位置，而且那五步写入零事务，任何一步失败都报成「重抽失败」（其实前三步之后回复已经换新）。本批把落盘改成**原地改写**，并把后台回滚的失败与回复本身的失败分开报。

| 文件 | 动作 | 本批内容 |
| --- | --- | --- |
| `apps/web/src/hooks/useTurnRunner.ts` | 改 | `handleRegenerate`（`:977`）：① 落盘改成 `session.updateMessage(target.id, { content, usage, intent, intentSource })`（`:1095`）——id／位置／`createdAt` 不变、只推 `updatedAt` 供同步，同轮其他人的回复不再被删；② 历史与发送路径对齐：`historyForTurn` = 这一轮之前的历史 + 同轮排在他前面的消息（`:1014-1019`），同轮已有人说过话时 `playerInput: ''`、`mentionText` 仍是玩家那句（`:1050`）；③ `clearTurn` → `revertTurn` → 重新 `enqueueTurnAnalysis` 逐步 try/catch 收账，失败只报警告 `regenerate.rollback`（`:1142`，「新回复已经换好了，但这一轮的后台记录没收拾干净…再点一次重抽」），`setError` 保持为空；④ intent 按新内容重算（旧的清掉）；⑤ 新增模块级小助手 `errorText` |
| `apps/web/src/hooks/useTurnRunner.test.tsx` | 改 | 新增 `describe('重抽只重生成被点的那一位（顺序 97）')`（`:480`，3 条）＋ `line()` / `twoSpeakerTurn()` 夹具；`harness` 补 `session.updateMessage` / `deleteMessage` / `revertTurn` 与 `db.queue.clearTurn` 的桩，并记录 `updates` / `deletes` / `reverted` / `analyses` |
| `apps/web/src/components/MainChat.tsx` | 改 | `lastCharacterId` 上方注释（`:486-490`）改成准确理由：更早的回复换掉后后面那些是照着旧版本说的；写明顺序 97 只保证**同一轮**里其他人的回复不再被连带删掉，入口限制不变 |
| `docs/{TASKS,STATUS,EVAL,FILE-LOG}.md` | 改 | 顺序 97 计划行改成已完成并写清做法、状态接续点、EVAL 第八十八节与本节 |

测试先单跑：`useTurnRunner.test.tsx` 13 条全过（原 10 + 新增 3）。本批**已随 2026-09-30 整批 push、网页已换版**（STATUS 顶部「整批上线」一节）；五项门禁数字与「真模型、真机都没验」的边界见 EVAL 第八十八节。（**顺序 77 同一天收口**：上面那张表里的 `session.updateMessage` 与「逐步 try/catch 收账」已经换成 `session.rewriteTurn` 的**一个事务**，见上一节。）

## 顺序 96、2026-09-30：人设表达收敛与结尾反问降级（提示词层最小干预）

用户 2026-09-30 的体验反馈（角色执着于人设、每轮都彰显自己；越聊越执着）先当假设查清再动手：只读审查 `packages/core/src/prompt/` 与 `packages/core/src/memory/`，加一份对 178 轮实录的离线复算（纯文本分析、零模型调用，脚本在 `%TEMP%` 下、**不入仓库**）。结论是「人设确实每轮在场、且是唯一没有长度上限的块，但缺的是『什么时候不该提人设』这一维约束」与「记忆里存人设这条链路不成立、但记忆回路自激」。改动只碰提示词文字三处，人设本身的长度与优先级一律没动。

| 文件 | 动作 | 本批内容 |
| --- | --- | --- |
| `packages/core/src/prompt/reply-style.ts` | 改 | 新增导出常量 `PERSONA_RESTRAINT_RULE`（人设要挑场合／同一个设定点不要连着几轮反复说／不要为了表现人设把话头从眼前的事上拽回自己），带完整来历注释（用户反馈 + 取证 + 「缺的是这一维约束、不是字数」） |
| `packages/core/src/prompt/assemble.ts` | 改 | `:27` 引入新常量；`reply-style` 块内容变成 `[NO_REPEAT_RULE, PERSONA_RESTRAINT_RULE, REPLY_LENGTH_RULES[...]]`，label 改「回答长度、反重复与人设收敛」；**不可丢弃**的指令块紧跟「保持角色不跳出。」加一句同向兜底（`droppable: false`，预算榨干时仍有一句约束在场） |
| `packages/core/src/prompt/assemble.test.ts` | 改 | 新增「顺序 96：人设表达收敛在这一块里，指令块还有一句不可丢弃的兜底」 |
| `packages/core/src/model/card.ts` | 改 | `DEFAULT_CARD_SYSTEM_PROMPT` 交互逻辑段那句「尽最大努力让回应结束在向玩家征求意见的疑问句上」降级成「需要玩家表态或做决定时……没什么可问的就自然收住」（178 轮里逼问口吻 53/178 条的出处）；卡常量注释补一段顺序 96 |
| `packages/core/src/model/card.test.ts` | 改 | 新增「顺序 96：结尾反问降级」（含 `not.toContain('尽最大努力')`，保留顺序 89 的 `toContain('疑问句')` 不动） |
| `docs/{TASKS,STATUS,EVAL,FILE-LOG}.md` | 改 | 顺序 96 的计划行与处理表（另一并登记顺序 97 = 重抽只重生成被点的那一位）、状态接续点、EVAL 第八十七节与本节 |
| `docs/ROLEPLAY-PROMPT.md` | 改 | 结尾反问那条改成「需要玩家表态时才用问句」，并写明「人设表达收敛」那几条不在卡预设里、在 `reply-style` 块里 |

本批**已随 2026-09-30 整批 push、网页已换版**（STATUS 顶部「整批上线」一节）；五项门禁数字与「真模型没验」的边界见 EVAL 第八十七节。

## 顺序 79、2026-09-30：跨角色串线检测（只提示不改数据；只做长片段那半）

178 轮真实长跑里，46/178 条非掌柜角色用起了掌柜的道具，秦娘还整段复用了陈九的专属身世（「我八岁那年雷砸了船，船板掀起来，攥缆绳攥出来的」）。用户 2026-09-25 先决定暂缓——当时的理由是「靠道具词判断不可靠」（T18 第一版 21 条警告大多误报）。2026-09-30 用户要求「所有任务清单确定、之前误解的任务都确认掉，再推进顺序 79」，于是换一个**不猜**的口径重新评估：**谁的东西，以他自己的角色卡为准**。同一批还按用户要求把 `docs/TASKS.md` 总表逐行与代码现状对齐（改了 67e／68b／69／70／72／73／74／75／76／78／80／87 十二行的描述，并新登记顺序 98）。

| 文件 | 动作 | 本批内容 |
| --- | --- | --- |
| `packages/core/src/render/bleed.ts` | 新增 | 纯规则模块（198 行）。判据只有一条：他这句话里有「**另一个角色卡里写过、他自己卡里没写过、场上别人卡里也没有**」的片段（≥4 字，且片段里不含任何人的名字）。导出 `MIN_SIGNATURE_LENGTH = 4`、`extractSignatureSpans`（强标点整句 + 逗号分句两个粒度，剥行首 `#` 等标记，只有数字符号的片段丢掉）、`buildSignatures`（丢弃含任何在场者名字的片段、别人也有的片段、世界书／场景里出现过的片段）、`assessBleed`（只报别人、每人取最长命中片段、上限 3 条、给出 `reason` 一句话）。**头注释写明这一版只做「同一段身世／独有说法」，道具词那半留给顺序 98**，并写下理由（2 字名词只能靠真实语料调阈值；T18 第一版的教训是「用户学会无视警告比漏报更糟」） |
| `packages/core/src/render/bleed.test.ts` | 新增 | 11 条：整句／分句两个粒度与剥标记、4 字下限与纯数字片段、只留自己卡里的片段、含任何人的名字不算独有、两人共有与世界书布景不算独有、秦娘复述陈九身世命中（带原话片段）、自己说不算、多命中上限 3、空输入安静返回 |
| `packages/core/src/index.ts` | 改 | `:39` 加 `export * from './render/bleed.js';`（插在 attribution 与 intent 之间） |
| `apps/web/src/components/MessageItem.tsx` | 改 | `ItemProps` / `ListProps` 加 `signatures`（注明引用必须稳定，否则几百条消息的 `memo` 全失效）；`assessBleed` 走 `useMemo`（依赖 `[message, signatures]`）；在归属提示（T18）下方用同一套 `.attr-warn` + `BusyButton` 画串线警告：「⚠ 这条可能不是「X」说的：出现了「Y」独有的说法「原话片段」（他的角色卡里写着）」＋「改成「Y」说的」（复用 `onReassign`），最后一条时再加「重抽这条」（复用 `onRegenerate`） |
| `apps/web/src/components/MessageItem.test.tsx` | 新增 | 5 条（`renderToString`，只 mock `../lib/render-count`）：命中画警告与原话证据、非最后一条不给「重抽这条」、自己说不画警告、玩家消息不评估、空签名安静。断言避开 `renderToString` 插在插值之间的 `<!-- -->` |
| `apps/web/src/components/MainChat.tsx` | 改 | `Props` 加可选 `signatures`，透传给 `MessageList`；缺省用模块级常量 `EMPTY_SIGNATURES`（每次渲染造新数组会让整表重画） |
| `apps/web/src/App.tsx` | 改 | 新增 `signatureKey` + `useMemo(buildSignatures)`：成员取 `cast`（`cardId` → `session.library.cards`），素材 = `description`／`personality`／`tags`，`aliases` = `displayName`／`name`／`nickname`；`shared` = 所挂世界书条目正文 + `scene.summary`。key 拼的是内容而不是对象引用（与 `avatars` 同一套路），避免后台每轮分析写入后重建数组；`<MainChat signatures={signatures}>` |
| `docs/{TASKS,STATUS,EVAL,FILE-LOG}.md` | 改 | 顺序 79 计划行改成 ✅ 并写清判据与边界、加「顺序 79 怎么处理的」整节与遗留；总表逐行对齐 + 新增顺序 98 行（道具词级串线检测）；STATUS 接续点；EVAL 第九十节与本节 |

本批**已随 2026-09-30 整批 push、网页已换版**（STATUS 顶部「整批上线」一节）；五项门禁数字与「误报率没有真实语料标定」的边界见 EVAL 第九十节。

## 顺序 103、2026-09-30：世界管理员起草角色卡的长度口径（人设 ≤5 句、性格 2～3 句）

用户 2026-09-30 的实测反馈：请世界管理员建角色时，**人设（description）压到 5 句以内、性格（personality）2～3 句，主对话效果明显更好**，要求对管理员这条链路做专项升级。只读勘查先把机制查清：管理员原有的私有系统提示词一共 6 行、**一条长度要求都没有**；而 `packages/core/src/prompt/assemble.ts` 的 `buildPersonaBlock` 会把 `card.description` 与 `性格：${card.personality}` **全文**塞进主对话提示词（只有整块被压时才截 160 字）——起草期写多长，之后**每一轮**就背多长。口径本体只写一处，系统提示词、工具字段说明（网页版桥接会原样渲染它）、草稿提醒三处共用；超长**只提醒不截断**（硬拦会破「两行数组要被接受」与「真实模型录下的调用必须 parsed.ok」两条既有断言）。

| 文件 | 动作 | 本批内容 |
| --- | --- | --- |
| `packages/core/src/admin/tools.ts` | 改 | 新增 `CARD_DESCRIPTION_MAX_SENTENCES = 5`、`CARD_PERSONALITY_MAX_SENTENCES = 3`、`CARD_LENGTH_GUIDE`（两句：人设 5 句以内／性格 2～3 句以内 + 「身世细节、地方风物、历史事件放进世界书」）、`SENTENCE_SPLIT = /[。！？!?…\n\r]+/`、`countSentences`（分号逗号不断句、连续标点只算一次）、`cardLengthNote`（都在口径内返回空串，否则拼「人设 X 句、性格 Y 句，建议人设 5 句以内、性格 2～3 句」）；`upsert_character_card` 的 `description`／`personality` 字段说明改写成带句数的版本；`parseCardDraft` 把 `cardLengthNote` 拼进草稿自身的 `summary`（**字段一个字不改**） |
| `packages/core/src/admin/prompt.ts` | 改 | 私有 `SYSTEM_PROMPT` 引用 `CARD_LENGTH_GUIDE`（import 改为 `import { ADMIN_TOOLS, CARD_LENGTH_GUIDE } from './tools.js';`），并附注释说明为什么放在「一次把内容写完整」之后、以及为什么只提醒不截断 |
| `packages/core/src/admin/tools.test.ts` | 改 | 新增 5 条：工具声明字段说明含「5 句话以内」／「2～3 句话以内」、`countSentences` 的标点／换行／分号行为、6 句人设 + 4 句性格时 summary 附提醒且原文一字不改、合规卡 summary 恰为「新建角色卡「秦娘」」、改卡沿用旧长人设也会提醒 |
| `packages/core/src/admin/turn.test.ts` | 改 | 新增 1 条：`buildAdminMessages` 的系统提示词里含「人设（description）控制在 5 句话以内」与「性格（personality）控制在 2～3 句话以内」 |
| `docs/{TASKS,STATUS,EVAL,FILE-LOG}.md` | 改 | 顺序 103 计划行（✅）与「顺序 103 怎么处理的」整节 + 遗留、STATUS 接续点、EVAL 第一百零三节、本节 |

本批**已随合并提交 `9d5e5fd` push、并只重新部署前端**（2026-09-30，见顺序 104 一节同一行的说明）；五项门禁数字、真模型待验与四条遗留见 EVAL 第一百零三节。

## 顺序 104、2026-09-30：副对话的逐字流式与工具调用可见

用户 2026-09-30 的要求：「将流式输出也加载到副对话中，并且可以看清他的当前工具调用」。只读勘查先定位缺口：主／副双通道（`StreamScope = 'main' | 'admin'`）与交接范式都是现成的，缺的是**增量**与**接线**——`packages/core/src/admin/turn.ts` 每轮要等 `collectCompletionWithTools` **整轮收完**才 yield 一个 text，`apps/web/src/lib/admin.ts` 的 `switch` 又把 `tool` 事件丢进 `default`。逐字流用**回调**加增量（不新增事件类型，免得重写 `turn.test.ts` 四条按事件数组断言的既有用例），工具可见则复用草稿自己的中文 `summary` 与既有的 `StreamState.progress`。

| 文件 | 动作 | 本批内容 |
| --- | --- | --- |
| `packages/core/src/provider/collect.ts` | 改 | `collectCompletionWithTools(provider, messages, params = {}, signal?, onDelta?)` 加**可选**第 5 参 `onDelta?: (delta: string) => void`（给增量、累计交调用方；不传就是原行为，既有调用与测试零改动） |
| `packages/core/src/admin/turn.ts` | 改 | `AdminTurnOptions` 加可选 `onDelta` 并透传给 `collectCompletionWithTools`；新增导出 `describeToolExecution(execution): string`（有草稿用 `execution.draft.summary`，否则 `调用失败：${execution.toolName}`） |
| `apps/web/src/lib/admin.ts` | 改 | `onDelta` 里 `answer += delta` 并 `setStreamState('admin', { text: answer, phase: 'writing', progress: '' })`；`case 'text'` 改成 `break`（不再叠加，否则同一段计两遍）；`case 'tool'` 把 `describeToolExecution` 的结果写进 `progress`；落库后 `handoffStreamState('admin', message.id)`（`handedOff` 声明在 `try` 之前），`finally` 只在未交接时 reset；`commitBridge` 循环补 `progress` 并在其 `finally` reset |
| `apps/web/src/components/SideChat.tsx` | 改 | 改取 `useStreamState('admin')` 的 `text` 与 `progress`；画「工具调用：{progress}」与「正在准备…」占位；`messages.at(-1)?.id` 判 `handedOver` + effect 里 `acknowledgeStreamHandoff('admin', …)`；卸载时 `resetStreamState('admin')` |
| `apps/web/src/components/SideChat.test.tsx` | 新 | 5 条：正文画在管理员行、工具调用显示草稿摘要、`busy` 且无内容画「正在准备…」、不忙无流式不画这行、交接后不画流式副本 |
| `packages/core/src/admin/turn.test.ts` | 改 | 新增 `describe('顺序 104：副对话的逐字流与工具调用可见')` 2 条：`onDelta` 按顺序收到每一块正文且拼起来等于 `done.text`；`describeToolExecution` 优先草稿 summary、无草稿退工具名 |
| `docs/{TASKS,STATUS,EVAL,FILE-LOG}.md` | 改 | 顺序 104 计划行（✅）与「顺序 104 怎么处理的」整节 + 遗留、STATUS 接续点、EVAL 第一百零四节、本节 |

本批**已 push、已只重新部署前端**：顺序 103／104 做完后用户要求「请 push 以及部署」，因线上网页已带 `codex/sync-admin-readonly` 的账户补丁，先 `git merge --no-ff codex/sync-admin-readonly` 把顺序 99／100 并进主线（四份文档冲突按「两边内容都留」解掉），合并提交 `9d5e5fd`（38 文件 +3072/−74，第一父顺序 104、第二父顺序 100），合并后门禁 typecheck 0 / lint 318 文件 0 error / test Core 852＋Web 96＋管理 18＝**966** / build 0（`assets/index-Cuf6mb55.js` 686.91 kB）/ build:sync-server 0，再 `5575105..9d5e5fd` 快进 push 到 `origin/main`；部署只换网页（正式机 `source-revision.txt` 已是 `e6d9fdae…`，同步服务与数据没动），`D:\Dramatis\web\dist` 换成新构建、旧目录留成 `dist.bak-20260930-234203`，公网与目标机自查全绿（JS 686910 B、SHA-256 `F44A088…771C` 与本地逐字节相同、`/sync/health` 200）。五项门禁数字（与顺序 103 共用同一工作区状态）与五条遗留见 EVAL 第一百零四节——其中「逐字流观感」与「工具调用可见」本机假模型验不了，**归 Codex 真机真模型**。

## 顺序 99、2026-09-30：账户关联与只读服务器管理台

用户批准 A（SSH＋本机网页）与账户 ID／显示名＋关联空间。主仓 96／97 已完成、98 已登记给其它工作，首批最终编号 **99**；工作位于隔离分支 `codex/sync-admin-readonly`，一批一个提交。**2026-09-30 已并入主线并随顺序 103／104 一起 push、一起换前端**（合并提交 `9d5e5fd`，见顺序 104 一节）。

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `tools/sync-server/src/accounts.ts` | 新增 | 账户资料最小表、现有凭证／恢复凭证证明、显式同意、句柄核对、4 KB／限流、世代绑定与事务幂等认领 |
| `tools/sync-server/src/main.ts` | 改 | 用户自助 `/accounts/claim` 接线、专属体积上限、日志路径去查询参数 |
| `apps/web/src/lib/account-profile.ts`／`.test.ts` | 新增 | 同意后才登记、响应核对、旧服务器／失败兼容；4 条测试 |
| `apps/web/src/lib/account-auth.ts` | 改 | 注册／登录／恢复凭证认领接线、服务端显示名、失败保留本地账户 |
| `apps/web/src/components/AccountPanel.tsx` | 改 | 最小资料告知和同意、登记失败提示、登录恢复状态清理、改变服务器重新取得同意 |
| `tools/sync-admin/src/{store,http,audit,main,node.d}.ts` | 新增 | 显式安全元数据 DTO、只读 SQLite、GET 白名单、严格回环来源与 token、CSP／no-store、独立追加审计、备份文件信息与固定回环健康请求 |
| `tools/sync-admin/{start.mjs,tsconfig.json,.env.example}` | 新增 | 独立管理进程与无秘密环境模板 |
| `tools/sync-admin/web/{index.html,app.js,style.css}` | 新增 | 账户／空间总览、搜索分页、详情、备份与退出；token 仅会话内存，资料以纯文本渲染 |
| `tools/sync-admin/{accounts.test.mjs,admin.test.mjs,smoke.mjs}` | 新增 | 11 条真实 SQLite／HTTP 专项，以及 Windows 本机浏览器的独立假库验收环境 |
| `tools/sync-admin/README.md`／`windows/DramatisSyncAdmin.xml.example` | 新增 | 泛化 Windows WinSW／NTFS ACL／既有管理隧道说明、验收与回滚，无正式身份信息 |
| `package.json`／`.github/workflows/ci.yml` | 改 | 管理编译／类型检查／专项测试接入根门禁；CI 步骤注释标明新覆盖 |
| `docs/ADMIN-CONSOLE.md` | 改 | 修正真实 `heads`／`epoch`／封装 JSON schema、已选择形态、已实现／后续分界、Windows 接入与具体风险防护 |
| `docs/superpowers/plans/2026-09-30-sync-admin-readonly.md` | 新增 | 单批实施、约束、验收与回滚计划 |
| `docs/{STATUS,TASKS,EVAL,FILE-LOG}.md` | 改 | 顺序 99、任务 56 首批状态与后续；EVAL 第九十一节证据，任务 73 保持待办 |

Windows 本机临时库／真实浏览器完成同意登记、不登记注册、登录、元数据查询、HTML 名称纯文本、token 拒绝与退出；正式主机没有连接。五门禁最终数字见 EVAL 第九十一节。配额修改、VIP／托管服务／其它服务目录与桌面壳均不在本批实现。


## 顺序 100、2026-09-30：管理台显示名／存储配额与正式接入

用户批准正式连接和所选编辑范围，续于顺序99；**2026-09-30 已并入主线并随顺序 103／104 一起 push、一起换前端**（合并提交 `9d5e5fd`；正式机 `source-revision.txt` 当时已是本批的 `e6d9fdae…`，故只换网页、没动同步服务）。正式生产接入和回滚事实见EVAL第九十二节，真实地址／身份／token仅存忽略的LOCAL-NOTES。

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| packages/core/src/sync/sqlite.ts | 改 | 配额resolver在IMMEDIATE写事务内执行，保持现有接口默认与记录数护栏 |
| tools/sync-server/src/storage-policy.ts／main.ts | 新增／改 | epoch绑定的空间额度表与宿主接线；降低及恢复默认后只拒增长 |
| tools/sync-admin/src/operations.ts／backup.ts | 新增 | 白名单预览、2分钟单次票据、完整句柄、唯一一致性快照校验、事务内重检与原子修改 |
| tools/sync-admin/src/{audit,http,main,node.d,store}.ts | 改 | fsync追加写审计、精确Origin／4KB写路由、可选写连接、安全有效配额投影与配置防护 |
| tools/sync-admin/web/{app.js,index.html,style.css} | 改 | 名称／容量编辑、前后值及确认、超额提示、请求版本与会话隔离 |
| tools/sync-admin/{policy,operations,admin}.test.mjs | 新增／改 | 18条专项，真实SQLite／HTTP，审查问题先红后绿 |
| tools/sync-admin/smoke.mjs／.env.example | 改 | 临时假库可编辑验收、备份目录与写开关／默认额度 |
| tools/sync-admin/README.md／windows/DramatisSyncAdmin.xml.example | 改 | 已验证Windows运维、受限ACL、独立操作备份、正确服务账户字段、泛化绝对路径与回滚 |
| docs/ADMIN-CONSOLE.md | 改 | 真实策略schema、已完成阶段、写边界、审计、备份与真实运维风险 |
| docs/superpowers/specs/2026-09-30-sync-admin-editable-design.md／plans/2026-09-30-sync-admin-editable.md | 新增 | 用户已批准规格、顺序100实施与执行证据 |
| docs/{STATUS,TASKS,EVAL,FILE-LOG}.md | 改 | 顺序100进度、任务56阶段、门禁／正式真机证据与限制；任务73仍待办 |

正式网页基于已上线4ee7edd仅叠账户登记所需文件；未上线无关顺序96提示词。原程序与生产快照保留。真实编辑仅在假库，生产只查元数据。五门禁916条全部通过；正式Node22专项18条全部通过。

## 顺序101、2026-09-30：管理员关联未登记空间与密码恢复指引

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| tools/sync-admin/src/identity.ts／node.d.ts | 新增／改 | 与core一致的已知ID规范化及句柄定位，不涉及凭证或解密材料 |
| tools/sync-admin/src/store.ts／operations.ts | 改 | 已知ID搜索未登记空间；受控关联、事务防并发、最小资料及独立关联审计 |
| tools/sync-admin/web/app.js／index.html | 改 | 关联输入与前后值确认、编辑期间过期预览取消；用户自助密码恢复指引，无密码接收 |
| tools/sync-admin/admin.test.mjs／operations.test.mjs／smoke.mjs | 改 | 客户端协议对照查询、关联／拒绝／失败／并发／凭证密文不变；假ID真浏览器验收 |
| tools/sync-admin/README.md／docs/ADMIN-CONSOLE.md | 改 | 关联与所有权证明区别、ID匹配要求、密码补救限制、管理程序单独回滚 |
| docs/{STATUS,TASKS,EVAL,FILE-LOG}.md | 改 | 顺序101范围、门禁与真机证据；任务73仍开着 |

无schema迁移或同步／客户端代码修改。真实ID、地址、token与运维细节只在忽略的LOCAL-NOTES；此批未push。

## 顺序105、2026-10-01：每账户默认服务器存储96MiB

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| packages/core/src/sync/server.ts | 改 | 通用同步默认100663296字节，配置覆盖优先级保持 |
| tools/sync-admin/src/main.ts／store.ts | 改 | 管理启动／只读查询默认96MiB，与实际同步执行一致 |
| tools/sync-server/src/storage-policy.ts | 改 | 无自定义策略的超额旧空间也可等长／缩减，事务内拒增长 |
| tools/sync-admin/default-quota.test.mjs | 新增 | 真实子进程HTTP边界、双记录批次原子拒绝、启动前自定义保留与运行时覆盖；只用临时假库 |
| tools/sync-admin/admin.test.mjs／policy.test.mjs | 改 | 管理默认／显式覆盖、全局降额无行分支缩减与不增长测试 |
| tools/sync-{admin,server}/.env.example／README.md、docs/SYNC.md／ADMIN-CONSOLE.md | 改 | 当前默认96MiB、单位与继承／覆盖规则及程序回滚；历史256MB记录保留 |
| docs/{STATUS,TASKS,EVAL,FILE-LOG}.md | 改 | 顺序105范围、五门禁922条、正式Node22隔离24条及正式切换证据 |

无schema迁移或真实账户资料／单空间策略批量修改；正式同步与管理服务更新前备份20066304B，原程序及环境保留。真浏览器4行容量均96.00MB；任务73部署文档漂移仍开着。此批单个顺序105提交，未push。

## 顺序106、2026-10-01：管理台VIP会员首版与汇合发布

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| tools/sync-server/src/storage-policy.ts | 改 | 创建世代绑定会员／权益表，事务内固定配额含0优先、有效VIP额度及到期／撤销即时失效 |
| tools/sync-admin/src/membership.ts | 新增 | 最小会员字段投影、状态与有效配额来源 |
| tools/sync-admin/src/store.ts／operations.ts／audit.ts | 改 | 只读会员计数与最近20条权益；独立开通／续期／撤销、备份确认审计、并发与期限校验 |
| tools/sync-admin/web/{app.js,index.html,style.css} | 改 | 会员状态／额度来源／历史、预览完整句柄确认、备份保存与已保存警告 |
| tools/sync-admin/membership.test.mjs／policy.test.mjs | 新增／改 | 5条管理全流程及6条同步规则；覆盖固定0、到期边界、备份审计失败、票据并发、世代及凭证密文不变 |
| tools/sync-{admin,server}/README.md、docs/ADMIN-CONSOLE.md | 改 | 当前会员范围、固定优先规则、服务器时钟、回退105忽略VIP影响；托管API未接通 |
| docs/{STATUS,TASKS,EVAL,FILE-LOG}.md | 改 | 两边历史章节保留；顺序106范围、983项门禁、隔离浏览器与正式部署证据 |

汇合origin/main已有97／77／79／103／104等代码，未重做这些功能；101／105随本批普通快进推送。正式仅更新同步／管理程序，前置快照20135936B，旧目录及配置保留；源库不覆盖，真实账户未开通VIP。运维脚本、地址、身份与截图均在忽略的本地路径；任务73仍待办。

## 顺序107、2026-10-01：VIP与配额快捷操作

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| tools/sync-admin/web/app.js | 改 | 列表配额／VIP直接入口与简洁操作页；30／90／365天、96／256／512 MB与1／5 GB快捷项、MB／GB保持字节额度；配额页只改maxBytes；固定0优先提示、复制句柄但不预填、预览失效／过期及提交锁定 |
| tools/sync-admin/web/index.html／style.css | 改 | 操作列、紧凑容量与快捷按钮布局、固定配额提示及复制区 |
| tools/sync-admin/controls.test.mjs | 新增 | node:vm执行真实管理页函数，3条验证固定0／VIP0、单位与小数往返、非法输入及1TiB边界；RED0/3→GREEN3/3 |
| tools/sync-admin/README.md／docs/ADMIN-CONSOLE.md | 改 | 快捷使用说明、原有配额及人工确认／备份规则、只更新管理网页并重启独立管理服务、回滚旧程序／配置后重启 |
| docs/{STATUS,TASKS,EVAL,FILE-LOG}.md | 改 | 顺序107范围、五门禁986条、真IAB假库5次备份、正式暂存37/38打包遗漏及补齐后38/38、正式管理网页部署证据；任务73保持待办 |

后端接口、schema和同步程序不变，真实账户没有作为编辑测试。正式仅重启独立管理服务，切换前自动备份20156416B，保留旧管理程序／配置；空间配额前后核验一致，同步uptime持续，不覆盖生产库或WAL。正式包哈希、快照及验收见EVAL第一百零七节。

## 顺序109、2026-10-01：账户与设置独立界面及体验优化

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| apps/web/src/App.tsx、components/{LeftRail,TopBar}.tsx | 改 | 两个独立打开状态与互斥入口，按需加载弹窗，窄屏关闭回到可见顶栏入口，启动显示账户待清理反馈 |
| apps/web/src/components/{DialogShell,LazyPanel,AccountDialog}.tsx | 新增 | 共用Portal／inert／焦点外壳、离开确认和异步内容边界；账户独立两分区 |
| apps/web/src/components/{SettingsDialog,AccountPanel,SyncPanel,ProviderPanel,AppearancePanel}.tsx | 改 | 设置去账户分类；账户状态、流程错误和忙碌态、恢复码保护；模型草稿与保存反馈、主题pressed、图片读取保护；模型删除／换密码改界面内确认 |
| apps/web/src/components/{DataSettingsPanel,ArchivedConversationsPanel}.tsx | 新增 | 数据备份和本机存储独立面板；归档删除等待真实结果，失败保留确认与重试 |
| apps/web/src/lib/{account-ui,account-deletion,dialog-controller,deletion-feedback,recovery-protection}.ts | 新增 | 账户状态、同步操作gate、严格本机删除结果、离开保护与浏览器恢复码提醒；归档删除区分未删除和已删除但刷新失败 |
| apps/web/src/lib/{account-auth,db,keystore,session,sync,providers}.ts | 改 | 注册成功尽早内存交付恢复码；严格清理、队列／扫描并发、共享密钥保留、启动反馈；同步旋转串行和读取最新凭证；模型Key加载就绪保护 |
| packages/core/src/crypto/keys.ts、platform/key-vault.ts | 改 | 默认不可导出的主密钥提供显式同步会话重新包装选项；口令库整笔读改写可共用本机串行锁，无协议或存储格式迁移 |
| apps/web/src/styles.css | 改 | 复用既有token，390px单列、横屏短高度、安全区、可视视口、长名／ID换行、保存栏与确认布局 |
| apps/web/tools/shell-assets.ts、vite.config.ts、public/sw.js | 新增／改 | 构建懒加载模块清单并让SW随产物更新；预缓存两弹窗及面板、保留上一代静态模块，API／同步请求仍放行 |
| 本批相关 Core／Web 测试 | 新增／改 | 删除／注册／恢复码／并发／换密码／模型草稿与Key／归档真实反馈／离线分包行为回归；实际数字见EVAL第一百零八节 |
| docs/superpowers/plans/2026-10-01-task-109-account-settings.md、docs/{TASKS,STATUS,EVAL,FILE-LOG}.md | 新增／改 | 用户批准方案、109范围、门禁和验收证据、回滚及未验证项；不重写107或其它会话段落 |

本批单个109提交；初次本地交付未push／部署，不改同步服务端或管理端、不新增运行时依赖。五门禁全过：lint344文件，Core857＋Web209＋管理38＝1104条；首屏JS649422B为入口及所有modulepreload合计，减5.43%，后台预缓存另计。真实浏览器切换、改名、删除、恢复码登录与桌面／竖横屏／浅深色已验；物理手机与真实软键盘、实际刷新警告及PWA真断网更新待验证，69／70仅部分收口，76保持待办。实施提交前fetch主线仍f97dbad；没有带入其它会话改动。

2026-10-02发布补记：用户追加明确授权push及部署，后续仅只读已批准的必要接入信息，没有复制私密笔记或编辑桌面副本。发布前五门禁再次全过，仍1104条；只换正式静态网页，172文件长度／SHA校验、13份新JS-CSS及2份旧资产保留，完整旧目录备份，公网16份关键资源200／MIME／SHA及缓存头通过，同步健康与五服务PID保持。正式浏览器刷新后的独立账户／设置及旧页面兼容已验；首次新标签仍命中旧首页，完整PWA更新仍待验证。主线交付采用单个109提交普通快进推送；四文档只更新109发布续记，脚本／清单／日志／截图留在忽略的out/task-109，未新增批次或改其它会话历史。

## 顺序110、2026-10-02：VIP套餐、托管纳元账本与回环网关

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| tools/sync-admin/src/{vip-plans,api-accounting}.ts | 新增 | 四档版本化价格／50%整期额度；运营schema、追加购买／credit／charge、BigInt汇总、独立资格、预留／结算／pending与epoch幂等 |
| tools/sync-admin/src/{operations,membership,store,http}.ts | 改 | 购买同事务、API修订预览与canonical套餐、旧会员身份兼容、仅安全账本投影与鉴权目录，沿用确认／备份／审计 |
| tools/sync-server/src/{deepseek-billing,hosted-api,gateway-main}.ts、gateway.mjs、gateway.env.example | 新增 | 固定回环DeepSeek Flash、公开价版本／节假日／整个调用区间判断、严格usage与纳元计价、鉴权重检、UUID幂等、真实HTTP SSE／背压／停机和受保护配置模板 |
| tools/sync-server/src/{storage-policy.ts,node.d.ts} | 改 | 宿主初始化运营表，现有固定／VIP配额规则保持；Node运行类型支持 |
| tools/sync-admin/{accounting,billing-store,hosted-api,vip-purchases}.test.mjs | 新增 | 追加账本／购买事务／字段安全、旧库、精确金额、并发与异常、真实HTTP慢socket及供应商usage夹具回归 |
| tools/sync-admin/{admin,policy}.test.mjs | 改 | 鉴权套餐目录；可空会员迁移兼容明确列名插入 |
| tools/sync-admin/web/{app.js,index.html,style.css} | 改 | 购买／赠送办理方式、4档快照、独立截止、余额与待核对流水；人工句柄及旧预览清理；109账户恢复入口 |
| tools/sync-admin/README.md、tools/sync-server/README.md、docs/ADMIN-CONSOLE.md | 改 | 本批后端范围、网关配置／资金和价格限制、回环与程序回滚，不扩任务73 |
| docs/superpowers/{specs/2026-10-01-vip-deepseek-billing-design.md,plans/2026-10-02-vip-hosted-billing.md} | 新增 | 用户规则及顺序110真实实施边界与验收计划；不另占顺序号 |
| docs/{STATUS,TASKS,EVAL,FILE-LOG}.md | 改 | 门禁1154/1154、正式Node22隔离88/88、IAB假库购买／续期／赠送及真实Flash两次扣费、安全发布证据与后续 |

门禁与正式发布详见EVAL第一百零九节。真实运营Key、包／备份／部署脚本、隔离数据库／日志和截图留忽略路径，不提交；生产账户只读，不补历史发放。公网模型入口、客户端接线、支付和供应商对账保持后续。一个带顺序110提交，普通快进推送，不覆盖生产库或WAL。

## 七十三、几点注意

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
