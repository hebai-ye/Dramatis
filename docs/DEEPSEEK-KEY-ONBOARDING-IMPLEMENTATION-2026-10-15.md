# DeepSeek Key 首次配置实施记录

日期：2026-10-15（Asia/Shanghai）。本批已实现并完成验证，全部保留为未提交改动；未推送、部署或调用真实模型。

## 交付行为

- 首次加载完成并确认缺少 Key 后，自动显示“配置 DeepSeek API Key”。唯一可输入配置为 Key；不展示地址、模型、保存方式、价格或高级参数。
- 提供官方申请链接、显示 / 隐藏 Key、“保存并继续”和“稍后配置”。空值不能提交；重复点击只保存一次。
- 已有可读 Key 不重复提醒。读取中显示等待；读取失败与密钥库锁定提供恢复入口，不冒充缺少 Key。
- 保存失败保留输入。保存后等待同一目标的 Key 读取确认；读取失败可重新读取，无需重复创建配置或重复保存。
- 沿用现有 device / session / encrypted 保存方式；加密库已解锁时不重复索取口令。弹窗如实展示存储方式及调用费用提示。
- 当前配置为 DeepSeek 时保留已有参数；其他服务商使用独立 DeepSeek 目标，不覆盖原 Key 或配置。
- 现有弹窗、桥接、恢复流程和素材库编辑优先；占用解除后显示排队提示。稍后配置只在本次访问内抑制同一配置的自动提示，聊天区可手动重开。
- 保存与关闭不发送聊天草稿。保留原有焦点恢复、busy / dirty 守卫及聊天转接行为。

## 工作区与变更范围

执行工作区：`C:/Users/35350/.codex/worktrees/deepseek-key-onboarding-20261014/another life`。

基底：`427dcf056149f499312f385e8652207371234d7a`，保持 detached HEAD。已通过原生 worktree 工具附加到当前聊天。

起点为 `C:/Users/35350/.codex/worktrees/ui-optimization-20261012/another life` 的最新未提交候选。666 个源文件已复制并记录 SHA256；收尾核对原候选 666 个文件全部未变。桌面旧源码未用作实现起点。

相对候选，修改 8 个已有源码 / 测试 / 样式文件，新增 6 个源码 / 测试文件。核心文件为 `providers.ts`、`deepseek-setup.ts`、`DeepSeekKeyDialog.tsx`、`useDeepSeekSetup.ts`、`App.tsx`、`MainChat.tsx`、`LibraryWorkspace.tsx`。完整列表见 `build/deepseek-key-onboarding/delivery-changes.json`。

本批只实现 Key 前置配置和相邻聊天入口；示例角色、统一文件导入及其余逐页文案不属于本批交付。未修改核心生产策略、数据库结构或账目语义。

## 评审与修复

独立只读评审覆盖本批差异，发现的问题均在修复轮次处理：

1. 新建目标后读取失败会导致旧 owner 禁用重试：保留目标回执和输入，提供只重新读取的入口。
2. 同 ID 配置地址变化可能误写 Key：owner 绑定地址与账户 / 存储上下文；异步边界核对持久化来源及目标；发生归属变化时条件恢复本次写入的 Key 和凭据版本，不覆盖更新的写入。配置激活使用现有 Repository 事务。
3. 手动入口在慢读取期间可能显示空表单：等待读取，读到已有 Key 后关闭未编辑提示。
4. 素材库关闭未触发 App 更新，排队弹窗可能滞留：Provider 将占用状态响应式回报 App。

补充覆盖迟到的凭据对齐读取，防止中止后的 Key 再次被写入凭据。RED / GREEN 日志保留在证据目录。

## 验证结果

最终命令均退出 0：

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过；仅原有 5 条 `sync-panel-ui.test.tsx` 非空断言警告 |
| `pnpm test` | 2108 项通过：core 1350、web 575、sync admin / server 168、local bridge 15 |
| `pnpm build` | 通过 |
| `git diff --check` | 通过 |

复制候选的基线为 2066 项通过。最终新增覆盖 42 项。构建入口为 `index-BWqSOxAk.js`，463.46 kB；本批不宣称性能改善。

日志：`build/deepseek-key-onboarding/{test,typecheck,lint,build}-final.log`；基线、各任务 RED / GREEN、评审修复及素材库回归日志同目录保留。

浏览器使用最终构建和全新本机 origin `http://127.0.0.1:19725/`，检查桌面 1280×720 与窄屏 360×780：首弹、唯一输入、官方链接、空值禁提交、稍后配置、手动重开、无效格式保稿、放弃守卫、合成 Key 保存及刷新不再提示。窄屏弹窗宽度 328px；视口验证后已恢复。

桌面截图：`C:/Users/35350/.codex/visualizations/2026/10/14/01a13932-4b6c-7751-8dad-44d8168531ac/deepseek-key-desktop.png`。

窄屏截图：`C:/Users/35350/.codex/visualizations/2026/10/14/01a13932-4b6c-7751-8dad-44d8168531ac/deepseek-key-mobile.png`。

代理验收保存只用合成 Key；真实 API 有效性、付费请求及真实账户网络同步未执行。加密保存和凭据并发路径使用本地真实存储 / WebCrypto 与受控 I/O 回归验证，不宣称连接服务商成功。临时验收 origin 19725 在验收后停止；既有、正在使用的本机预览 `http://127.0.0.1:19724/` 保留，未操作其会话内容。工作区与证据保留。

## 2026-10-15 授权发布准备

用户随后明确要求“push及部署”，替代先前保留未提交状态的限制。发布分支为 `codex/deepseek-key-onboarding-release-20261015`；已保存原候选提交 `fe8c751`，再整合实际 fetch 得到的 `origin/main`：`356e7268095e1792619c0a06f80da276fae441db`。上游已上线的来源 / 目标守卫、场景部分完成结果、导入恢复告警、PWA 与本地助手改动、最新 README 均保留。

冲突整合包括管理员明确目标与草稿接受回调、定位读取完成标记与阅读暂停、场景保存目标、弹窗焦点及会话请求顺序。保留并修复预算刷新与新快照并发的回归，未削弱旧预算身份断言。独立只读审查未发现确定的 P1/P2 合并回归。

最终集成门禁：`pnpm test` 完整 2293 项通过（core 1371、web 710、sync admin/server 168、local bridge 44）；typecheck、lint、web/admin/sync-server 构建与差异检查均通过，lint 仍仅原有 5 条警告。上游独立测试目录的 4 个包按既有锁文件安装，CI 同步增加该目录的 frozen install；未变更依赖版本或根锁文件。最终入口为 `index-Cw7fJkf1.js`，480779 B。

本次仅发布静态前端；后台、配置、服务与用户数据库保持原部署。发布器复用既有上线脚本，保留旧目录及旧哈希资源，并校验同步健康与六服务 PID。切换结果及远端 ref 验证将在实际完成后补记，不能把本节准备状态当作已上线。
