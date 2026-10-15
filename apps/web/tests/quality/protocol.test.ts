import { describe, expect, it } from 'vitest';
import type { ChatToolCall } from '../../../../packages/core/src/prompt/types';
import { hash, Ledger, reservation } from '../../../../tools/desktop/validation-common.mjs';
import { createQualityProtocol, QualityProtocolError } from './protocol';
import { runFixture } from './runner';
import type { QualityFixture, WireRequest } from './types';

const calls: ChatToolCall[] = [
  { id: 'call-a', type: 'function', function: { name: 'set_scene', arguments: '{"location":"北门"}' } },
  { id: 'call-b', type: 'function', function: { name: 'set_scene', arguments: '{"summary":"等候"}' } },
];
const fixture: QualityFixture = {
  caseId: 'admin-protocol',
  family: 'admin',
  request: { messages: [{ role: 'user', content: '调整场景' }], tools: [] },
};
const chain = '私有第一块\n 第二块🙂 ';
function jsonTools(reasoning = chain) {
  return Response.json({
    choices: [
      { message: { content: '准备', reasoning_content: reasoning, tool_calls: calls }, finish_reason: 'tool_calls' },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  });
}
function finalResponse() {
  return Response.json({
    choices: [{ message: { content: '完成' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  });
}
function rawToolResponse(mode: 'sse' | 'json', call: unknown, reasoning: string | undefined) {
  const content = {
    content: '准备',
    ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
    tool_calls: [call],
  };
  const payload = {
    choices: [{ ...(mode === 'sse' ? { delta: content } : { message: content }), finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  };
  return mode === 'json'
    ? Response.json(payload)
    : new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
}
function streamTools() {
  const frames = [
    { choices: [{ delta: { reasoning_content: '私有第一块\n' } }] },
    { choices: [{ delta: { reasoning_content: ' 第二块🙂 ' } }] },
    { choices: [{ delta: { content: '准备', tool_calls: calls.map((call, index) => ({ ...call, index })) } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 20 } },
  ];
  const bytes = new TextEncoder().encode(
    `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`,
  );
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Split both event boundaries and UTF-8 characters across transport chunks.
        for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function initialWire(): WireRequest {
  return { model: 'deepseek-flash', stream: true, messages: [{ role: 'user', content: '调整场景' }] };
}
function followupWire(): WireRequest {
  return {
    ...initialWire(),
    messages: [
      ...initialWire().messages,
      { role: 'assistant', content: '准备', tool_calls: structuredClone(calls) },
      ...calls.map((call) => ({ role: 'tool', tool_call_id: call.id, content: '隔离摘要' })),
    ],
  };
}

describe('D02 private Low protocol shim (fake only)', () => {
  it('aborts a genuinely pending SSE source read, cancels the source and releases its reader', async () => {
    const controller = new AbortController();
    let requests = 0;
    let cancellations = 0;
    let notifyRead: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      notifyRead = resolve;
    });
    const source = new ReadableStream<Uint8Array>(
      {
        pull() {
          // Deliberately neither enqueue nor close: the wrapper's read stays pending.
          notifyRead?.();
        },
        cancel() {
          cancellations++;
        },
      },
      { highWaterMark: 0 },
    );
    const running = runFixture(
      fixture,
      {
        apiKey: 'FAKE',
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: async () => {
          requests++;
          return new Response(source, { headers: { 'content-type': 'text/event-stream' } });
        },
      },
      controller.signal,
    );
    try {
      await readStarted;
      expect(source.locked).toBe(true);
      expect(cancellations).toBe(0);
      controller.abort();
      const result = await running;
      expect(result.error).toBe('aborted');
      expect(requests).toBe(1);
      expect(cancellations).toBe(1);
      expect(source.locked).toBe(false);
      // Acquire the actual source reader again; checking a disposed flag alone is insufficient.
      const reader = source.getReader();
      try {
        expect(await reader.read()).toEqual({ done: true, value: undefined });
      } finally {
        reader.releaseLock();
      }
      expect(JSON.stringify(result)).not.toContain('reasoning_content');
    } finally {
      controller.abort();
      await running;
    }
  });

  it('fails closed on malformed SSE, cancels the still-open source and never dispatches again', async () => {
    let requests = 0;
    let cancellations = 0;
    const first = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: chain } }] })}\n\n`;
    const source = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${first}data: {MALFORMED_PRIVATE_PAYLOAD\n\n`));
          // Leave open so cancellation is observable, not an already completed stream no-op.
        },
        cancel() {
          cancellations++;
        },
      },
      { highWaterMark: 0 },
    );
    const result = await runFixture(fixture, {
      apiKey: 'FAKE',
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: async () => {
        requests++;
        return new Response(source, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    expect(result.error).toBe('provider-error');
    expect(requests).toBe(1);
    expect(cancellations).toBe(1);
    expect(source.locked).toBe(false);
    expect(JSON.stringify(result)).not.toContain('私有第一块');
    expect(JSON.stringify(result)).not.toContain('MALFORMED_PRIVATE_PAYLOAD');
    expect(JSON.stringify(result)).not.toContain('reasoning_content');
  });

  it('rejects an ID change on the same SSE tool index before a second fetch', async () => {
    let requests = 0;
    const chunks = [
      {
        choices: [
          {
            delta: {
              reasoning_content: chain,
              tool_calls: [{ index: 0, id: 'original-id', function: { name: 'set_scene', arguments: '{"location":' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'changed-id', function: { arguments: '"北门"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      },
    ];
    const result = await runFixture(fixture, {
      apiKey: 'FAKE',
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: async () => {
        requests++;
        return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    expect(requests).toBe(1);
    expect(result.toolCalls[0]?.id).toBe('changed-id');
    expect(result.error).toContain('协议上下文无法恢复');
    expect(JSON.stringify(result)).not.toContain('私有第一块');
    expect(JSON.stringify(result)).not.toContain('reasoning_content');
  });

  for (const mode of ['sse', 'json'] as const) {
    it(`${mode}: refuses a raw tool with no name even when production parsing drops it`, async () => {
      let requests = 0;
      const result = await runFixture(fixture, {
        apiKey: 'FAKE',
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: async () => {
          requests++;
          return rawToolResponse(
            mode,
            {
              index: 0,
              id: 'actual-id',
              type: 'function',
              function: { arguments: '{"location":"北门"}' },
            },
            chain,
          );
        },
      });
      expect(requests).toBe(1);
      expect(result.toolCalls).toEqual([]);
      expect(result.error).toContain('协议上下文无法恢复');
      expect(JSON.stringify(result)).not.toContain('私有第一块');
      expect(JSON.stringify(result)).not.toContain('reasoning_content');
    });

    it.each(['id', 'arguments'] as const)(
      `${mode}: missing raw %s rejects before a second fetch despite parser defaults`,
      async (field) => {
        let requests = 0;
        const call = {
          index: 0,
          type: 'function',
          ...(field === 'id' ? {} : { id: 'actual-id' }),
          function: { name: 'set_scene', ...(field === 'arguments' ? {} : { arguments: '{"location":"北门"}' }) },
        };
        const result = await runFixture(fixture, {
          apiKey: 'FAKE',
          baseUrl: 'http://127.0.0.1:1',
          fetchImpl: async () => {
            requests++;
            return rawToolResponse(mode, call, chain);
          },
        });
        expect(requests).toBe(1);
        expect(result.error).toContain('协议上下文无法恢复');
        // Show that production parsing really happened and filled in the reviewed defaults.
        if (field === 'id') expect(result.toolCalls[0]?.id).toBe('call_0');
        else expect(result.toolCalls[0]?.function.arguments).toBe('{}');
        expect(JSON.stringify(result)).not.toContain('reasoning_content');
        expect(JSON.stringify(result)).not.toContain('私有第一块');
      },
    );

    it.each(['empty', 'missing'] as const)(
      `${mode}: explicit empty reasoning and missing reasoning have distinct outcomes (%s)`,
      async (kind) => {
        const wires: WireRequest[] = [];
        const call = {
          index: 0,
          id: 'actual-id',
          type: 'function',
          function: { name: 'set_scene', arguments: '{"location":"北门"}' },
        };
        const result = await runFixture(fixture, {
          apiKey: 'FAKE',
          baseUrl: 'http://127.0.0.1:1',
          fetchImpl: async (_url, init) => {
            wires.push(JSON.parse(String(init?.body)) as WireRequest);
            return wires.length === 1
              ? rawToolResponse(mode, call, kind === 'empty' ? '' : undefined)
              : finalResponse();
          },
        });
        expect(wires).toHaveLength(kind === 'empty' ? 2 : 1);
        if (kind === 'empty') {
          expect(result.error).toBeNull();
          expect(wires[1]?.messages.find((message) => message.role === 'assistant')).toHaveProperty(
            'reasoning_content',
            '',
          );
          expect(result.rounds[1]?.wireRedacted).toBe(true);
        } else expect(result.error).toContain('协议上下文无法恢复');
        expect(JSON.stringify(result)).not.toContain('reasoning_content');
      },
    );
  }

  it('accepts real tool identity and argument fields supplied in later SSE fragments without inventing defaults', async () => {
    const wires: WireRequest[] = [];
    const fragments = [
      { reasoning_content: '' },
      { reasoning_content: chain, tool_calls: [{ index: 0, id: 'actual-id', function: { name: 'set_scene' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '{"location":' } }] },
      { content: '准备', tool_calls: [{ index: 0, function: { arguments: '"北门"}' } }] },
    ];
    const sse =
      fragments.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join('') +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`;
    const result = await runFixture(fixture, {
      apiKey: 'FAKE',
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: async (_url, init) => {
        wires.push(JSON.parse(String(init?.body)) as WireRequest);
        return wires.length === 1
          ? new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
          : finalResponse();
      },
    });
    expect(result.error).toBeNull();
    expect(wires).toHaveLength(2);
    const assistant = wires[1]?.messages.find((message) => message.role === 'assistant');
    expect(assistant?.reasoning_content).toBe(chain);
    expect(assistant?.tool_calls?.[0]?.function.arguments).toBe('{"location":"北门"}');
    expect(JSON.stringify(result)).not.toContain('私有第一块');
  });

  it.each(['sse', 'json'] as const)(
    'returns exact %s reasoning on the matching second wire, with full budget/hash and no evidence chain',
    async (mode) => {
      const wires: WireRequest[] = [];
      const ledger = new Ledger();
      const result = await runFixture(fixture, {
        apiKey: 'FAKE',
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: async (_url, init) => {
          const wire = JSON.parse(String(init?.body)) as WireRequest;
          wires.push(wire);
          const id = ledger.reserve(wire, 'quality');
          ledger.settle(id, { prompt_tokens: 10, completion_tokens: 20 });
          return wires.length === 1 ? (mode === 'sse' ? streamTools() : jsonTools()) : finalResponse();
        },
      });
      expect(result.error).toBeNull();
      expect(result.admin?.calls).toBe(2);
      expect(wires).toHaveLength(2);
      const second = wires[1];
      expect(second?.messages.find((message) => message.role === 'assistant')?.reasoning_content).toBe(chain);
      expect(result.rounds[1]?.wireHash).toBe(hash(second));
      expect(result.rounds[1]?.exportedWireHash).toBe(hash(result.rounds[1]?.wire));
      expect(result.rounds[1]?.wireRedacted).toBe(true);
      expect(ledger.state.entries[1]?.reservationCny).toBe(reservation(second));
      expect(reservation(second)).toBeGreaterThan(reservation(result.rounds[1]?.wire));
      expect(JSON.stringify(result)).not.toContain(chain);
      expect(JSON.stringify(result)).not.toContain('reasoning_content');
      expect(JSON.stringify(ledger.state)).not.toContain('私有');
    },
  );

  it('does not reuse chain when another case/run has the same call IDs', async () => {
    for (const value of ['RUN-A-ONLY', 'RUN-B-ONLY']) {
      const wires: WireRequest[] = [];
      const result = await runFixture(fixture, {
        apiKey: 'FAKE',
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: async (_url, init) => {
          wires.push(JSON.parse(String(init?.body)) as WireRequest);
          return wires.length === 1 ? jsonTools(value) : finalResponse();
        },
      });
      expect(result.error).toBeNull();
      expect(JSON.stringify(wires[0])).not.toContain('reasoning_content');
      expect(wires[1]?.messages.find((message) => message.role === 'assistant')?.reasoning_content).toBe(value);
      expect(JSON.stringify(result)).not.toContain('RUN-A-ONLY');
      expect(JSON.stringify(result)).not.toContain('RUN-B-ONLY');
      expect(JSON.stringify(result)).not.toContain('reasoning_content');
    }
    let requests = 0;
    const missing = await runFixture(fixture, {
      apiKey: 'FAKE',
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: async () => {
        requests++;
        return Response.json({
          choices: [{ message: { content: '准备', tool_calls: calls }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        });
      },
    });
    expect(requests).toBe(1);
    expect(missing.error).toContain('协议上下文无法恢复');
  });

  it.each(['prefix', 'assistant', 'id', 'arguments', 'order'] as const)(
    'rejects %s mismatch before another fetch can occur',
    async (mutation) => {
      const protocol = createQualityProtocol();
      try {
        protocol.prepare(initialWire());
        await protocol.response(jsonTools());
        protocol.complete('准备', calls);
        const next = followupWire();
        const first = next.messages[0];
        const assistant = next.messages[1];
        const call = assistant?.tool_calls?.[0];
        if (!first || !assistant || !call) throw Error('invalid-test-fixture');
        if (mutation === 'prefix') first.content = 'changed';
        if (mutation === 'assistant') assistant.content = 'changed';
        if (mutation === 'id') call.id = 'wrong-id';
        if (mutation === 'arguments') call.function.arguments = '{}';
        if (mutation === 'order') next.messages.splice(2, 2, ...next.messages.slice(2).reverse());
        expect(() => protocol.prepare(next)).toThrow(QualityProtocolError);
        expect(JSON.stringify(next)).not.toContain('reasoning_content');
      } finally {
        protocol.dispose();
      }
    },
  );

  it('refuses unknown historical tool assistant before the first fetch', async () => {
    let requests = 0;
    const result = await runFixture(
      {
        ...fixture,
        request: {
          tools: [],
          messages: [
            { role: 'assistant', content: '准备', toolCalls: calls },
            { role: 'tool', content: '旧结果', toolCallId: 'call-a' },
          ],
        },
      },
      {
        apiKey: 'FAKE',
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: async () => {
          requests++;
          return finalResponse();
        },
      },
    );
    expect(requests).toBe(0);
    expect(result.error).toContain('协议上下文无法恢复');
  });

  it('never invents empty reasoning for a tool response that omitted it', async () => {
    let requests = 0;
    const result = await runFixture(fixture, {
      apiKey: 'FAKE',
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: async () => {
        requests++;
        return Response.json({
          choices: [{ message: { content: '准备', tool_calls: calls }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        });
      },
    });
    expect(requests).toBe(1);
    expect(result.error).toContain('协议上下文无法恢复');
  });

  it.each(['abort', 'error'] as const)(
    'clears the run after %s and never exposes private protocol content in errors',
    async (mode) => {
      const controller = new AbortController();
      let requests = 0;
      const result = await runFixture(
        fixture,
        {
          apiKey: 'FAKE',
          baseUrl: 'http://127.0.0.1:1',
          fetchImpl: async () => {
            requests++;
            if (requests === 1) return jsonTools();
            if (mode === 'abort') controller.abort();
            throw Error(chain);
          },
        },
        controller.signal,
      );
      expect(requests).toBe(2);
      expect(result.error).toBe(mode === 'abort' ? 'aborted' : 'provider-error');
      expect(JSON.stringify(result)).not.toContain(chain);
      expect(JSON.stringify(result)).not.toContain('reasoning_content');
      const protocol = createQualityProtocol(controller.signal);
      protocol.dispose();
      expect(() => protocol.prepare(initialWire())).toThrow(QualityProtocolError);
    },
  );

  it('aborting JSON capture clears private state and releases the response reader', async () => {
    const controller = new AbortController();
    const protocol = createQualityProtocol(controller.signal);
    protocol.prepare(initialWire());
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"choices":['));
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    const observing = protocol.response(response);
    controller.abort();
    await expect(observing).rejects.toThrow(QualityProtocolError);
    expect(() => protocol.prepare(followupWire())).toThrow(QualityProtocolError);
    protocol.dispose();
    await response.body?.cancel();
  });
});
