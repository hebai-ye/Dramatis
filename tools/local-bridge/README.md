# 本地助手（local-bridge）

用 Chrome 调试端口驱动你自己已经登录的模型网页标签页，让桥接面板一键发送。
不是官方接口，默认不用。

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%TEMP%\dramatis-deepseek https://chat.deepseek.com
node tools/local-bridge/server.mjs --port 8791
```

## 访问控制

| 项 | 规则 |
|---|---|
| Host | 只接受 `127.0.0.1:PORT` / `localhost:PORT`，其余 403（挡 DNS rebinding） |
| Origin | 默认放行 `https://app.example.com:8443`、`https://app.example.com`、`http://127.0.0.1:5273`、`http://localhost:5273`；其他来源 403，且不回任何 CORS 头 |
| 追加来源 | `--allow-origin http://127.0.0.1:4173,https://x.example` 或环境变量 `DRAMATIS_BRIDGE_ORIGINS`（逗号分隔） |
| 无 Origin | curl、本机脚本：Host 正确即放行 |
| 配对令牌（可选） | `--token xxx` 或 `DRAMATIS_BRIDGE_TOKEN=xxx`；设置后所有非预检请求须带 `Authorization: Bearer xxx`，否则 401。应用网页目前不发令牌，启用令牌只适合脚本调用 |
| 请求体 | 最大 1MB，超出 413 |
| timeoutMs | 夹在 5 秒到 600 秒 |
| 并发 | 同一时刻只跑一个 `/ask`，最多再排 2 个，再多回 429 |

`timeoutMs` 从进入串行队列时开始计时，覆盖排队、CDP 目标发现、WebSocket 握手、每条命令和回复轮询。`/health` 的目标发现限时 5 秒。客户端在响应完成前断开会取消工作；正常读完请求体不会取消。正在执行的任务完成取消清理后才释放队列名额。

CDP WebSocket 由本地助手启动的独立 Node 子进程持有，无额外依赖；提示词只经进程内存与 IPC 传递，不写入日志。正常关闭会等待子进程退出；关闭卡住超过 1.5 秒时只终止本次助手创建的子进程并等待退出，然后才释放队列名额。这个清理阶段可能让错误响应晚于 `timeoutMs`；实际时长还取决于子进程退出时间。

## 页面兼容契约与当前状态

自动发送要求网页显式提供以下语义标记：`[data-local-bridge-root]` 及其布尔值 `data-generating`；每条 `[data-local-bridge-message]` 的稳定 `data-message-id`、`data-role=user|assistant`、布尔值 `data-terminal` 和独立的 `[data-local-bridge-body]`；`[data-local-bridge-composer]` 文本框与 `[data-local-bridge-send]` 按钮。思考区不能混入正文。桥接先读取基线，确认页面受支持且没有上一轮生成，再填写并点击；只接受本轮匹配 prompt 的新 user 后面、有新身份、正文非空、明确终态且网页未生成的 assistant。三轮稳定只用于去抖。身份消失、复用、消息截断或状态不明都会失败并提示手动回填。

目前尚无已登录的真实 DeepSeek 对话 DOM 证据，内建契约只是可测试的语义 fixture，**不能声称真实 DeepSeek 自动发送可用**。只读检查曾落在登录页，没有登录、读取凭据或发送模型请求。需要在用户自己的独立调试标签里验收真实对话页后，再增加经验证的适配器。`--pattern` 只选择目标标签，不能让未适配的网页自动受支持。遇到“自动识别未验证，请使用手动回填”时，应走应用中的手动回填流程。

首次写入输入框的命令已发出但确认丢失、点击发送未确认，或等待回复时超时，桥接会按目标 ID 保留不确定状态并拒绝该标签的后续 `/ask`，以免重复发送。访问另一个标签不会解除旧标签的锁；新标签失败也会独立锁住。关闭旧模型标签并新开一个独立标签（目标 ID 更新）后可重新尝试；先检查模型网页里是否已有上次回复。重启本地助手会清除本机标记，使用前仍须人工检查网页状态。

## 9222 调试端口的风险

开着 `--remote-debugging-port` 的 Chrome，**本机任何进程**都能通过这个端口完全控制它：
读所有 Cookie 与登录态、打开任意网页、在任意标签页里执行脚本。本地助手的白名单
挡得住浏览器里的恶意网页，挡不住本机其他程序直接连 9222。所以：

1. 必须用独立的 `--user-data-dir`，**不要**用日常的 Chrome 配置；
2. 这个 Chrome 里只登录模型网页，不登录其他账号；
3. 用完即关这个 Chrome 和本地助手。

## 测试

```bash
node --test tools/local-bridge/*.test.mjs
```

覆盖访问策略、严格快照、队列期限、CDP 断线与命令失败、客户端断开和目标锁定；现有集成测试真起本地助手、假模型服务与桌面启动器。真实模型站点尚未验收。
