# B01 / B02 本地桥接实施要求

只改tools/local-bridge/**及本报告，不提交/push，不读浏览器凭据，不启动既有用户调试端口。无子代理。先node:test行为失败，再实现，正常访问控制/429/413与200 {text}协议保持。

## B01

基线server的任意最后message+3轮文本稳定会把旧assistant/user/停顿当完成。新逻辑必须在发送前captureBaseline，观察本次匹配prompt的新user身份，再认其后的新assistant身份；body非空、明确terminal且generating=false后稳定3轮仅去抖，才成功。
新site-adapter模块readSnapshot(call)返回{supported:true,messages:[{id,role,body,terminal}],generating}或{supported:false,reason}。节点复用/身份缺失、思考正文不能分开、明确终态/生成状态不能确认一律可读失败，绝不回退class包含message的最后文本。重复正文靠稳定id/顺序，基线不得识别为本轮。
当前没有真实DeepSeek已登录DOM证据，禁止凭猜测选择器声称兼容。实现严格语义适配契约：只接受页面具有可识别角色、稳定id、正文和明确结束状态的节点；未证实的DeepSeek返回“自动识别未验证，请使用手动回填”。保留--pattern选择页但说明它不能让不兼容页面自动受支持。可增加显式--adapter-profile受控JSON配置（只选择器/属性及真/假值，不可任意JS）以支持真实DOM验收后的配置，若范围复杂就先保留内建语义契约并将DeepSeek验收列待真浏览器。不偷偷发送后才发现unsupported，先读baseline确认适配与网页非生成。
2026-10-03 root经Cua只读打开真实chat.deepseek.com，落到sign_in且提示登录信息失效。未操作登录/凭据/发送，关闭检查页，0模型请求。因此本批缺真实对话DOM，并非Android真机验证；D08仍由用户之后处理。

## B02

createSerialQueue.run(task,{signal,deadline})从入队开始期限，队列超时移除且work未执行；每任务AbortController信号贯穿target fetch、WS握手/命令、轮询。命令pending包含resolve/reject/timer，CDP error、send抛错、close、error、abort、timeout都settle一次并清理Map/timer/listener。late response忽略。每次发送先检查signal。close/finally完成后才释放lease，不能Race返回而底层继续发送。
client response未完成就断开应abort。timeout含排队与全部阶段。health也有限期限。不能自动重发prompt。提交click发出但尚未确认的target标为uncertain，后续/ask拒绝直到用户关闭那个模型标签并新开独立标签（target id更新）或重启助手明确承担状态检查；健康提示说明处理。避免未结束上轮与下轮并发。发送完成后超时且页面仍生成同样uncertain；新请求baseline检查generating。
抽出deadline/CDP helper使node:test能注入fake WebSocket/fetch/scheduler，不需实际浏览器/模型。合理单命令上限取剩余deadline与可配置默认上限的较小值。

## 测试

B01：旧assistant/user稳定、assistant中途停6秒、同文新节点、空正文、节点复用、思考区、生成状态缺失/截断、未匹配本次user，都不得误报。明确terminal+稳定才通过。
B02：排队超时任务零执行，握手超时/error/close，命令无响应/send抛/CDP error，close与晚response竞争，client断开，未确认click后拒绝新请求；pending/active/timer清理且无后续发送。保留现policy.test。
更新README兼容契约、真实站点验收状态、恢复路径和timeout涵盖排队，不写真实主机；现授权来源程序值的调整不属C02，不擅改访问控制。

报告docs/superpowers/plans/2026-10-03-bridge-report.md，准确区分fixture通过与真实站点未验证，含red/green具体命令输出与关注点。
