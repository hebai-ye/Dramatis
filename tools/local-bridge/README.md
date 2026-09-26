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
| Origin | 默认放行 `https://dramatissync.com:8443`、`https://dramatissync.com`、`http://127.0.0.1:5273`、`http://localhost:5273`；其他来源 403，且不回任何 CORS 头 |
| 追加来源 | `--allow-origin http://127.0.0.1:4173,https://x.example` 或环境变量 `DRAMATIS_BRIDGE_ORIGINS`（逗号分隔） |
| 无 Origin | curl、本机脚本：Host 正确即放行 |
| 配对令牌（可选） | `--token xxx` 或 `DRAMATIS_BRIDGE_TOKEN=xxx`；设置后所有非预检请求须带 `Authorization: Bearer xxx`，否则 401。应用网页目前不发令牌，启用令牌只适合脚本调用 |
| 请求体 | 最大 1MB，超出 413 |
| timeoutMs | 夹在 5 秒到 600 秒 |
| 并发 | 同一时刻只跑一个 `/ask`，最多再排 2 个，再多回 429 |

## 9222 调试端口的风险

开着 `--remote-debugging-port` 的 Chrome，**本机任何进程**都能通过这个端口完全控制它：
读所有 Cookie 与登录态、打开任意网页、在任意标签页里执行脚本。本地助手的白名单
挡得住浏览器里的恶意网页，挡不住本机其他程序直接连 9222。所以：

1. 必须用独立的 `--user-data-dir`，**不要**用日常的 Chrome 配置；
2. 这个 Chrome 里只登录模型网页，不登录其他账号；
3. 用完即关这个 Chrome 和本地助手。

## 测试

```bash
node --test tools/local-bridge/policy.test.mjs
```

覆盖 Origin/Host/令牌校验、请求体与超时上限、串行队列，并真起本地助手、
假模型服务（C19 来源白名单）与桌面启动器（C20 端口校验）做集成验证。
