import { expect, it } from 'vitest';
import type { ModelProvider } from '../provider/openai-compatible.js';
import { type AdminTurnEvent, type AdminTurnObservation, runAdminTurn } from './turn.js';

function provider(): ModelProvider {
  let request = 0;
  return {
    id: 'fixture',
    model: 'fixture',
    async listModels() {
      return [];
    },
    async *chat() {
      yield { type: 'reasoning', text: `思考${request}` };
      yield { type: 'text', text: '正文' };
      yield {
        type: 'done',
        usage: { promptTokens: 2, completionTokens: 1 },
        toolCalls:
          request++ < 2
            ? [{ id: 'call_0', type: 'function', function: { name: 'set_scene', arguments: '{"location":"露台"}' } }]
            : [],
      };
    },
  };
}
it('两次相同 callId 按请求分段，开始仅由执行者确认且观测不影响旧结果', async () => {
  const observed: AdminTurnObservation[] = [];
  const events: AdminTurnEvent[] = [];
  for await (const event of runAdminTurn(provider(), [], {
    execute: async (_draft, observation) => {
      observation?.markStarted();
      observation?.markStarted();
      return '已保存';
    },
    onObservation: (event) => observed.push(event),
  }))
    events.push(event);
  expect(observed.filter((e) => e.type === 'reasoning').map((e) => e.requestIndex)).toEqual([0, 1, 2]);
  expect(observed.filter((e) => e.type === 'tool-start').map((e) => e.requestIndex)).toEqual([0, 1]);
  expect(events.at(-1)).toMatchObject({
    type: 'done',
    text: '正文正文正文',
    calls: 3,
    usage: { promptTokens: 6, completionTokens: 3 },
  });
});
it('观测异常不影响工具，停止只保留已开始项而不再发请求', async () => {
  const abort = new AbortController();
  let executions = 0;
  const events: AdminTurnEvent[] = [];
  await expect(
    (async () => {
      for await (const event of runAdminTurn(provider(), [], {
        signal: abort.signal,
        execute: async (_draft, o) => {
          o?.markStarted();
          executions++;
          abort.abort();
          return '已保存';
        },
        onObservation: () => {
          throw new Error('UI');
        },
      }))
        events.push(event);
    })(),
  ).rejects.toThrow();
  expect(executions).toBe(1);
  expect(events).toMatchObject([{ type: 'text' }, { type: 'tool', execution: { ok: true, result: '已保存' } }]);
});
it('参数被拒不产生执行开始', async () => {
  const p = provider();
  p.chat = async function* () {
    yield {
      type: 'done',
      usage: null,
      toolCalls: [{ id: 'bad', type: 'function', function: { name: 'unknown', arguments: '{}' } }],
    };
  };
  const observed: AdminTurnObservation[] = [];
  for await (const _ of runAdminTurn(p, [], {
    execute: async () => {
      throw new Error('should not execute');
    },
    onObservation: (e) => observed.push(e),
  })) {
  }
  expect(observed.filter((e) => e.type === 'tool-start')).toHaveLength(0);
  expect(observed.filter((e) => e.type === 'tool-end')).toHaveLength(2);
});
