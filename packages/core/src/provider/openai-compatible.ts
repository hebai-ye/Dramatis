import type { ChatMessage } from '../prompt/types.js';

export interface ModelParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export type ChatStreamEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'done'; usage: TokenUsage | null };

export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  chat(messages: ChatMessage[], params?: ModelParams, signal?: AbortSignal): AsyncIterable<ChatStreamEvent>;
  listModels(signal?: AbortSignal): Promise<string[]>;
}

export interface ProviderConfig {
  /** 展示用标识，默认 'openai-compatible'。 */
  id?: string;
  /** 形如 https://api.openai.com/v1 或 https://api.deepseek.com 。 */
  baseUrl: string;
  /** 用户自带的 API Key，仅存在本地。 */
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
  /** 让服务端在流末尾返回 usage；部分服务商不认这个字段，默认关闭。 */
  includeUsage?: boolean;
  /** 注入 fetch 便于测试。 */
  fetchImpl?: typeof fetch;
}

export class ProviderError extends Error {
  readonly status: number | null;
  readonly body: string;

  constructor(message: string, status: number | null, body: string) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.body = body;
  }
}

export interface Endpoints {
  chat: string;
  models: string;
}

/**
 * 推导接口地址。
 *
 * 用户可能填三种形式：`https://api.openai.com`、`https://api.openai.com/v1`，
 * 或直接填完整端点。只填域名时补 `/v1`，这是 OpenAI、DeepSeek、
 * Ollama、LM Studio 等绝大多数服务商的兼容路径。
 */
export function resolveEndpoints(baseUrl: string): Endpoints {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    throw new ProviderError('接口地址不能为空', null, '');
  }

  if (trimmed.endsWith('/chat/completions')) {
    return { chat: trimmed, models: trimmed.replace(/\/chat\/completions$/, '/models') };
  }

  try {
    const url = new URL(trimmed);
    if (url.pathname === '' || url.pathname === '/') {
      return { chat: `${trimmed}/v1/chat/completions`, models: `${trimmed}/v1/models` };
    }
  } catch {
    throw new ProviderError(`接口地址不是合法的 URL：${baseUrl}`, null, '');
  }

  return { chat: `${trimmed}/chat/completions`, models: `${trimmed}/models` };
}

function toUsage(raw: unknown): TokenUsage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const usage: TokenUsage = {};
  if (typeof record.prompt_tokens === 'number') usage.promptTokens = record.prompt_tokens;
  if (typeof record.completion_tokens === 'number') usage.completionTokens = record.completion_tokens;
  return Object.keys(usage).length > 0 ? usage : null;
}

interface DeltaPayload {
  choices?: Array<{
    delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
    message?: { content?: unknown };
  }>;
  usage?: unknown;
  error?: { message?: unknown };
}

/** 从一份 SSE 事件块里抽出文本增量。 */
function parseChunk(payload: string, raw: string): { content: string; reasoning: string; usage: TokenUsage | null } {
  let json: DeltaPayload;
  try {
    json = JSON.parse(payload) as DeltaPayload;
  } catch {
    return { content: '', reasoning: '', usage: null };
  }

  if (json.error) {
    const message = typeof json.error.message === 'string' ? json.error.message : '服务端返回了错误';
    throw new ProviderError(message, null, raw);
  }

  const choice = json.choices?.[0];
  const delta = choice?.delta;

  const content =
    typeof delta?.content === 'string'
      ? delta.content
      : typeof choice?.message?.content === 'string'
        ? choice.message.content
        : '';

  const reasoning =
    typeof delta?.reasoning_content === 'string'
      ? delta.reasoning_content
      : typeof delta?.reasoning === 'string'
        ? delta.reasoning
        : '';

  return { content, reasoning, usage: toUsage(json.usage) };
}

async function* iterateSse(res: Response): AsyncIterable<string> {
  const body = res.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        yield buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
      }
    }

    if (buffer.trim() !== '') yield buffer;
  } finally {
    reader.releaseLock();
  }
}

/**
 * OpenAI 兼容协议的服务商接入（设计文档 §8.3：模型接入由用户自带 Key）。
 *
 * 覆盖 OpenAI、DeepSeek、兼容网关、通义、Kimi、Ollama、LM Studio 等一切
 * 提供 `/chat/completions` 的服务。内核不代理请求，流量由客户端直连服务商。
 */
export function createOpenAICompatibleProvider(config: ProviderConfig): ModelProvider {
  const endpoints = resolveEndpoints(config.baseUrl);
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const buildHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(config.headers ?? {}),
    };
    if (config.apiKey.trim() !== '') {
      headers.Authorization = `Bearer ${config.apiKey.trim()}`;
    }
    return headers;
  };

  return {
    id: config.id ?? 'openai-compatible',
    model: config.model,

    async *chat(messages: ChatMessage[], params: ModelParams = {}, signal?: AbortSignal) {
      const body: Record<string, unknown> = {
        model: config.model,
        messages,
        stream: true,
      };

      if (params.temperature !== undefined) body.temperature = params.temperature;
      if (params.topP !== undefined) body.top_p = params.topP;
      if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
      if (params.stop !== undefined && params.stop.length > 0) body.stop = params.stop;
      if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
      if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty;
      if (config.includeUsage === true) body.stream_options = { include_usage: true };

      const init: RequestInit = {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(body),
      };
      if (signal !== undefined) init.signal = signal;

      const res = await fetchImpl(endpoints.chat, init);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderError(`模型服务返回 ${res.status}`, res.status, text.slice(0, 2000));
      }

      const contentType = res.headers.get('content-type') ?? '';
      let usage: TokenUsage | null = null;

      // 部分本地服务会忽略 stream 参数，这里做一次非流式回退
      if (!contentType.includes('text/event-stream')) {
        const json = (await res.json()) as DeltaPayload;
        const choice = json.choices?.[0];
        const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
        if (text !== '') yield { type: 'text' as const, text };
        yield { type: 'done' as const, usage: toUsage(json.usage) };
        return;
      }

      let emittedDone = false;

      for await (const event of iterateSse(res)) {
        for (const line of event.split('\n')) {
          const trimmed = line.trim();
          if (trimmed === '' || trimmed.startsWith(':')) continue;
          if (!trimmed.startsWith('data:')) continue;

          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') {
            emittedDone = true;
            yield { type: 'done' as const, usage };
            return;
          }

          const chunk = parseChunk(payload, event);
          if (chunk.usage) usage = chunk.usage;
          if (chunk.reasoning !== '') yield { type: 'reasoning' as const, text: chunk.reasoning };
          if (chunk.content !== '') yield { type: 'text' as const, text: chunk.content };
        }
      }

      if (!emittedDone) {
        yield { type: 'done' as const, usage };
      }
    },

    async listModels(signal?: AbortSignal): Promise<string[]> {
      const init: RequestInit = { method: 'GET', headers: buildHeaders() };
      if (signal !== undefined) init.signal = signal;

      const res = await fetchImpl(endpoints.models, init);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderError(`获取模型列表失败（${res.status}）`, res.status, text.slice(0, 500));
      }

      const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
      return (json.data ?? [])
        .map((item) => item.id)
        .filter((id): id is string => typeof id === 'string' && id !== '');
    },
  };
}
