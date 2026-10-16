# D02 Low 工具多轮协议适配补充

2026-10-05 root核对[官方思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)：带tools的后续请求必须完整回传此前assistant的reasoning_content，缺失将400。官方[价格/模型页](https://api-docs.deepseek.com/quick_start/pricing/)确认deepseek-flash对应V4.1-Flash，Low受支持；中文价格检索仍为高峰未命中输入2元/百万、输出8元/百万。

实际读取当前provider约340–350行及admin/turn约104–124行：它仅序列化role/content/tool_calls/tool_call_id，admin追加assistant不带reasoning_content。quality runner目前刻意不保存reasoning事件，所以拟定两轮真实管理员调用会有协议失败风险，不能先用付费请求试错。正式产品provider路径在禁区，不修改；把该兼容缺口交部分一，不声称App自身已支持Low多轮工具。

只允许原quality/**及必要validation-*和你自己的quality-csp-report/VALIDATION说明。修复仅为隔离D02 protocol shim，baseline/candidate用同一shim：完整reasoning只存本次run私有内存，按实际assistant/tool-call身份与顺序回传下一次实际wire；不得跨case/run混入、不得编造空串代替有内容的reasoning。兼容SSE分块与JSON回退；若历史含无法恢复的工具assistant协议内容，在发送前可读拒绝，而非真实400后重试。原production provider/两轮admin engine仍实际执行，shim明确是测试适配，不能归因成A09/A10改进。

所有导出/页面/总账/错误均不含reasoning_content，回传结束/异常/abort清理私有引用。实际wireHash包含实际完整body，脱敏导出hash对应删除reasoning后的body，wireRedacted准确说明差异。输入预留以加入协议内容后的完整wire字节计算，48/5与44质量上限不变，失败停止/不重试不变。不得读取Key或执行真实网络。

准备有内容的SSE多块与JSON的两轮fake案例，第二轮检查真实wire的对应reasoning完整相等；加跨run不泄漏及导出不含chain的断言。**2026-10-07用户新指令：子任务不运行测试/typecheck/lint/build/smoke；只实现与准备测试，root在多个功能完成后统一总测。**本补充不跑red/green或任何检查命令，仅报告修改/接口/预期中央用例和外部边界。

C05实际App未经shim的工具Low兼容仍待确认，不能用D02 shim证据替代真实App验证；正式CSP保持Report-Only，待验证（归Codex）。报告追加原quality-csp-report的Protocol节；不重冻巨大manifest，最终候选由root统一freeze/build。
