# 顺序112 素材库工作区实施计划

> 用户于2026-10-02批准四项全部推荐。执行本计划和同目录spec；全过程中文，一个顺序号、一份最终提交。

**Goal:** 将三类全库管理移到非会话工作区，保留聊天挂载/流式/草稿/滚动，补完整原生素材JSON交换。
**Architecture:** 局部LibraryWorkspace Provider驱动左栏和覆盖层，旧聊天保布局；LazyPanel加载LibrarySurface及既有编辑器。现有session业务接口保持，窄范围修正前端快照发布。
**Tech Stack:** React19、TypeScript7、Vite8、Vitest5及现有pnpm依赖。
**Spec:** ../specs/2026-10-02-task-112-library-surface.md

## Global Constraints
- 仅新worktree codex/task-112-library-surface，基线4c5169a；不写桌面/f0ed。
- 初次交付不push／部署；用户2026-10-03追加明确授权后允许普通快进推主线与仅静态前端部署。禁止git reset/restore/checkout/stash/clean；最终只有一个顺序112提交。
- 不新增运行时依赖；不改repository、db、IDB schema、同步协议、服务端。
- 不提交真实地址、身份/账号、凭据或Key；本地证据放忽略out/task-112。
- 保持MainChat/SideChat位置/type/key/onStop，不冻结消息/流/交接。
- 流式可浏览，主/副忙碌均禁止素材修改；手机关闭展开左栏回原入口，真实导航成功才收素材。
- 三类单项原生JSON导入导出，复用已有PNG/ST兼容导入；素材导入只入库，不创建会话或自动挂载。
- 基线及冻结后完整五门禁，文档记真实数字/产物/未验证，不以SSR冒充DOM/物理手机。

## Review Focus
- 隐藏聊天的portal/rAF焦点/scrollIntoView不能操作素材或页面祖先。
- A交接迟到不能清B，隐藏期间2秒屏障仍须被真实DOM提交确认。
- 已发出的保存Promise与后台reload不能覆盖新快照；无世界删除真实执行。
- 搜索/排序不偷偷切编辑对象；IME、慢新建、删除与保存交错不丢/复活条目。
- 原生卡/书不能错走ST解析；完整扩展/图片/条目枚举往返与新ID。

## Task 1: 视图基础与聊天保护
Files: library-view.tsx、library-actions.ts（按需）、LibraryWorkspace.tsx、chat-visibility.tsx、MainChat.tsx、SideChat.tsx、对应测试。
- [x] 开/收/互切状态、离开Promise/确认、真实导航成功判定的失败用例先跑RED。
- [x] 实现局部Provider、稳定外壳与可见性上下文，保聊天几何/流交接。
- [x] 局部滚动、历史锚点/贴底恢复、portal/rAF守卫，跑覆盖用例GREEN。

## Task 2: 全库查询、文件能力及session接线
Files: library-query.ts、library-transfer.ts、useImport.ts、session素材回调及对应测试。
- [x] 查询/排序/有效挂载数、三类原生往返和坏输入、纯入库导入、晚快照覆盖/no-world删除先跑RED。
- [x] 实现并复用现有兼容解析/CRUD，记录RED→GREEN及明确结果接口。
- [x] 未改存储协议/运行时依赖。

## Task 3: 现有编辑器异步与离开保护
Files: PersonaLibrary.tsx、CardDesigner.tsx、WorldDesigner.tsx、library-editor.ts及对应测试。
- [x] 浏览与修改disabled分离；Promise成功/失败、在途保存、IME、慢新建/删除先跑RED。
- [x] 接受外部选择/隐藏内部selector，注册统一LeaveHandle；裁图用界面内继续/放弃。
- [x] 沿用字段编辑，不重写业务；库间离开等待所有相关任务。

## Task 4: 完整布局接入
Files: LibrarySurface.tsx、LeftRail.tsx、TopBar.tsx、App.tsx、styles.css、lazy-module.ts、lazy-module-urls.ts、vite.config.ts及集成/构建测试。
- [x] 移除旧pane/panel路径，世界列表常驻、全量可搜索/排序/编辑/导入导出、全部/已挂载。
- [x] 轻壳与两层lazy、失败重试、Esc/aria/焦点/周边元素/mobile层级及backdrop。
- [x] App不继续增长，稳定消息回调并真实导航成功才收库。

## Task 5: 真实浏览器、门禁与独立复核
- [x] 忽略目录真实ReactDOM+stream-store夹具，A/B交接、历史/贴底、草稿/节点身份、stop/abort断言。
- [x] 桌面/390竖屏/横屏/主题/断点/焦点/真实503失败lazy；profile增量和首屏完整资源。受控IME回归已验，物理手机/真实IME/真实模型/PWA离线恢复待验证。
- [x] 独立差异审阅，针对问题RED→GREEN修复。
- [x] 最终五门禁，所有真实数字与未验证项入四文档。

## Task 6: 文档与一次提交
- [x] TASKS计划行/处理表/遗留；STATUS新节；EVAL续节；FILE-LOG新文件与注意编号链。
- [x] fetch，必要时仅本分支rebase，更新批号/验证；明确暂不push/部署。
- [x] 一个提交：顺序112：素材库移入工作区并保护聊天状态。


## Task 7: 用户追加授权后的仅前端发布续记
- [x] 再次完整实跑五门禁，375文件lint、1264/1264测试、Web200模块，实际结果记四文档。
- [x] 180静态文件清单／归档／dist与远端SHA匹配，保留旧资产、旧目录，独立复核路径／缓存／回退边界。
- [x] 首轮HTTP基址作用域失败后只读确认旧首页恢复、六服务同PID与sync健康；显式参数修复按同ScriptBlock模型旧失败→新三路线通过，新独立批标成功发布，保留失败目录。
- [x] 公网24关键资源标准TLS／SHA／MIME与健康通过；正式转发IAB验证三库／回焦及旧设置分包，保存截图，关闭本轮标签与SSH转发。
- [x] HTML／清单无显式缓存头及新标签需刷新一次如实记录，物理手机／真实IME／模型／PWA升级离线继续待验证。

主线交付方法：将同批发布续记纳入尚未发布的本地112提交，再fetch确认快进条件，以普通push推main并核对远端SHA与工作区状态；保持只有一个112提交，不强推，保留分支和worktree。
