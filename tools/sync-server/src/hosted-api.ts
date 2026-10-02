import { type SqliteDatabase, verifyCredential } from '../../../packages/core/src/index.js';
import { createApiLedger } from '../../sync-admin/src/api-accounting.js';
import {
  DEEPSEEK_MAX_OUTPUT_TOKENS,
  DEEPSEEK_MODEL,
  type DeepSeekPriceConfig,
  type DeepSeekUsage,
  deepSeekPriceAt,
  deepSeekPriceForInterval,
  quoteDeepSeekUsage,
  requiredDeepSeekReserve,
  validateDeepSeekUsage,
} from './deepseek-billing.js';

const UPSTREAM = 'https://api.deepseek.com/chat/completions';
export const HOSTED_MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_SSE_EVENT_CHARS = 1024 * 1024;
const REQUEST_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

interface SpaceProof {
  credential_hash: string;
  recovery_credential_hash: string;
  epoch: string;
}
interface HostedOptions {
  db: SqliteDatabase;
  apiKey?: string;
  enabled?: boolean;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  priceConfig?: DeepSeekPriceConfig;
  upstreamTimeoutMs?: number;
}

function fail(status: number, code: string, extra?: Record<string, unknown>): Response {
  return Response.json({ error: { code }, ...extra }, { status, headers: { 'cache-control': 'no-store' } });
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((name) => allowed.includes(name));
}
function validJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((part) => validJson(part, depth + 1));
  return object(value) && Object.values(value).every((part) => validJson(part, depth + 1));
}
function validFunction(value: unknown): boolean {
  return (
    object(value) &&
    keys(value, ['name', 'description', 'parameters']) &&
    typeof value.name === 'string' &&
    FUNCTION_NAME.test(value.name) &&
    (value.description === undefined || typeof value.description === 'string') &&
    (value.parameters === undefined || (object(value.parameters) && validJson(value.parameters)))
  );
}
function validToolCall(value: unknown): boolean {
  return (
    object(value) &&
    keys(value, ['id', 'type', 'function']) &&
    value.type === 'function' &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 128 &&
    object(value.function) &&
    keys(value.function, ['name', 'arguments']) &&
    typeof value.function.name === 'string' &&
    FUNCTION_NAME.test(value.function.name) &&
    typeof value.function.arguments === 'string'
  );
}
function validMessage(value: unknown): boolean {
  if (
    !object(value) ||
    !keys(value, ['role', 'content', 'name', 'tool_calls', 'tool_call_id']) ||
    !['system', 'user', 'assistant', 'tool'].includes(String(value.role)) ||
    (value.name !== undefined && (typeof value.name !== 'string' || !FUNCTION_NAME.test(value.name)))
  )
    return false;
  if (value.role === 'assistant') {
    if (value.content !== null && typeof value.content !== 'string') return false;
    if (
      value.tool_calls !== undefined &&
      (!Array.isArray(value.tool_calls) ||
        value.tool_calls.length === 0 ||
        value.tool_calls.length > 128 ||
        !value.tool_calls.every(validToolCall))
    )
      return false;
    if (value.content === null && value.tool_calls === undefined) return false;
  } else if (typeof value.content !== 'string' || value.tool_calls !== undefined) return false;
  if (value.role === 'tool')
    return typeof value.tool_call_id === 'string' && value.tool_call_id.length > 0 && value.tool_call_id.length <= 128;
  return value.tool_call_id === undefined;
}
function normalizeBody(value: unknown): Record<string, unknown> {
  if (
    !object(value) ||
    !keys(value, [
      'model',
      'messages',
      'max_tokens',
      'stream',
      'stream_options',
      'temperature',
      'top_p',
      'frequency_penalty',
      'presence_penalty',
      'stop',
      'tools',
      'tool_choice',
      'response_format',
    ]) ||
    (value.model !== undefined && value.model !== DEEPSEEK_MODEL) ||
    !Array.isArray(value.messages) ||
    value.messages.length === 0 ||
    value.messages.length > 4096 ||
    !value.messages.every(validMessage)
  )
    throw new Error('bad-request');
  const maxTokens = value.max_tokens ?? 4096;
  if (
    typeof maxTokens !== 'number' ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > DEEPSEEK_MAX_OUTPUT_TOKENS ||
    (value.stream !== undefined && typeof value.stream !== 'boolean')
  )
    throw new Error('bad-request');
  if (
    value.stream_options !== undefined &&
    (!object(value.stream_options) ||
      !keys(value.stream_options, ['include_usage']) ||
      value.stream_options.include_usage !== true)
  )
    throw new Error('bad-request');
  for (const [name, low, high] of [
    ['temperature', 0, 2],
    ['top_p', 0, 1],
    ['frequency_penalty', -2, 2],
    ['presence_penalty', -2, 2],
  ] as const) {
    const number = value[name];
    if (
      number !== undefined &&
      (typeof number !== 'number' || !Number.isFinite(number) || number < low || number > high)
    )
      throw new Error('bad-request');
  }
  if (
    value.stop !== undefined &&
    value.stop !== null &&
    typeof value.stop !== 'string' &&
    (!Array.isArray(value.stop) || value.stop.length > 16 || !value.stop.every((part) => typeof part === 'string'))
  )
    throw new Error('bad-request');
  if (
    value.tools !== undefined &&
    (!Array.isArray(value.tools) ||
      value.tools.length > 128 ||
      !value.tools.every(
        (tool) =>
          object(tool) && keys(tool, ['type', 'function']) && tool.type === 'function' && validFunction(tool.function),
      ))
  )
    throw new Error('bad-request');
  if (
    value.tool_choice !== undefined &&
    !['none', 'auto', 'required'].includes(String(value.tool_choice)) &&
    !(
      object(value.tool_choice) &&
      keys(value.tool_choice, ['type', 'function']) &&
      value.tool_choice.type === 'function' &&
      object(value.tool_choice.function) &&
      keys(value.tool_choice.function, ['name']) &&
      typeof value.tool_choice.function.name === 'string' &&
      FUNCTION_NAME.test(value.tool_choice.function.name)
    )
  )
    throw new Error('bad-request');
  if (
    value.response_format !== undefined &&
    (!object(value.response_format) ||
      !keys(value.response_format, ['type']) ||
      !['text', 'json_object'].includes(String(value.response_format.type)))
  )
    throw new Error('bad-request');
  return {
    ...value,
    model: DEEPSEEK_MODEL,
    max_tokens: maxTokens,
    stream: value.stream === true,
    thinking: { type: 'disabled' },
    ...(value.stream === true ? { stream_options: { include_usage: true } } : {}),
  };
}

