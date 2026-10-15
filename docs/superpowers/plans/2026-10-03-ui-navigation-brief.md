# A11 / B04 / B05 实施要求

基线4c5169a，用户已批准Q2A/Q3A；本轮代码可改，禁止提交/push。
只改App.tsx、components/**、styles.css、lib/admin.ts及报告。不要修改其他lib、core或根清单/锁。先以行为测试固定失败，再实现；低影响一行修复不写源码字符串断言。

## A11

手机左栏打开时必须关闭右栏，关闭左栏不应关闭右栏。右栏打开关闭左栏。桌面两侧独立。桌面双开缩为窄屏时保留左栏、关闭右栏，不引入最近打开状态。修正App.handleToggleRail的opening条件，并覆盖窄屏状态收敛。

## B04

Composer的Enter发送与按钮条件统一：disabled/busy/bridgeOpen/空内容都不能发送，IME、Shift+Enter和粗指针仍保留换行。MainChat.submit、SideChat.submit都在bridgeOpen时不清空输入不调用发送。admin.send的busy守卫也包含待回填桥接，不能reset旧桥接。
测试可以用现有React mock harness读取JSX回调并实际调用，不做grep；需验证输入保留与API桥接状态保留。必要时新测试在components下，不扩写禁区。

## B05

把跳原句请求与离底状态分开。定位成功立即出现“回到底部”；后续新消息保持旧位置，按钮变“有新消息”；点击回底或手动滚到底清除状态并恢复普通/流式跟随。focus是一次请求，成功消费时按seq清除，不能永久suspend。不要因清focus effect又拽到底；定位效应用对话范围查节点，支持同id重复seq、跨对话/延迟节点，切对话清掉旧离底状态。定位尚未找到节点时等待messages变化；请求被切走后不得异步跑回原对话。
必要接口MainChat.onFocusConsumed(request)在App比较当前seq后清除；StreamingBubble suspend按离底状态而非残留focus。
关键测试：定位第3/20条→立即回底；append21保位且提示新消息；回底恢复stream；同id重新定位；未出现节点随后出现；对话切换。以可验证行为为准，真正DOM滚动将在D01真实浏览器补测，不声称SSR模拟真浏览器。

## 报告

写docs/superpowers/plans/2026-10-03-ui-navigation-report.md，含文件/接口、red与green命令及结果、未覆盖真浏览器项、关注点。测试使用pnpm --filter @dramatis/web test -- <具体文件>及typecheck；不要重跑全仓基线，无需新依赖，不spawn子代理。
