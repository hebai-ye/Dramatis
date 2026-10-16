import { parseAdminToolCall } from '../../../../packages/core/src/admin/tools';
import { runAdminTurn } from '../../../../packages/core/src/admin/turn';
import { parseAffectUpdates } from '../../../../packages/core/src/memory/affect';
import { parseExtraction } from '../../../../packages/core/src/memory/extract';
import {
  createOpenAICompatibleProvider,
  type ModelProvider,
  type ProviderConfig,
} from '../../../../packages/core/src/provider/openai-compatible';
import { renderMessageContent } from '../../../../packages/core/src/render/segments';
import { scrub, wireHash } from './evidence';
import {
  defaultExecutionProfile,
  QualityExecutionProfileError,
  readExecutionProfile,
  readExecutionResponseEvidence,
} from './execution-profile';
import { createQualityProtocol, QualityProtocolError } from './protocol';
import type {
  QualityExecutionOptions,
  QualityExecutionProfile,
  QualityFixture,
  QualityResult,
  RoundEvidence,
  WireRequest,
} from './types';

export type AdminEngine = { runAdminTurn: typeof runAdminTurn; parseAdminToolCall: typeof parseAdminToolCall };
const candidateEngine: AdminEngine = { runAdminTurn, parseAdminToolCall };
function classify(error: unknown, signal?: AbortSignal): string {
  const message = error instanceof Error ? error.message : '';
  return signal?.aborted
    ? 'aborted'
    : error instanceof QualityProtocolError || error instanceof QualityExecutionProfileError
      ? error.message
      : message === 'validation-missing-usage'
        ? 'missing-usage-stop'
        : /长度上限/.test(message)
          ? 'budget-truncation'
          : 'provider-error';
}
export async function runFixture(
  fixture: QualityFixture,
  config: Omit<ProviderConfig, 'model'>,
  signal?: AbortSignal,
  suppliedEngine?: AdminEngine,
  execution: QualityExecutionOptions = {},
): Promise<QualityResult> {
  const nativeFetch = config.fetchImpl ?? fetch;
  const result: QualityResult = {
    caseId: fixture.caseId,
    fixtureHash: fixture.fixtureHash,
    requestHash: fixture.requestHash,
    text: '',
    toolCalls: [],
    usage: null,
    rounds: [],
    parse: null,
    error: null,
  };
  let executionProfile: QualityExecutionProfile;
  try {
    executionProfile = readExecutionProfile(
      execution.executionProfile === undefined ? defaultExecutionProfile : execution.executionProfile,
    );
  } catch (error) {
    return { ...result, error: classify(error, signal) };
  }
  const requireServerEvidence = execution.requireServerEvidence === true || executionProfile.maxOutputTokens === 4096;
  const engine = suppliedEngine ?? candidateEngine;
  if (fixture.family === 'admin' && fixture.source?.startsWith('git-blob-') && !suppliedEngine)
    return { ...result, error: 'baseline-engine-required' };
  let activeRound: RoundEvidence | undefined;
  const protocol = createQualityProtocol(signal);
  const provider = createOpenAICompatibleProvider({
    ...config,
    model: 'deepseek-flash',
    includeUsage: true,
    onWarning: () => {},
    fetchImpl: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as WireRequest;
      Object.assign(body, {
        model: executionProfile.model,
        reasoning_effort: executionProfile.reasoningEffort,
        thinking: { type: 'enabled' },
        max_tokens: executionProfile.maxOutputTokens,
      });
      delete body.temperature;
      delete body.top_p;
      delete body.presence_penalty;
      delete body.frequency_penalty;
      if (!activeRound) throw Error('missing-round');
      try {
        protocol.prepare(body);
        activeRound.wireHash = await wireHash(body);
        activeRound.wire = scrub(body, config.apiKey) as WireRequest;
        activeRound.wireHashMeaning = 'SHA256 of the complete canonical JSON body sent before redaction; no headers';
        if (signal?.aborted) throw new QualityProtocolError();
        const response = await nativeFetch(url, { ...init, body: JSON.stringify(body) });
        try {
          const upstreamWireHash = readExecutionResponseEvidence(response, executionProfile, requireServerEvidence);
          if (upstreamWireHash) {
            activeRound.upstreamWireHash = upstreamWireHash;
            activeRound.upstreamWireHashMeaning =
              'SHA256 server-reported digest of the exact serialized upstream JSON bytes (UTF-8 JSON.stringify output) before redaction; no headers; independent of client wireHash';
          }
          return await protocol.response(response);
        } catch (error) {
          void response.body?.cancel().catch(() => undefined);
          throw error;
        }
      } finally {
        for (const message of body.messages) delete message.reasoning_content;
      }
    },
  });
  const traced: ModelProvider = {
    ...provider,
    async *chat(messages, params, roundSignal) {
      activeRound = {
        round: result.rounds.length + 1,
        text: '',
        toolCalls: [],
        usage: null,
        error: null,
        executionProfile: { ...executionProfile },
      };
      const row = activeRound;
      result.rounds.push(row);
      try {
        for await (const event of provider.chat(messages, params, roundSignal)) {
          if (event.type === 'text') {
            row.text += event.text;
            result.text += event.text;
          }
          if (event.type === 'done') {
            row.usage = event.usage;
            row.toolCalls = event.toolCalls ?? [];
            result.toolCalls.push(...row.toolCalls);
            const promptTokens = event.usage?.promptTokens,
              completionTokens = event.usage?.completionTokens;
            if (
              typeof promptTokens !== 'number' ||
              typeof completionTokens !== 'number' ||
              !Number.isInteger(promptTokens) ||
              !Number.isInteger(completionTokens) ||
              promptTokens < 0 ||
              completionTokens < 0
            )
              throw Error('validation-missing-usage');
            result.usage ??= { promptTokens: 0, completionTokens: 0 };
            result.usage.promptTokens += promptTokens;
            result.usage.completionTokens += completionTokens;
            protocol.complete(row.text, row.toolCalls);
          }
          if (event.type !== 'reasoning') yield event;
        }
      } catch (error) {
        protocol.dispose();
        row.error = classify(error, roundSignal);
        throw error;
      }
    },
  };
  const context = {
    cards: fixture.input?.cards ?? [],
    knownCardIds: (fixture.input?.cards ?? []).map((card) => card.id),
    worldBooks: fixture.input?.worldBooks ?? [],
    knownBookIds: (fixture.input?.worldBooks ?? []).map((book) => book.id),
    knownPersonas: fixture.input?.personas ?? [],
  };
  try {
    if (fixture.family === 'admin') {
      for await (const event of engine.runAdminTurn(traced, fixture.request.messages, {
        maxRounds: 2,
        params: { maxTokens: executionProfile.maxOutputTokens },
        signal,
        context,
        execute: async (draft) => `隔离验证摘要：${draft.summary}（未写库）`,
      })) {
        if (event.type === 'done') result.admin = { calls: event.calls, executions: event.executions };
      }
    } else {
      for await (const _event of traced.chat(
        fixture.request.messages,
        { maxTokens: executionProfile.maxOutputTokens, tools: fixture.request.tools },
        signal,
      )) {
        /* the traced provider collects each event */
      }
    }
    try {
      result.parse =
        fixture.family === 'extraction'
          ? parseExtraction(result.text)
          : fixture.family === 'affect'
            ? parseAffectUpdates(result.text)
            : fixture.family === 'admin'
              ? result.toolCalls.map((call) => engine.parseAdminToolCall(call, context))
              : renderMessageContent(result.text);
    } catch {
      result.parse = { ok: false, error: 'production-parser-rejected' };
    }
  } catch (error) {
    result.error = classify(error, signal);
  } finally {
    protocol.dispose();
  }
  // Required result fields are not among the secret/reasoning fields removed by scrub.
  const exported = scrub(result, config.apiKey) as QualityResult;
  for (const row of exported.rounds) {
    if (row.wire) {
      row.exportedWireHash = await wireHash(row.wire);
      row.wireRedacted = row.wireHash !== row.exportedWireHash;
    }
  }
  return exported;
}