async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let result = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => {});
        throw new Error('payload-too-large');
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
function codeOf(error: unknown): string {
  if (object(error) && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.message : 'internal-error';
}
function ledgerFailure(error: unknown): Response {
  const code = codeOf(error);
  if (['space-changed', 'proof-changed', 'request-pending', 'request-conflict'].includes(code)) return fail(409, code);
  if (['vip-inactive', 'paid-expired', 'no-account'].includes(code)) return fail(403, code);
  if (code === 'insufficient-balance') return fail(402, code);
  if (code === 'schema-unavailable') return fail(503, code);
  return fail(500, 'billing-unavailable');
}
function upstreamId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

/** Context lives in memory only. Every ambiguous post-send result retains its persistent reserve. */
export function createHostedApiHandler(options: HostedOptions) {
  const now = options.now ?? Date.now;
  const fetchUpstream = options.fetch ?? globalThis.fetch;
  const enabled = options.enabled !== false && typeof options.apiKey === 'string' && options.apiKey.trim() !== '';
  const ledger = createApiLedger(options.db, now);
  const active = new Set<Promise<unknown>>();
  const controllers = new Set<AbortController>();
  const timeoutMs = options.upstreamTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('invalid-timeout');
  const proofQuery = options.db.prepare(
    'SELECT credential_hash,recovery_credential_hash,epoch FROM spaces WHERE space_handle=?',
  );

  const track = <T>(work: Promise<T>): Promise<T> => {
    active.add(work);
    void work.then(
      () => active.delete(work),
      () => active.delete(work),
    );
    return work;
  };
  const pending = (id: string, reason: string, metadata?: { usage?: DeepSeekUsage; upstreamId?: string }) => {
    try {
      ledger.markPending(id, reason, metadata);
    } catch {
      /* Existing sent/reserved row still freezes funds. */
    }
  };

  async function run(request: Request): Promise<Response> {
    const path = /^\/v1\/spaces\/([A-Za-z0-9_-]{1,128})\/(chat\/completions|account)$/.exec(
      new URL(request.url).pathname,
    );
    if (!path) return fail(404, 'not-found');
    const spaceHandle = path[1] as string;
    const account = path[2] === 'account';
    if (request.method !== (account ? 'GET' : 'POST')) return fail(405, 'method-not-allowed');
    const credential = /^Bearer ([A-Za-z0-9_-]{1,128})$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!credential) return fail(401, 'unauthorized');
    const proof = proofQuery.get(spaceHandle) as SpaceProof | undefined;
    if (!proof || !(await verifyCredential(credential, proof.credential_hash))) return fail(401, 'unauthorized');
    if (!proof.epoch) return fail(503, 'space-epoch-unavailable');
    if (account) {
      options.db.exec('BEGIN');
      try {
        const current = proofQuery.get(spaceHandle) as SpaceProof | undefined;
        if (
          !current ||
          current.epoch !== proof.epoch ||
          current.credential_hash !== proof.credential_hash ||
          current.recovery_credential_hash !== proof.recovery_credential_hash
        )
          return fail(409, 'space-changed');
        return Response.json(
          {
            ...ledger.summary(spaceHandle, proof.epoch),
            hostedEnabled: enabled,
            billingBasis: 'public-price-snapshot-unreconciled',
            priceValidUntil: options.priceConfig?.validUntil ?? '2026-10-03T16:00:00.000Z',
            minimumReserveNanoyuan: requiredDeepSeekReserve(1).toString(),
          },
          { headers: { 'cache-control': 'no-store' } },
        );
      } finally {
        options.db.exec('ROLLBACK');
      }
    }
    if (!enabled) return fail(503, 'hosted-disabled');
    const requestId = (request.headers.get('x-request-id') ?? '').toLowerCase();
    if (!REQUEST_UUID.test(requestId)) return fail(400, 'request-id-required');
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
      return fail(415, 'json-required');
    let body: Record<string, unknown>;
    try {
      body = normalizeBody(JSON.parse(await readLimited(request.body, HOSTED_MAX_BODY_BYTES)));
    } catch (error) {
      return fail(codeOf(error) === 'payload-too-large' ? 413 : 400, 'bad-request');
    }
    const maxOutputTokens = body.max_tokens as number;
    const startedAt = now();
    let price: ReturnType<typeof deepSeekPriceAt>;
    try {
      price = deepSeekPriceAt(startedAt, options.priceConfig);
    } catch {
      return fail(503, 'price-unavailable');
    }
    try {
      const reserved = ledger.reserve({
        requestId,
        spaceHandle,
        spaceEpoch: proof.epoch,
        reservedNanoyuan: requiredDeepSeekReserve(maxOutputTokens),
        maxOutputTokens,
        priceVersion: price.version,
        pricePeriod: price.period,
        model: DEEPSEEK_MODEL,
        startedAt: new Date(startedAt).toISOString(),
        proof: { credentialHash: proof.credential_hash, recoveryCredentialHash: proof.recovery_credential_hash },
      });
      if (!reserved.isNew) return fail(409, 'request-already-recorded', { request: reserved.request });
    } catch (error) {
      return ledgerFailure(error);
    }
    if (request.signal.aborted) {
      try {
        ledger.releaseUnsent(requestId);
      } catch {
        /* reserve remains protected */
      }
      return fail(499, 'client-disconnected');
    }
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      controllers.delete(controller);
    };
    try {
      ledger.markSent(requestId);
    } catch {
      cleanup();
      try {
        ledger.releaseUnsent(requestId);
      } catch {
        /* Never release a sent row. */
      }
      return fail(500, 'billing-unavailable');
    }
    let upstream: Response;
    try {
      upstream = await fetchUpstream(UPSTREAM, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      pending(requestId, controller.signal.aborted ? 'upstream-timeout' : 'upstream-disconnected');
      cleanup();
      return fail(502, 'upstream-unavailable');
    }
    if (!upstream.ok) {
      pending(requestId, 'upstream-error');
      await upstream.body?.cancel().catch(() => {});
      cleanup();
      return fail(502, 'upstream-unavailable');
    }
    const settle = (usage: DeepSeekUsage, id?: string): boolean => {
      let finalPrice: ReturnType<typeof deepSeekPriceAt>;
      try {
        finalPrice = deepSeekPriceForInterval(startedAt, now(), options.priceConfig);
      } catch {
        pending(requestId, 'price-boundary', { usage, upstreamId: id });
        return false;
      }
      try {
        ledger.settle({
          requestId,
          usage,
          upstreamId: id,
          model: DEEPSEEK_MODEL,
          chargedNanoyuan: quoteDeepSeekUsage(usage, finalPrice.period),
          priceVersion: finalPrice.version,
          pricePeriod: finalPrice.period,
        });
        return true;
      } catch {
        pending(requestId, 'internal-error', { usage, upstreamId: id });
        return false;
      }
    };
    if (body.stream !== true) {
      try {
        let result: unknown;
        try {
          result = JSON.parse(await readLimited(upstream.body, MAX_RESPONSE_BYTES));
        } catch (error) {
          pending(
            requestId,
            controller.signal.aborted
              ? 'upstream-timeout'
              : codeOf(error) === 'payload-too-large'
                ? 'response-too-large'
                : 'upstream-disconnected',
          );
          return fail(502, 'upstream-incomplete');
        }
        if (!object(result) || result.error !== undefined) {
          pending(requestId, 'upstream-error');
          return fail(502, 'upstream-unavailable');
        }
        let usage: DeepSeekUsage;
        try {
          usage = validateDeepSeekUsage(result.usage, maxOutputTokens);
        } catch {
          pending(requestId, result.usage === undefined ? 'missing-usage' : 'invalid-usage');
          return fail(502, 'usage-unverified');
        }
        if (!settle(usage, upstreamId(result.id))) return fail(502, 'billing-pending');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } finally {
        cleanup();
      }
    }
    if (!upstream.body || !upstream.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      pending(requestId, 'upstream-error');
      await upstream.body?.cancel().catch(() => {});
      cleanup();
      return fail(502, 'upstream-unavailable');
    }
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const encoder = new TextEncoder();
    let clientGone = false;
    let usage: DeepSeekUsage | undefined;
    let id: string | undefined;
    let invalidUsage = false;
    let finished = false;
    let bytes = 0;
    let buffer = '';
    let output: ReadableStreamDefaultController<Uint8Array>;
    let wake: (() => void) | undefined;
    const relay = new ReadableStream<Uint8Array>(
      {
        start(value) {
          output = value;
        },
        pull() {
          wake?.();
          wake = undefined;
        },
        cancel() {
          clientGone = true;
          wake?.();
          wake = undefined;
        },
      },
      { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
    );
    const stopRelay = () => {
      clientGone = true;
      wake?.();
      wake = undefined;
      try {
        output.error(new Error('upstream-incomplete'));
      } catch {
        /* already closed */
      }
      void reader.cancel().catch(() => {});
    };
    controller.signal.addEventListener('abort', stopRelay, { once: true });
    const send = async (chunk: string) => {
      if (clientGone) return;
      while (!clientGone && (output.desiredSize ?? 0) <= 0)
        await new Promise<void>((resume) => {
          wake = resume;
        });
      if (clientGone) return;
      try {
        output.enqueue(encoder.encode(chunk));
      } catch {
        clientGone = true;
      }
    };
    const event = async (raw: string) => {
      const data = raw
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) return;
      if (data === '[DONE]') {
        finished = true;
        return;
      }
      if (finished) throw new Error('upstream-disconnected');
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch {
        throw new Error('upstream-disconnected');
      }
      if (!object(value) || value.error !== undefined) throw new Error('upstream-error');
      id = upstreamId(value.id) ?? id;
      if (value.usage !== undefined && value.usage !== null) {
        try {
          usage = validateDeepSeekUsage(value.usage, maxOutputTokens);
        } catch {
          invalidUsage = true;
        }
      }
      await send(`data: ${JSON.stringify(value)}\n\n`);
    };
    const pump = async () => {
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) {
            buffer += decoder.decode();
            break;
          }
          bytes += part.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw new Error('response-too-large');
          buffer = (buffer + decoder.decode(part.value, { stream: true })).replace(/\r\n/g, '\n');
          for (;;) {
            const index = buffer.indexOf('\n\n');
            if (index < 0) break;
            const raw = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (raw.length > MAX_SSE_EVENT_CHARS) throw new Error('response-too-large');
            await event(raw);
          }
          if (buffer.length > MAX_SSE_EVENT_CHARS) throw new Error('response-too-large');
        }
        if (controller.signal.aborted) throw new Error('upstream-timeout');
        if (buffer.trim() !== '') throw new Error('upstream-disconnected');
        if (!finished) throw new Error('upstream-disconnected');
        if (invalidUsage || !usage) {
          pending(requestId, invalidUsage ? 'invalid-usage' : 'missing-usage', { usage, upstreamId: id });
          await send('data: {"error":{"code":"usage-unverified"}}\n\n');
        } else if (!settle(usage, id)) await send('data: {"error":{"code":"billing-pending"}}\n\n');
        await send('data: [DONE]\n\n');
      } catch (error) {
        const code = codeOf(error);
        pending(
          requestId,
          controller.signal.aborted
            ? 'upstream-timeout'
            : ['upstream-error', 'response-too-large'].includes(code)
              ? code
              : 'upstream-disconnected',
          { usage, upstreamId: id },
        );
        await send('data: {"error":{"code":"upstream-incomplete"}}\n\ndata: [DONE]\n\n');
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        controller.signal.removeEventListener('abort', stopRelay);
        try {
          output.close();
        } catch {
          /* client canceled or timed out */
        }
        cleanup();
      }
    };
    void track(pump());
    return new Response(relay, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
    });
  }
  const handler = (request: Request) => track(run(request).catch(() => fail(500, 'gateway-unavailable')));
  return Object.assign(handler, {
    async idle() {
      while (active.size > 0) await Promise.allSettled([...active]);
    },
    stop() {
      for (const controller of controllers) controller.abort();
    },
  });
}
