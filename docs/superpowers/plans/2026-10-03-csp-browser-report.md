# C05 enforced CSP 实际 App 浏览器验收准备（2026-10-07）

本轮交付隔离 Playwright 用例、固定非秘密素材、专用 runner。按用户最新要求，**未运行 test、typecheck、lint、build 或 smoke**；因此以下全部是“已编写、待 root 在最终候选上执行”，不是通过结论。没有使用旧 `dist` 充当最终候选。真实模型请求保持 0/48，真实费用 ¥0/5；未读取用户 profile、既有数据库或真实 Key，未提交、部署或切正式 CSP。正式仍 Report-Only。

## 入口和隔离

- `apps/web/tests/csp-run-browser.mjs`：root 刷新生产 `dist` 后设置 `CSP_FRESH_CANDIDATE=1` 再调用。专用 host 绑定 `127.0.0.1:6289`，通过现有 `createValidationHost` 为真正的 App `/` 注入测试 bootstrap 和 enforced CSP。`upstreamFetch` 强制抛错，真实上游不可调用；仅在 `apps/web/tests/csp/.local/fake-run-*` 初始化本次专用临时账本，finally 关闭子进程/host 并删除临时账本。
- `apps/web/tests/csp-playwright.config.ts`：系统 Edge、单 worker、无 trace/HAR/video/截图、无 retries、service worker 禁止。每个用例另开全新 context 并在 finally 关闭。上下文首先路由拒绝一切非 6289 外部请求，故 8791 桥接也无法连接。
- `apps/web/tests/csp/fake.ts`：只对精确 `https://csp-validation.invalid/v1/chat/completions`、且 Authorization 严格等于本次固定 dummy Key 的 browser fetch，在测试响应的 `/validation-bootstrap.js` 内放行；其它外部 fetch 仍由 bootstrap 拒绝，网络层也默认 abort。该唯一假 HTTPS 请求由 Playwright route 本地 fulfill，带固定 CORS；没有 DNS/第三方网络请求。测试修改的是隔离脚本响应，未修改生产 App、provider、host CSP 或正式 header。bootstrap 结构变化会让 fixture 抛错，要求重新审阅最小例外。
- `apps/web/tests/csp/fixtures.ts`：固定 1×1 PNG 背景、固定 JSON 卡和带 `chara` 元数据的固定 PNG 卡，均不含用户数据。

root 集中执行时使用：

```powershell
$env:CSP_FRESH_CANDIDATE = '1'
node apps/web/tests/csp-run-browser.mjs
```

该标志只防止误用旧 artifact，不证明 `dist` 新鲜；root 需先按其最终候选构建和冻结流程确认。6289 若被占用，host bind 失败且不碰账本，不应换用 6285。用例若失败，先判断是产品缺陷、fixture 假设或候选构建问题；C05 不越界修产品源码。

## 待执行矩阵

| 路径 | 准备的观察点 | 当前状态 |
|---|---|---|
| 真 App 主对话 SSE | UI 创建卡/世界，UI 保存 dummy BYOK，精确假 HTTPS SSE，角色回复 DOM + 刷新后落盘，统计全部假请求（含可能的意图/后台） | 已编写，未运行 |
| 真 App JSON 回退 | 请求仍带 stream，假端点返回 JSON，角色回复落盘 | 已编写，未运行 |
| 真 App 副对话 | 选中的主场景目标、发送、管理员回复 DOM，记录假请求 | 已编写，未运行 |
| 错误 | 假 HTTPS 429，可读错误、无落盘角色回复、页面错误不含 dummy Key | 已编写，未运行 |
| stop | 6289 host 的 fake slow SSE，按假请求/停止按钮事件同步，不等固定长 sleep；停止后刷新，不应有完整角色回复 | 已编写，未运行 |
| loopback | 同一 stop 用例的模型端点为 `127.0.0.1:6289/validation-api/v1`，检查 fake 账本和 real=0 | 已编写，未运行 |
| PNG/JSON 导入 | 真 App 左栏上传固定素材并在角色卡列表观察 | 已编写，未运行 |
| data 背景与 lazy 设置 | 设置内外观懒加载，上传固定 PNG，检查 App 的 data 背景变量和预览 | 已编写，未运行 |
| worker/blob CSP | 在真 App 文档里用同源测试脚本启动普通 Worker、解码本地 blob 图片 | 已编写，未运行；是策略探针，不声称 App 自身启动 dedicated Worker 或采用 blob 背景 |
| enforced CSP | 正常路径无新增违例，明确插入 inline script 应被阻止并记录 `script-src-elem`/`enforce`；错误 Key/其它 HTTPS 地址无假请求 | 已编写，未运行 |
| Low 工具多轮严格协议 | 假上游首轮带 `reasoning_content` + tool call，第二轮要求 assistant 原样回传；strict 用例现为 `test.skip` | 已准备 fixture，App provider/admin turn 当前未保留该字段，不能宣称通过 |

测试独立 fake HTTP 响应不是 DeepSeek 真实 BYOK 结果；每一条 fake 请求均按请求数组记录，不把主对话、后台意图或管理员多轮合并成一次。隔离 host 的真实模式即使误触也被 runner 的抛错 upstream 阻止，真实共享总账未初始化。测试在最终候选上跑通后，还需 root 结合 B06 的离线/同字节更新、真实 BYOK 共享预算验收，以及官方 Low 工具续传修复和复验，才能形成 C05 完整结论。

## 尚不可宣称

App 自身 dedicated Worker 初始化、PWA service worker 离线及更新、App 原生 blob 背景、真实 DeepSeek BYOK、真实 Low 工具多轮 `reasoning_content`、正式 CSP 切换与生产部署均未验。当前用例对 worker/blob 的判断只证明 enforced 候选策略允许相应浏览器能力。准备阶段未产生 green 证据；root 总测前不以源文件存在代替执行结果。

## 2026-10-08 root最终执行

最终实际production dist构建190模块并通过B03新鲜度/复用后，root集中执行此矩阵。首轮5项停在API Key exact可访问名、2项通过、1项已知skip；Key标签/桌面副对话入口与真实保存完成栏对齐后，又发现错误用例原假设“无任何角色行”与既有透明失败动作不符。未改产品或CSP，改为唯一精确action正文、无角色bubble/模型回复/原始错误/dummy、刷新同message ID的严格验收。最后保存栏状态动态strict冲突也以实际保存栏和已保存正文等待修补，没有sleep或取first。

最终 `logs/csp-browser-final-pass.log`：**7 passed / 1 skipped，22.6s，退出0**。SSE刷新落盘、JSON回退、副对话场景目标、429安全错误/透明动作、loopback停止、PNG/JSON/data背景与Worker/blob策略探针、enforced违例及精确dummy网络例外均通过。严格Low工具续传仍明确skip，归部分一产品协议缺口；不得用fake矩阵或质量shim替代真BYOK。独立Sol两遍增量复审PASS，无新增Important。

本矩阵真实请求为0；另一个6285质量页随后由用户发送1次真实样本，因budget-truncation停止，详见VALIDATION。正式CSP仍Report-Only，待验证（归 Codex），未提交或部署。该真实质量样本不属于真实App BYOK验收。
