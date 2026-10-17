# 独立复核与修复对应

范围为 `build/world-admin-process/changed-files.txt` 所列本批文件，相对原候选工作树逐文件比较；不把继承的未提交修改纳入本批评价。复核只读、没有修改工作树。原结论：**需修改后再通过**；无 Critical，5 项 Important、1 项 Minor。

| 独立发现 | 修复与验证 |
| --- | --- |
| Important：A 运行中切 B，结束后回 A 恢复旧 busy，停止无效 | 来源失效时清理对应 UI busy/canStop；旧 run 可收结自己的终态，不能发布到新来源。`A 结束前切 B，结束后回 A 不恢复旧 busy` RED→GREEN |
| Important：同一 SideChat 实例切来源仍读取旧 admin stream | 来源交接立即清旧流，旧 finally 保持所有权守卫；测试同时验证 A 正文隐藏和迟到结束不清 B 新流，RED→GREEN |
| Important：StrictMode cleanup 将 mounted 置 false，setup 未恢复 | setup 明确恢复 mounted，cleanup 继续递增 generation；等价 effect 重放的助手完成反例 RED→GREEN |
| Important：saveScene 后 saveConversation 失败被工具 catch 吞为普通 partial | 正常结束路径也检查 activeLinked=false，标 uncertain 并保留场景写入证据；只读核对同时验证消息和场景关联。真实 hook 反例 RED→GREEN |
| Important：API unknown 无只读入口，下一轮隐藏未确认输出 | 按来源保留预分配 outputId；未决结果阻止发送，界面保留正文/草稿。inspectRun 只读原消息及关联，不调用模型或 execute；回执丢失恢复反例 RED→GREEN |
| Minor：冲突草稿成功丢弃仍返回 blocked | conflict 分支限定 adopt；discard 按 discarded 状态确认。按用户实际影响作为错误状态修复，RED→GREEN |

修复证据：`review-red.log`、`review-busy-red.log`、`review-green.log`、`review-all-green.log`；后者相关 40 项通过。最终全量门禁见实施记录。这里的“修复后通过”是实施者的回归验证，未进行第二轮独立审查，不改写原审查结论。

复核明确未判定：未查明写入来源的 resize 后指纹失效、清单外的继承候选修改、真实设备/读屏/IME/浏览器全矩阵。实施者随后观察到合成验收中可见主对话数减少，重新准备后合法桥接成功；没有据此改动原来源指纹规则。

首轮启动因模型额度失败，用户续办后完成审查。随后用户禁止团队使用 GPT-6 Astra；此后没有再调用该模型。

## 提交部署前的主线整合复核

用户 2026-10-16 授权提交及部署后，合并了最新 `origin/main`。两次独立复核均明确指定 **GPT-6.1 Sol** 并只读执行，未使用 GPT-6 Astra。

首轮发现 1 项 P1、2 项 P2，分别为部分场景写入后继续执行、来源切换丢失未保存草稿、旧回执覆盖同步后的新草稿状态。实际回归用例先复现失败，再逐项修复；另验证只读核对已知未关联场景时不再写入。相关 19 项回归通过。

后续定向独立复核结论为：这三项在其复核范围内已解决，没有剩余具体阻断项。该复核只读，未独立运行测试；完整测试、类型、Lint 和构建由实施者重新执行。详细集成规则与发布证据见 `WORLD-ADMIN-RELEASE-2026-10-16.md`。
