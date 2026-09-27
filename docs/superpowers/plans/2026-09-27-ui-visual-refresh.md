# Dramatis 界面视觉优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已批准的“叙事剧场”视觉方向落实到桌面与手机界面，统一 SVG 图标和有意义的微动效，并留下可复核的阶段验收记录。

**Architecture:** 保留 React 组件边界和 `LAYOUT.md` 的交互结构。先在现有 CSS 变量上扩展语义令牌，在 `Icons.tsx` 维护内联 SVG，再按阅读主路径、辅助工作区逐区改样式；不触碰 `packages/core` 的数据、提示词与同步逻辑。

**Tech Stack:** React 19、TypeScript、Vite 8、原生 CSS、内联 SVG、Vitest；桌面 PWA 与 Android WebView 共享前端。

**Spec:** `docs/UI-VISUAL-OPTIMIZATION-PROPOSAL-2026-09-27.md`；现有行为以 `docs/LAYOUT.md` 为准。

## Global Constraints

- 用户已批准视觉方向 A“叙事剧场”，并要求补强图标、SVG 和微动效；先出主对话样例供审阅，再推广。
- 手机端保留全屏聊天、覆盖式顶栏、在场角色条、主副切换、左右抽屉推开对话、输入草稿及流式消息不卸载。
- 动画只表达状态或操作结果；`prefers-reduced-motion: reduce` 下即时切换；触屏高频目标至少 44×44px。
- 图标沿用 16×16 坐标、`currentColor` 与现有描边语言；图标按钮须有可访问名称与可见焦点。
- 不增加字体或整套图标库依赖，不修改数据模型、提示词、同步协议、消息分段语义。
- 工作前检查 `git status`；不使用 `git reset`、`restore`、`checkout`、`stash`、`clean` 清理他人工作；不在公开文档写入私有地址、密钥、凭据。
- 未经用户明确要求，不 push、不部署。每个实现批次单独验收和提交，仅暂存本批改动文件；编号与 `docs/TASKS.md` 当前队列对齐。
- 每批代码改动同步更新 `docs/TASKS.md`、`docs/EVAL.md`、`docs/STATUS.md`、`docs/FILE-LOG.md`。EVAL 记做法、实际命令及结果、截图/视口、未验证项；STATUS 记当前状态；FILE-LOG 列文件与动作；计划偏差写明原因。
- 每次提交前跑五项门禁：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`pnpm build:sync-server`。真实浏览器、手机键盘/安全区未验时明确写“待验证”；不把代码门禁等同视觉验收。

## Review Focus

1. 自定义背景图下的动作与旁白仍清晰；在主对话任务的截图审阅中检查纯色和亮图两种情况。
2. 390px 手机与横屏的输入、顶栏和菜单不重叠；在主对话任务的视口验收中检查。
3. 加号菜单开合、焦点、Esc 和 `aria-expanded` 一致；在图标任务中做交互检查。
4. 减少动效模式下没有旋转和位移过渡，但状态仍可辨认；在图标与手机布局任务中检查。
5. 世界树及消息菜单换 SVG 后，键盘和触摸操作入口仍能找到；在辅助工作区任务中检查。

---

### Task 1: 建立视觉与图标基线

**Files:**
- Modify: `apps/web/src/styles.css`（`:root`、三主题变量与共用状态规则）
- Modify: `apps/web/src/components/Icons.tsx`（共用图标及尺寸/笔画约定）
- Update: `docs/EVAL.md`、`docs/STATUS.md`、`docs/TASKS.md`、`docs/FILE-LOG.md`

**Interfaces:** 保留现有 `IconPlus`、`IconScene`、`IconSend`、`IconStop`、`IconMenu` 的导出；新增图标一律接收 `size?: 16 | 20`，`aria-hidden`，由按钮提供名称。CSS 令牌保持现有变量向后兼容。

- [ ] **Step 1:** 截取现有酒馆、浅色、深色主题的桌面/手机基线；若本地 Vite 的 `EPERM` 未解决，记录确切限制与可行的替代采样，不编造截图。
- [ ] **Step 2:** 在 `styles.css` 增加表面、文字、焦点、状态与动效令牌；保留现有变量供未迁移组件使用。
- [ ] **Step 3:** 在 `Icons.tsx` 增加本阶段实际需要的少量 SVG，并对照 16/20px 尺寸检查重心、线宽和主题变色。
- [ ] **Step 4:** 检查三主题的正文、辅助文字、焦点与禁用态；记录截图、视口和未验项。
- [ ] **Step 5:** 跑五项门禁；更新四份项目记录；只暂存本任务文件并提交。

### Task 2: 输入区加号与菜单微动效样例

