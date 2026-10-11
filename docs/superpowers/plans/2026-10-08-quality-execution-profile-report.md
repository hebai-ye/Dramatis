# Quality 执行 profile 增量（2026-10-08，待集中验证）

用户已选择后续执行使用 4096，保留历史 1200 截断样本与总账。本子任务仅接入隔离 quality runner、页面与证据导出；未启动真实页面、读取 Key、发送请求或修改账本。历史 fixtures、presentation、manifest、baseline 与产品 core 均未修改。

`runFixture` 第五参数接受 `{ executionProfile, requireServerEvidence }`。省略 profile 时仍执行 `deepseek-flash-low-output-1200-v1`；批准的新组合为 `deepseek-flash-low-output-4096-v1` / `4096` / `deepseek-flash` / `low`。不支持的 ID、上限、模型或 effort，以及 ID 与上限不一致均在发送前拒绝。provider 注入、管理员 `maxTokens` 与普通请求 `maxTokens` 使用同一配置，历史 requestHash 原值保留。

页面先校验 `status.executionProfile`，明确显示服务器 profile 与实际上限，缺失或不支持时禁用发送。调用前再次读取 status 并校验；两侧管理员仍选择各自 engine，但共用执行配置。页面要求成功响应包含完整且匹配的三个 header：`x-validation-execution-profile`、`x-validation-max-output-tokens`、`x-validation-upstream-wire-hash`。任何 4096 runner 调用也强制该要求。旧 1200 独立 fake 测试允许完全缺失 metadata，不伪造已观察的 upstream 摘要。非 OK 响应可能尚未上游发送，沿用 provider-error 处理，不要求其凭空提供 upstream hash。

每轮新增独立 `executionProfile` 与服务器报告的 `upstreamWireHash` / 含义。upstream 摘要为实际 `JSON.stringify` 序列化输出的 UTF-8 字节的 SHA256。原 `wireHash` 仍是完整 client JSON 规范摘要，`exportedWireHash` 是脱敏 client JSON 可复算摘要。三者可能不同；upstream 摘要不会从 client 摘要猜测。私有协议链只保留传输期内存，导出不含 chain、Key 或 Authorization；configuration 中 Low/thinking 继续保留。总账下载保留服务器 status 的 `checkpointHash`，页面同步显示该摘要。

原页面按 real blindId 的重复发送 guard 保留；本增量没有写入旧 B001 或解除停止锁。新页面盲号重新随机生成，root 必须用下载的私有映射定位 `affect-1 / shared / repeat2` 并跳过历史已发送样本。48 次 / ¥5、质量 44 次及 C05 保留 4 次不变。

已先准备增量测试，再实现接口；依用户要求，本子任务不运行 test、types、lint、build、smoke、freeze 或任何请求。需要 root 集中验证：

- `execution-profile.test.ts`：不合法 profile、缺失或不匹配 header、无效 digest、1200 兼容，以及非 OK 拒绝处理。
- `provider.test.ts` 增量：供应 engine 与默认 candidate engine 的两轮 4096 wire 一致，非管理员 4096 实际 wire，原 1200 wire 原结构，历史 requestHash 保留，独立 upstream/client 摘要、脱敏摘要可复算与 no-chain 导出。
- `context.test.ts` 增量：评分下载保留执行与 upstream 证据，同时删除私有链及 Key。
- root 的集中 build/fake 集成还需覆盖虚拟 frozen baseline engine 与服务器 metadata 契约；这里的供应 engine 单测使用真实 core 管理员实现的显式供应路径，没有声称已运行 frozen baseline 集成。

状态：实现与增量测试已准备，未运行、未付费，不能据此声称验证通过或真实质量已完成。

## Root 集中验证续记

以上为子任务交付时状态。root的quality专用5文件50项通过，独立tsc退出0；随后集中构建27模块通过，`logs/quality-profile-build-final.log`，增强Edge fake smoke通过，`logs/quality-profile-smoke-final.log`。4096自有浏览器helper正常/停止/指令损坏演练均保存可校验证据；停止两例保留aborted行并完成锁定、清Key、关闭自有浏览器。fake启动失败与真实6285 state前后逐字段相同。所有演练真实调用0、费用0；原1200冻结baseline不变。不能把这些结果称真实模型评分或C05真BYOK验收。
