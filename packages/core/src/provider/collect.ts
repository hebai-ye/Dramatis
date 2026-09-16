import type { ChatMessage, ChatToolCall } from '../prompt/types.js';
import type { ModelParams, ModelProvider, TokenUsage } from './openai-compatible.js';

export interface CompletionResult {
  text: string;
  toolCalls: ChatToolCall[];
  /** 服务商返回的真实用量；没返回时为 null，不要用估算值顶替。 */
  usage: TokenUsage | null;
}

/**
 * 收集一次完整回复，包括它请求调用的工具。
 *
 * 副对话要走「调用工具 → 拿到结果 → 再说话」的循环，所以不能只收文本。
 */
export async function collectCompletionWithTools(
  provider: ModelProvider,
  messages: readonly ChatMessage[],
  params: ModelParams = {},
  signal?: AbortSignal,
): Promise<CompletionResult> {
  let text = '';
  let toolCalls: ChatToolCall[] = [];
  let usage: TokenUsage | null = null;

  for await (const event of provider.chat([...messages], params, signal)) {
    if (event.type === 'text') text += event.text;
    if (event.type === 'done') {
      if (event.toolCalls !== undefined) toolCalls = event.toolCalls;
      if (event.usage !== null) usage = event.usage;
    }
  }

  return { text, toolCalls, usage };
}

/**
 * 把流式响应收成完整文本。
 *
 * 后台任务（记忆抽取、状态更新）不需要增量输出，但共用同一套 provider
 * 更省事，也不必为它们各写一个非流式实现。
 */
export async function collectCompletion(
  provider: ModelProvider,
  messages: readonly ChatMessage[],
  params: ModelParams = {},
  signal?: AbortSignal,
): Promise<string> {
  const { text } = await collectCompletionWithTools(provider, messages, params, signal);
  return text;
}
