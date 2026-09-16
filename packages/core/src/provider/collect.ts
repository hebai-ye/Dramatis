import type { ChatMessage } from '../prompt/types.js';
import type { ModelParams, ModelProvider } from './openai-compatible.js';

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
  let full = '';

  for await (const event of provider.chat([...messages], params, signal)) {
    if (event.type === 'text') full += event.text;
  }

  return full;
}
