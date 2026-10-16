# 界面真浏览器验收：A11 B04 B05 D03 / B06

该批在管理员/Modal 与 session/SW 批次落定后运行，不能把先前 mock React 测试当浏览器证据。只写 apps/web/tests/browser/ui-*、apps/web/tests/browser/sw-*、apps/web/tests/ui/**、apps/web/tests/sw/** 与本报告。可创建专用 runner config，不改 D01 package/lock/shared config、任何 product src、根锁或 core。无子代理，不提交/push。不读真实用户 profile/数据库/Key，不发真实模型请求。

使用已安装的 apps/web/tests Playwright、系统 Edge 或 Chrome，新建非持久 browser context；test Match *.browser.ts，配置端口隔离，不占生产 origin，trace off，若生成截图仅测试数据。fixture 必须 import 实际组件/实际 styles/实际 worker。MainChat/Composer/Modal 可用 React fixture 传最小固定 props，不能复制业务状态机或拦掉要验证的 effects。App rail 需要真实 App 新 context，必要时经 UI 初始化隔离世界；生产 db 名虽相同也仅处于新 context，不连接用户 profile。需要 helper 界面只在 tests 页放。所有进程/临时 DB 都明确清理，禁止递归删除计算未知目录。

## 必要用例

- A11：手机宽度右栏打开再左栏，只左栏显示；左→右只右栏；桌面两栏独立，两栏打开后变窄只保留左栏。真实 viewport/display 检查，不能只 class 判断。
- B04：实际 Composer Enter 在 disabled/busy/bridgeOpen 拒发且文本保留；正常桌面 Enter 可发，Shift/IME 不发；mobile coarse pointer Enter 换行，点击合法发送。MainChat/SideChat 能测 callback 与 bridge 保留者一并验。
- B05：用实际 MainChat 实际滚动容器和足量历史：跳旧原句后立即有“回到底部”，focus 消费清除不会回底；追加新消息变“有新消息”且不拉走；点回底/手动滚到底恢复跟随，后续 stored message 能跟底。重复定位同 id 新 seq、延迟节点、跨 conversation focus 不消费均验证。fixture controls 只增减 props，不模拟滚动效果。session 固定时序回归已有单测，浏览器不以 fake repository声称跨标签 CAS。
- D03：真实 Modal portal 只有一个 dialog/标题/close 控件，背景 inert、Tab/ShiftTab trap、Esc/遮罩/按钮经同 onClose，关闭还焦点到 trigger，场景关闭 flush 路径若可经实际 SceneDialog fixture 覆盖。Settings/Account 不重做。
- B06：实际同字节 worker 加新 HTML/manifest/static，成功受控导航后离线新 shell；旧 tab 懒模块保留、头像更新失败保旧；升级交错没有 pointer 回旧代。需要局部可切版本 HTTP fixture，worker 字节保持不变。fixture only，不能假称线上发布验收；当前现代 Chromium Web Locks 能力实际记录。

测试失败若是 product bug，先准确报告 root 并保留失败证据，不越界修改；root退回对应实施者。green后报告真实 browser 版本、命令、用例数量，能力限制。报告 docs/superpowers/plans/2026-10-03-ui-browser-report.md。

阶段实施裁定（2026-10-05）：可先仅准备并运行 A11/B04/B05 的 ui-* 实际浏览器 fixture，独占 tests/ui/**、browser/ui-* 和专用运行器；不做D03或SW（候选尚未落定），不改共享package/lock/config或production。端口使用127.0.0.1:6287 strictPort，fresh context仅测试素材和fake callbacks。原完整验收仍须后续Modal/session/SW落定后续跑；当前phase结果如实分列。

第二阶段准备（2026-10-05，前阶段fix1审阅已通过）：现在可准备D03 actual Modal/SceneDialog的ui-* fixture，仍只独占UI测试目录。管理员候选稳定前先写fixture/必要类型检查，不把暂态运行当最终证据；root通知稳定后运行真实浏览器并报告焦点、inert、portal、Tab/ShiftTab、Esc/遮罩/按钮与实际SceneDialog flush。B06/SW及B07最终导航联测继续后置。不得重做Settings/account或修改production。