**Files:**
- Modify: `apps/web/src/components/MainChat.tsx`（模式按钮状态及菜单关联）
- Modify: `apps/web/src/styles.css`（加号旋转、按钮选中与菜单显隐）
- Update: 四份项目记录

**Interfaces:** `modeMenuOpen: boolean` 是动画与 `aria-expanded` 的唯一状态源；菜单有稳定 `id`，按钮用 `aria-controls` 关联；`IconPlus` 本身无需感知状态。

- [ ] **Step 1:** 先定义可检查的交互断言：初始关闭、点击展开、第二次点击关闭、归档禁用、键盘焦点、减少动效模式。
- [ ] **Step 2:** 给按钮接入 `aria-expanded`、`aria-controls` 和打开态类名；SVG 外层旋转 45°，180–220ms 缓出，关闭复位。
- [ ] **Step 3:** 给菜单增加轻微显隐反馈，同时保证一出现即可操作；减少动效模式取消过渡。
- [ ] **Step 4:** 在桌面和 390px 手机样例中复核菜单位置、输入草稿与发送键不跳动；记录结果或待验证项。
- [ ] **Step 5:** 跑五项门禁；更新四份项目记录；只暂存本任务文件并提交。

### Task 3: 主阅读界面与移动布局

**Files:**
- Modify: `apps/web/src/styles.css`
- Modify only if required: `apps/web/src/components/TopBar.tsx`、`LeftRail.tsx`、`MainHeader.tsx`、`MainChat.tsx`、`MessageItem.tsx`、`Composer.tsx`、`CastRail.tsx`
- Update: 四份项目记录

**Interfaces:** 现有组件 props、对话与场景事件保持不变；仅调整呈现层。手机抽屉位移仍作用于 `.chat-surface`，不加到 `.workspace`。

- [ ] **Step 1:** 做可审阅的桌面和手机主对话样例，覆盖空状态、多人长对话、动作/旁白、亮背景图与输入焦点；先让用户看样例。
- [ ] **Step 2:** 按通过的样例调整文字层级、消息节奏、主区与边栏表面层级，并保留主副对话语义。
- [ ] **Step 3:** 核对 390px、横屏、约 768px、约 1440px 视口；检查触控目标、顶栏、安全区、滚动归属与左右推开抽屉。
- [ ] **Step 4:** 复核流式消息、输入草稿、场景/角色操作与消息菜单；记录浏览器实测与未验项。
- [ ] **Step 5:** 跑五项门禁；更新四份项目记录；只暂存本任务文件并提交。

### Task 4: 辅助工作区的图标与层级

**Files:**
- Modify as needed: `apps/web/src/components/WorldTree.tsx`、`RuntimePanel.tsx`、`SettingsDialog.tsx`、`SideChat.tsx`、`Icons.tsx`、`styles.css`
- Update: 四份项目记录

**Interfaces:** 保留既有入口、保存/取消语义和危险操作确认。SVG 状态跟随现有展开或选中状态，不新建与业务状态重复的动画状态。

- [ ] **Step 1:** 逐项列出现有字符图标与按钮，确定需要替换的图标；世界树展开、设置分类、运行时页签与副对话标识优先。
- [ ] **Step 2:** 统一图标、文字间距、菜单显隐和选中状态；保持副对话无气泡布局。
- [ ] **Step 3:** 审阅世界树、设置长表单、运行时面板及副对话草稿预览的桌面/手机截图。
- [ ] **Step 4:** 检查键盘、触摸、危险操作和减少动效模式；记录通过与待验证。
- [ ] **Step 5:** 跑五项门禁；更新四份项目记录；只暂存本任务文件并提交。

### Task 5: 全局验收与完成记录

**Files:**
- Update: `docs/EVAL.md`、`docs/STATUS.md`、`docs/TASKS.md`、`docs/FILE-LOG.md`
- Update if behavior/spec deviated: `docs/LAYOUT.md`、`docs/UI-VISUAL-OPTIMIZATION-PROPOSAL-2026-09-27.md`

**Interfaces:** 不新增产品逻辑。

- [ ] **Step 1:** 对照方案书逐条检查桌面/手机、三主题、状态与微动效；将问题列入 TASKS 而非掩盖。
- [ ] **Step 2:** 复跑五项门禁，逐项记录命令、结果与环境；视觉截图、真实浏览器、手机软键盘及安全区分别注明证据与限制。
- [ ] **Step 3:** 在 EVAL 写本批总结、已通过/未通过/待验证；在 STATUS 写当前状态与后续动作；在 FILE-LOG 对齐实际文件清单；TASKS 勾状态。
- [ ] **Step 4:** 检查文档中没有私有地址、密钥或未经证实的“已验”结论；`git diff --check` 后只暂存本任务文档并提交。
