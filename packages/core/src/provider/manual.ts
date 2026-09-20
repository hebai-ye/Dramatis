import type { ChatMessage } from '../prompt/types.js';
import type { ChatStreamEvent, ModelParams, ModelProvider } from './openai-compatible.js';

/**
 * 「不联网」的模型：只让装配器把提示词跑出来，一个 token 都不产出。
 *
 * 用途只有一个——**网页版桥接**：没有 API Key 时，`runTurn` 仍然照常装配提示词
 * （世界书命中、记忆召回、预算守卫、视角裁剪全都会发生），但真正生成的那一步
 * 交给人：应用把提示词交给用户，用户贴进 DeepSeek 网页版，再把回复粘回来。
 *
 * 为什么要做成一个 provider 而不是在界面上另走一条分支：提示词的装配路径**只有一条**。
 * 另写一条「生成提示词」的支路，迟早会和真正发出去的那份不一样——而「贴进去的
 * 提示词就是应用会发出去的那份」正是这条路唯一的价值。
 */
export function createManualProvider(model = 'manual'): ModelProvider {
  return {
    id: 'manual',
    model,
    async *chat(
      _messages: ChatMessage[],
      _params?: ModelParams,
      _signal?: AbortSignal,
    ): AsyncIterable<ChatStreamEvent> {
      yield { type: 'done', usage: null };
    },
    async listModels(): Promise<string[]> {
      return [];
    },
  };
}
