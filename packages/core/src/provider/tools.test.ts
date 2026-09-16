import { describe, expect, it } from 'vitest';
import { createOpenAICompatibleProvider } from './openai-compatible.js';

/** 造一个假的 SSE 响应，看看工具调用的片段有没有被正确拼起来。 */
function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`).join('');

  return new Response(`${body}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function providerReturning(chunks: unknown[], seenBody: { value: Record<string, unknown> | null }) {
  return createOpenAICompatibleProvider({
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    fetchImpl: async (_input, init) => {
      seenBody.value = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse(chunks);
    },
  });
}

describe('工具调用', () => {
  it('把流式返回的 tool_calls 片段按 index 拼成完整调用', async () => {
    const seen = { value: null as Record<string, unknown> | null };
    const provider = providerReturning(
      [
        { choices: [{ delta: { content: '我来起草。' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'set_scene' } }],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"location":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"旧城酒馆"}' } }] } }] },
      ],
      seen,
    );

    let text = '';
    let toolCalls: unknown = null;
    for await (const event of provider.chat([{ role: 'user', content: '换场景' }], {
      tools: [
        {
          type: 'function',
          function: { name: 'set_scene', description: '设置场景', parameters: { type: 'object' } },
        },
      ],
    })) {
      if (event.type === 'text') text += event.text;
      if (event.type === 'done') toolCalls = event.toolCalls ?? null;
    }

    expect(text).toBe('我来起草。');
    expect(toolCalls).toEqual([
      {
        id: 'call_a',
        type: 'function',
        function: { name: 'set_scene', arguments: '{"location":"旧城酒馆"}' },
      },
    ]);

    // 请求体里确实带了工具声明
    expect(seen.value?.tools).toBeDefined();
  });

  it('并行调用多个工具时按 index 分开，不会互相污染参数', async () => {
    const seen = { value: null as Record<string, unknown> | null };
    const provider = providerReturning(
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'a', function: { name: 'upsert_world_book', arguments: '{"name":"A"}' } },
                  { index: 1, id: 'b', function: { name: 'set_scene', arguments: '{"title":"B"}' } },
                ],
              },
            },
          ],
        },
      ],
      seen,
    );

    let toolCalls: readonly { function: { name: string; arguments: string } }[] = [];
    for await (const event of provider.chat([{ role: 'user', content: 'x' }])) {
      if (event.type === 'done' && event.toolCalls) toolCalls = event.toolCalls;
    }

    expect(toolCalls.map((call) => call.function.name)).toEqual(['upsert_world_book', 'set_scene']);
    expect(toolCalls[0]?.function.arguments).toBe('{"name":"A"}');
    expect(toolCalls[1]?.function.arguments).toBe('{"title":"B"}');
  });

  it('回填工具结果时用 tool_call_id，而不是把内部字段丢掉', async () => {
    const seen = { value: null as Record<string, unknown> | null };
    const provider = providerReturning([{ choices: [{ delta: { content: '好' } }] }], seen);

    for await (const _event of provider.chat([
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: '我来起草',
        toolCalls: [{ id: 'call_a', type: 'function', function: { name: 'set_scene', arguments: '{}' } }],
      },
      { role: 'tool', toolCallId: 'call_a', content: '已设置' },
    ])) {
      // 只关心请求体
    }

    const messages = seen.value?.messages as Array<Record<string, unknown>>;
    expect(messages[1]?.tool_calls).toBeDefined();
    expect(messages[2]?.role).toBe('tool');
    expect(messages[2]?.tool_call_id).toBe('call_a');
  });

  it('没有工具调用时 done 事件不带 toolCalls', async () => {
    const seen = { value: null as Record<string, unknown> | null };
    const provider = providerReturning([{ choices: [{ delta: { content: '普通回复' } }] }], seen);

    for await (const event of provider.chat([{ role: 'user', content: 'x' }])) {
      if (event.type === 'done') expect(event.toolCalls).toBeUndefined();
    }
  });
});
