# Codex Windows 工具运行时故障记录

2026-10-09。诊断记录；尚未恢复，不代表项目代码测试失败。没有上传诊断或读取 Key。

最新决定：用户要求停止初始化排障，尝试重新获取 Computer Use 后继续项目。官方CLI `plugin add computer-use@openai-bundled --json` 退出0，随后列出installed/enabled=true，bundled版本26.1002.52244不变；不宣称插件列表显示、远程新版下载或控制能力恢复。此前官方MSIX有界元数据读取在ZIP64计数标记处停止（exit1），未安装包或执行payload；不继续该调查。6285离线，账本仍1次/¥0.01213，不等待Key窗口，未新增真实调用。本页后文保留历史证据，后续项目见[26项收口矩阵](./2026-10-09-ui-bridge-ops-closeout.md)。

## 环境与症状

- 应用内部版本 `26.1002.52244`，build `13536`，channel `prod`；Windows 注册包 `OpenAI.Codex` 的包版本为 `26.1002.7124.0`。两套版本字段不直接比较大小。
- 已安装 CLI `0.162.0-alpha.2`。用户报告插件列表不再显示 Computer Use；本地两项相关插件配置仍为 enabled，当前会话仍提供 Cua 工具。不能仅由本地配置推断 UI、账户可用性或管理策略。
- 默认 shell 的无副作用命令在创建进程阶段失败：`helper_unknown_error: setup refresh had errors`。
- Cua reset 后第一次 `getState()` 也在 kernel 初始化阶段退出 1，尚未访问浏览器页面。
- 安全筛选后的沙箱日志指出，刷新运行时 `%LOCALAPPDATA%/OpenAI/Codex/runtimes/cua_node/3dd31cfff853001c/bin/node_repl.exe` 的 root-only ACL 时返回 Windows `os error 32`（文件被占用）。文件存在，原 ACL 已有 `CodexSandboxUsers` ReadAndExecute。

## 已尝试及结果

| 步骤 | 实际结果 |
| --- | --- |
| 当前 Cua/通用 kernel reset | 未恢复；未杀共享工具进程 |
| 用户完整退出并重新打开应用 | 新父进程已核验；default shell/Cua 仍失败 |
| 当前 CLI 导出标准公开 schema | `windowsSandbox/readiness`、`setupStart`、`setupCompleted` 确实存在 |
| 独立 stdio 公开 readiness | `ready`，自身 server 正常关闭；与实际创建进程失败并存 |
| 一次官方 `setupStart(mode=elevated)` | 响应 started=true；收到合法完成通知 success=false、setup refresh error；后续 readiness 仍 ready，default shell 仍失败 |
| 应用只读更新检查 | unavailable；Store 资格检查可能下载，因此未执行；不是 up_to_date |
| 用户随后授权 Store 检查/下载 | WinGet 官方源未返回 OpenAI Codex 的精确产品；未选同名第三方记录、未下载更新 |
| 打开已安装包 PFN 对应 Store 页 | 用户反馈只有“打开”，没有更新；不据此宣称全局最新版 |
| 一次定点工具进程回收 | 核验 executable/start-time/父链后仅回收两个 kernel；DLL 占用 census 后仅回收一个 app-owned swift helper；实际默认命令仍失败，ACL 目标回到 node_repl；停止继续追杀 |
| 临时关闭工具宿主的公开只读预检 | 独立 server readiness=ready、自身 exit0；两次 descendant census 的 runtime/known helper/unknown path 均0；未执行第二次 setup |
| 用户完成离线静止窗口配置 | package/CLI/runtime计数降至0，合法elevated completion success=true，自有server正常exit0；账本前中后固定SHA保持 |
| 离线成功后的实际重开复验 | default shell仍在创建进程前失败；Cua reset后getState kernel退出1；15:49:41新日志仍是node_repl.exe/root-only ACL/os32；未新增回收进程或重复setup |
| 官方修复归属 | PR51822已于10月7日合并，机制与症状吻合；尚无已验证包含此修复的desktop/Store版本映射 |
| 精确官方Store产品核对/仅下载 | ChatGPT9PLM9XGG6VKS就是本机26.1002.7124.0；download-only因管理员环境要求失败、无文件、无安装；官方MSIX仅准备读取元数据 |

## 当前保全状态

离线脚本这次退出后，6285再次离线；不能继续以此前locked状态代替在线核验。原账本最新只读SHA仍270e...，计账基线1/48、quality1/44、¥0.01213。未再次initialize/recovery、重发首条、退款或新增模型调用，也未为当前故障反复启动host。下列是这次退出前的历史保全步骤。

原 host 随旧 exec session 退出。核验死 owner PID、端口空闲、完整 hash 链和已知原字节后，保留旧锁及账本副本，仅以既有4096 profile普通重启。新 host PID46992 的 lock/loopback归属一致，mode=locked、busy=false；计账仍1/48、quality1/44、¥0.01213。Node逐字节比较确认 journal未变；PowerShell读取活动文件hash的共享失败未算作通过。

正式CSP保持Report-Only，C05待验证（归 Codex）。本聊天 Native APIs disabled 是独立边界，不能将浏览器恢复推定为通用桌面控制恢复。

## 下一步与验收

离线脚本已成功完成，实际重开后Cua transport可reset、kernel仍初始化失败。对应旧源码每次refresh均递归runtime文件，先以MAXIMUM_ALLOWED打开再核验既有ACL；官方[PR51822](https://github.com/openai/codex/pull/51822)明确修复活跃EXE/DLL引起的共享冲突。现有证据与这个已知缺陷高度一致，但未证明安装helper与源码二进制相同。下一步是核对包含修复的正式应用包，不再重复setup、重启循环或追杀运行时。

不要替换二进制、手改ACL、降级沙箱或清空账户/插件/聊天数据。修复以重新打开后的实际默认命令成功、Cua内置浏览器初始化及页面可读、账本和预算不变作为证据，不能只接受 readiness 或 setup started。插件列表缺失的原因尚未确定，也不能由 browser 成功推断插件 UI 已恢复。

公开流程依据：[OpenAI Docs Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)、[App Server setup](https://learn.chatgpt.com/docs/app-server#windows-sandbox-setup-windowssandboxsetupstart)、[Computer Use](https://learn.chatgpt.com/docs/computer-use)。报告未包含原始环境变量、setup命令日志、auth文件、.sandbox-secrets、Key、个人对话或浏览器profile。
