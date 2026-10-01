# 顺序109：账户与设置分离实施清单

> 执行方式：当前会话并行实现独立部分，由主代理集成、复核与提交。用户已批准聊天中的全部推荐方案；不增加独立审批或中间提交。

**目标：** 左栏账户与设置打开独立弹窗，两边分别改善信息、流程、可访问性、移动布局和加载体验。

**设计依据：** 本会话用户批准的六部分只读方案。

**架构：** App 持有互斥打开函数与独立打开状态；轻量 DialogShell 同步显示，账户和设置内容、分类面板按需加载。账户与设置各管自己的流程，现有业务 hook 继续由 App 持有。

**技术：** 现有 React、TypeScript、Vite、Vitest、IndexedDB 与浏览器 API。

## 全局约束

- 工作区仅本会话1fae，分支 codex/task-108-account-settings-split；基线 f97dbad，提交前 fetch 并核对主线。
- 本批顺序109，一个提交；不 push、不部署，不操作其他工作区。
- 不改同步协议或服务端、管理端；不新增运行时依赖。
- 不改账户容器、密码、删除的既有数据语义，不改存储schema或待删除队列格式。
- 恢复码只在内存；未确认安全保存时保护离开路径。
- 不添加真实地址、身份或凭据；证据放忽略的 out/task-109，秘密仅可放忽略的 deploy/LOCAL-NOTES.md。
- 不使用 reset、restore、checkout、stash、clean。

## 共享接口

- DialogShell 提供 useDialogActions()，返回 requestAction(action: () => void) 与 setGuard(guard: DialogGuard | null)。
- DialogGuard 为 kind: 'busy' | 'recovery' | 'dirty'，message: string，discard?: () => void。
- 关闭和分区切换使用 requestAction；busy 阻止离开，其他 guard 在界面内确认后执行 discard 和待执行动作。
- LazyPanel 的 load 为稳定模块级函数，返回默认组件；panelProps 传该组件props，label用于加载与错误说明。
- AccountDialog props为 sync: SyncApi 与 disabled: boolean；两分区为账户、同步与安全。
- SettingsDialog 不再输出外壳，保留分类导航与内容；删除 sync 与 onClose props，onDeleteArchived 返回 Promise<{ok:boolean;message:string}>。
- 账户同步信息读取失败必须可区分；不得将未知当未配置或把本机密码缓存当在线连接。

## 复核重点

1. 恢复码期间的关闭、Esc、遮罩、分区、服务器编辑和reload。
2. 清理失败、其他标签占库、非当前账户同步密码和共享密钥引用保留。
3. 模型草稿切分类、保存失败和输入法组合事件。
4. 动态chunk加载失败、离线首次打开及SW禁止缓存业务接口。
5. 390px、低高度横屏、长名字和ID、深浅色与物理软键盘。

## Task 1：客户端账户安全辅助（独立代理）

文件：lib/db.ts、keystore.ts、account-auth.ts、sync.ts及对应测试；不修改session和组件。

- [x] 先写并运行失败用例：清理拒写不能成功、失败留队列、共享引用保留、状态读取错误、非当前同步密码引用。
- [x] 实现严格账户删除清理与结构化结果，保持存储格式；保留普通密钥保存策略。
- [x] 账户状态读失败显式抛错；换密码复用既有同步串行保护，不改协议。
- [x] 回归旧注册表、待删除标记及既有db/同步测试。

## Task 2：账户界面（独立代理）

文件：AccountPanel、SyncPanel、新AccountDialog、必要账户UI辅助及测试。

- [x] 为恢复码复制失败、离开保护、忙碌防重复及错误反馈写有意义的失败用例。
- [x] 实现两分区、状态分层、正确解锁服务器、具体忙碌态、表单与焦点路径。
- [x] 删除消费Task1结果；全量ID确认、服务器副本说明和待清理提示保留。
- [x] 会员区域显示默认说明与暂不可查询；自定义服务器不套默认额度。
- [x] 替换换密码原生确认，保护恢复码与切换账户reload。

## Task 3：设置界面（独立代理）

文件：SettingsDialog、ProviderPanel、AppearancePanel、新DataSettingsPanel、ArchivedConversationsPanel及测试。

- [x] 四类及稳定类型，删除账户内容和静态面板导入。
- [x] 分类懒加载；模型必要字段/高级字段分层，草稿离开与保存反馈。
- [x] 原生模型删除、归档删除改就地确认，等待真实结果，失败不假成功。
- [x] 主题选中语义、即时生效说明和本机存储命名。

## Task 4：外壳、接线、移动与缓存（主代理）

文件：DialogShell、LazyPanel、App、LeftRail、styles、Vite配置、public/sw.js、pwa测试、session必要结果接口与启动提示。

- [x] 实跑五项基线门禁，留数字与构建资源。
- [x] 测试guard行为，再实现稳定外壳、焦点、背景inert、portal与统一离开确认。
- [x] 两独立状态接线，归档直达保持，启动待清理可见。
- [x] 单列字段、安全区、动态视口与低高度触控规则，沿用token。
- [x] 为构建静态chunk清单与SW离线发现写失败用例，实现仅静态资源预缓存；保持接口不缓存。

## Task 5：整体审查、验证、文档与单提交（主代理）

- [x] 独立整体审查；修复阻断问题并复验。
- [x] typecheck、lint、test、build、build:sync-server按顺序实跑，记录文件数/条数/字节与退出码。
- [x] 桌面、390px、竖横屏、深浅色、键盘、恢复码、删除与切换；物理手机未实际运行则写待验证。
- [x] 同环境比较初始JS静态依赖、异步chunk与压缩体积；记录当前打开样本，旧版冷/热耗时对照未测、不声称提速；SW下载另列。
- [x] 更新TASKS、STATUS、EVAL第一百零八节、FILE-LOG109节及注意章节编号。
- [x] fetch后处理主线变化，确认无禁止目录改动/敏感新增，再统一提交顺序109。

## 回滚

未提交时只逆向修改本批补丁；提交后用revert新增回退提交。不得覆盖用户数据库。删除与恢复码流程仅用隔离测试数据验收。
