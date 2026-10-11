import { describe, expect, it } from 'vitest';
import { parseAdminToolCall } from '../../../../packages/core/src/admin/tools';
import { runAdminTurn } from '../../../../packages/core/src/admin/turn';
import { hash } from '../../../../tools/desktop/validation-common.mjs';
import { runFixture } from './runner';
import type { QualityResult, WireRequest } from './types';

describe('production provider via isolated low fetch injection', () => {
  it('uses the same 4096 profile for supplied and candidate admin engines and exports upstream evidence separately from client wire', async () => {
    const profile = {
      profileId: 'deepseek-flash-low-output-4096-v1',
      maxOutputTokens: 4096,
      model: 'deepseek-flash',
      reasoningEffort: 'low',
    } as const;
    const results: QualityResult[] = [];
    for (const suppliedEngine of [{ runAdminTurn, parseAdminToolCall }, undefined]) {
      let calls = 0;
      results.push(
        await runFixture(
          {
            caseId: 'admin-3',
            family: 'admin',
            requestHash: 'frozen-1200-request-hash',
            request: { messages: [{ role: 'user', content: '移动到北门' }], tools: [] },
          },
          {
            apiKey: 'FAKE-SECRET',
            baseUrl: 'http://127.0.0.1:1/v1',
            fetchImpl: async (_url, init) => {
              const body = JSON.parse(String(init?.body)) as WireRequest;
              // A controlled proxy observation differs from the client body, as a transport may transform it.
              const upstreamHash = hash({ ...body, stream: false });
              calls++;
              return Response.json(
                {
                  choices: [
                    {
                      message:
                        calls === 1
                          ? {
                              content: '准备修改。',
                              reasoning_content: 'PRIVATE-TRANSPORT-CHAIN',
                              tool_calls: [
                                {
                                  id: 'call-1',
                                  type: 'function',
                                  function: { name: 'set_scene', arguments: '{"location":"北门"}' },
                                },
                              ],
                            }
                          : { content: '摘要已记录。' },
                      finish_reason: calls === 1 ? 'tool_calls' : 'stop',
                    },
                  ],
                  usage: { prompt_tokens: 10, completion_tokens: 20 },
                },
                {
                  headers: {
                    'x-validation-execution-profile': profile.profileId,
                    'x-validation-max-output-tokens': '4096',
                    'x-validation-upstream-wire-hash': upstreamHash,
                  },
                },
              );
            },
          },
          undefined,
          suppliedEngine,
          { executionProfile: profile },
        ),
      );
    }
    for (const result of results) {
      expect(result.error).toBeNull();
      expect(result.requestHash).toBe('frozen-1200-request-hash');
      expect(result.rounds).toHaveLength(2);
      for (const row of result.rounds) {
        expect(row.executionProfile).toEqual(profile);
        expect(row.wire?.max_tokens).toBe(4096);
        expect(row.wire?.stream_options).toEqual({ include_usage: true });
        expect(row.upstreamWireHash).toMatch(/^[a-f0-9]{64}$/);
        expect(row.upstreamWireHash).not.toBe(row.wireHash);
        expect(row.upstreamWireHashMeaning).toContain('server-reported');
        expect(hash(row.wire)).toBe(row.exportedWireHash);
      }
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE-TRANSPORT-CHAIN|FAKE-SECRET|reasoning_content/);
    }
    expect(results[0]?.rounds.map((row) => row.wireHash)).toEqual(results[1]?.rounds.map((row) => row.wireHash));
  });
  it('uses 4096 for a non-admin request while preserving its frozen request identity', async () => {
    const result = await runFixture(
      {
        caseId: 'roleplay-1',
        family: 'roleplay',
        requestHash: 'frozen-1200-request-hash',
        request: { messages: [{ role: 'user', content: 'test' }], tools: [], params: { max_tokens: 1200 } },
      },
      {
        apiKey: 'FAKE',
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: async (_url, init) =>
          Response.json(
            {
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 2 },
            },
            {
              headers: {
                'x-validation-execution-profile': 'deepseek-flash-low-output-4096-v1',
                'x-validation-max-output-tokens': '4096',
                'x-validation-upstream-wire-hash': hash(JSON.parse(String(init?.body))),
              },
            },
          ),
      },
      undefined,
      undefined,
      {
        executionProfile: {
          profileId: 'deepseek-flash-low-output-4096-v1',
          maxOutputTokens: 4096,
          model: 'deepseek-flash',
          reasoningEffort: 'low',
        },
      },
    );
    expect(result.error).toBeNull();
    expect(result.requestHash).toBe('frozen-1200-request-hash');
    expect(result.rounds[0]?.wire?.max_tokens).toBe(4096);
    expect(result.rounds[0]?.upstreamWireHash).toBe(result.rounds[0]?.wireHash);
    expect(hash(result.rounds[0]?.wire)).toBe(result.rounds[0]?.wireHash);
  });
  it('stops before dispatch for an invalid profile and stops admin continuation on missing server evidence', async () => {
    let calls = 0;
    const config = {
      apiKey: 'FAKE',
      baseUrl: 'http://127.0.0.1:1/v1',
      fetchImpl: async () => {
        calls++;
        return Response.json({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        });
      },
    };
    const fixture = { caseId: 'admin-3', family: 'admin' as const, request: { messages: [], tools: [] } };
    const invalid = await runFixture(fixture, config, undefined, undefined, {
      executionProfile: {
        profileId: 'deepseek-flash-low-output-4096-v1',
        maxOutputTokens: 1200,
        model: 'deepseek-flash',
        reasoningEffort: 'low',
      },
    });
    expect(invalid.error).toBe('invalid-execution-profile');
    expect(invalid.rounds).toHaveLength(0);
    expect(calls).toBe(0);
    const missing = await runFixture(fixture, config, undefined, undefined, {
      executionProfile: {
        profileId: 'deepseek-flash-low-output-4096-v1',
        maxOutputTokens: 4096,
        model: 'deepseek-flash',
        reasoningEffort: 'low',
      },
    });
    expect(missing.error).toBe('execution-profile-mismatch');
    expect(missing.rounds).toHaveLength(1);
    expect(calls).toBe(1);
    expect(missing.rounds[0]?.upstreamWireHash).toBeUndefined();
  });
  it('exports the complete wire for canonical hash reproduction, retaining configuration but no reasoning content', async () => {
    const result = await runFixture(
      {
        caseId: 'roleplay-1',
        family: 'roleplay',
        request: { messages: [{ role: 'user', content: 'test' }], tools: [] },
      },
      {
        apiKey: 'FAKE-SECRET',
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: async () =>
          Response.json({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 2 },
          }),
      },
    );
    const row = result.rounds[0];
    expect(row?.wire).toEqual({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'test' }],
      stream: true,
      max_tokens: 1200,
      reasoning_effort: 'low',
      thinking: { type: 'enabled' },
      stream_options: { include_usage: true },
    });
    expect(row?.executionProfile?.maxOutputTokens).toBe(1200);
    expect(row?.upstreamWireHash).toBeUndefined();
    expect(hash(row?.wire)).toBe(row?.wireHash);
    expect(hash(row?.wire)).toBe(row?.exportedWireHash);
    expect(row?.wireRedacted).toBe(false);
  });
  it('runs production admin maxRounds 2, feeds tool summary back and records each wire independently', async () => {
    const wires: WireRequest[] = [];
    const result = await runFixture(
      {
        caseId: 'admin-3',
        family: 'admin',
        input: {},
        request: { messages: [{ role: 'user', content: '移动到北门' }], tools: [] },
      },
      {
        apiKey: 'FAKE',
        baseUrl: 'http://127.0.0.1:1/v1',
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          wires.push(body);
          return Response.json({
            choices: [
              {
                message:
                  wires.length === 1
                    ? {
                        content: '准备修改。',
                        reasoning_content: 'fake private protocol content',
                        tool_calls: [
                          {
                            id: 'call-1',
                            type: 'function',
                            function: { name: 'set_scene', arguments: '{"location":"北门"}' },
                          },
                        ],
                      }
                    : { content: '摘要已记录。' },
                finish_reason: wires.length === 1 ? 'tool_calls' : 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          });
        },
      },
    );
    expect(wires).toHaveLength(2);
    expect(wires[0]?.tool_choice).toBe('auto');
    expect(wires[1]?.tool_choice).toBe('none');
    expect(wires[1]?.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-1' });
    expect(wires[1]?.messages.at(-1)?.content).toContain('未写库');
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]?.wireHash).not.toBe(result.rounds[1]?.wireHash);
    expect(result.usage).toEqual({ promptTokens: 20, completionTokens: 40 });
  });
  it('stops admin before second dispatch when usage is missing', async () => {
    let calls = 0;
    const result = await runFixture(
      { caseId: 'admin-3', family: 'admin', request: { messages: [], tools: [] } },
      {
        apiKey: 'FAKE',
        baseUrl: 'http://127.0.0.1:1/v1',
        fetchImpl: async () => {
          calls++;
          return Response.json({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: { name: 'set_scene', arguments: '{"location":"北门"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          });
        },
      },
    );
    expect(calls).toBe(1);
    expect(result.error).toBe('missing-usage-stop');
  });
  it('uses real streaming tool parser, excludes reasoning and redacts key echoes', async () => {
    let wire: WireRequest | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      wire = JSON.parse(String(init?.body)) as WireRequest;
      return new Response(
        [
          'data: {"choices":[{"delta":{"reasoning_content":"private","content":"TEST-SECRET hello","tool_calls":[{"index":0,"id":"t","function":{"name":"draft_scene","arguments":"{\\"location\\":"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"gate\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n',
          'data: [DONE]\n\n',
        ].join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const result = await runFixture(
      { caseId: 'admin-1', family: 'admin', request: { messages: [{ role: 'user', content: 'test' }], tools: [] } },
      { apiKey: 'TEST-SECRET', fetchImpl, baseUrl: 'http://127.0.0.1:1/v1' },
    );
    expect(wire?.reasoning_effort).toBe('low');
    expect(wire?.thinking).toEqual({ type: 'enabled' });
    expect(wire?.max_tokens).toBe(1200);
    expect(wire?.model).toBe('deepseek-flash');
    expect(result.toolCalls[0]?.function.arguments).toBe('{"location":"gate"}');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('TEST-SECRET');
  });
  it('labels redacted body hashes separately without losing the original wire hash meaning', async () => {
    const result = await runFixture(
      {
        caseId: 'roleplay-1',
        family: 'roleplay',
        request: { messages: [{ role: 'user', content: 'FAKE-SECRET' }], tools: [] },
      },
      {
        apiKey: 'FAKE-SECRET',
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: async () =>
          Response.json({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 2 },
          }),
      },
    );
    const row = result.rounds[0];
    expect(row?.wireRedacted).toBe(true);
    expect(hash(row?.wire)).toBe(row?.exportedWireHash);
    expect(row?.wireHash).not.toBe(row?.exportedWireHash);
    expect(row?.wireHashMeaning).toContain('before redaction');
    expect(JSON.stringify(result)).not.toContain('FAKE-SECRET');
  });
  it('keeps partial text and budget truncation evidence but never exports provider error bodies', async () => {
    const result = await runFixture(
      { caseId: 'roleplay-1', family: 'roleplay', request: { messages: [], tools: [] } },
      {
        apiKey: 'S',
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: async () =>
          new Response(
            'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      },
    );
    expect(result.text).toBe('partial');
    expect(result.error).toBe('budget-truncation');
  });
});
