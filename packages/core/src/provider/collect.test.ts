import { expect, it } from 'vitest';
import { collectCompletionWithTools } from './collect.js';
import type { ModelProvider } from './openai-compatible.js';

it('reasoning 只通知实际分块，不进入正文或额外请求', async () => {
  let calls = 0;
  const provider: ModelProvider = {
    id: 'fixture',
    model: 'fixture',
    async *chat() {
      calls++;
      yield { type: 'reasoning', text: '先' };
      yield { type: 'text', text: '正文' };
      yield { type: 'reasoning', text: '后' };
      yield { type: 'done', usage: null };
    },
    async listModels() {
      return [];
    },
  };
  const reasoning: string[] = [];
  const result = await collectCompletionWithTools(provider, [], {}, undefined, undefined, (event) =>
    reasoning.push(event.delta),
  );
  expect(reasoning).toEqual(['先', '后']);
  expect(result.text).toBe('正文');
  expect(calls).toBe(1);
  expect(result).toEqual(await collectCompletionWithTools(provider, []));
});
