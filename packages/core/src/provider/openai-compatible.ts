import type { ChatMessage, ChatToolCall, ToolDefinition } from '../prompt/types.js';

export interface ModelParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
  /**
   * 可用工具（副对话的真实工具调用，LAYOUT「副对话状态」）。
   *
   * 只有声明了 tools 的请求才有可能拿到 tool_calls；普通角色扮演回合
   * 不声明，模型也就不会去做工具调用。
   */
  tools?: readonly ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export type ChatStreamEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'done'; usage: TokenUsage | null; toolCalls?: ChatToolCall[] };

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
    finish_reason?: unknown;
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
      reasoning?: unknown;
      tool_calls?: unknown;
    };
    message?: { content?: unknown; tool_calls?: unknown };
  }>;
  usage?: unknown;
  error?: { message?: unknown };
}

interface RawToolCall {
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

/**
 * 累积中的工具调用。
 *
 * 流式返回时工具调用是**按片段拼出来的**：先给 index 与函数名，
 * 参数 JSON 再一段一段地流过来。必须按 index 归并，否则参数会被拼坏。
 */
type ToolCallBuffer = Map<number, { id: string; name: string; arguments: string }>;

function mergeToolCalls(buffer: ToolCallBuffer, raw: unknown): void {
  if (!Array.isArray(raw)) return;

  for (const [fallbackIndex, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null) continue;
    const call = item as RawToolCall;
    const index =
      typeof (item as { index?: unknown }).index === 'number' ? (item as { index: number }).index : fallbackIndex;

    const existing = buffer.get(index) ?? { id: '', name: '', arguments: '' };
    if (typeof call.id === 'string' && call.id !== '') existing.id = call.id;
    if (typeof call.function?.name === 'string' && call.function.name !== '') existing.name = call.function.name;
    if (typeof call.function?.arguments === 'string') existing.arguments += call.function.arguments;
    buffer.set(index, existing);
  }
}

function finishToolCalls(buffer: ToolCallBuffer): ChatToolCall[] {
  return [...buffer.entries()]
    .sort((left, right) => left[0] - right[0])
    .flatMap(([, call], index) =>
      call.name === ''
        ? []
        : [
            {
              id: call.id === '' ? `call_${String(index)}` : call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: call.arguments === '' ? '{}' : call.arguments },
            },
          ],
    );
}

/** 从一份 SSE 事件块里抽出文本增量。 */
function parseChunk(
  payload: string,
  raw: string,
  toolCalls: ToolCallBuffer,
): { content: string; reasoning: string; usage: TokenUsage | null; finishReason: string | null } {
  let json: DeltaPayload;
  try {
    json = JSON.parse(payload) as DeltaPayload;
  } catch {
    throw new ProviderError('模型返回了损坏的数据片段，本轮未保存不完整的回复。', null, raw);
  }

  if (json.error) {
    const message = typeof json.error.message === 'string' ? json.error.message : '服务端返回了错误';
    throw new ProviderError(message, null, raw);
  }

  const choice = json.choices?.[0];
  const delta = choice?.delta;

  mergeToolCalls(toolCalls, delta?.tool_calls ?? choice?.message?.tool_calls);

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

  return {
    content,
    reasoning,
    usage: toUsage(json.usage),
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
  };
}

/** A partial or filtered completion must never be stored as a finished character reply. */
function assertComplete(reason: string | null): void {
  if (reason === 'length') {
    throw new ProviderError('模型输出达到长度上限，本轮未保存不完整的回复。请调整模型配置后重试。', null, '');
  }
  if (reason === 'content_filter') {
    throw new ProviderError('模型服务拦截了本轮内容，本轮没有生成完整回复。', null, '');
  }
  if (reason === 'insufficient_system_resource' || reason === 'aborted') {
    throw new ProviderError('模型服务中止了本轮生成，请稍后重试。', null, '');
  }
  if (reason !== null && reason !== 'stop' && reason !== 'tool_calls') {
    throw new ProviderError(`模型服务以未知状态结束（${reason}），本轮未保存回复。`, null, '');
  }
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

  /**
   * 把内部消息翻译成接口认的形状。
   *
   * 大部分字段同名，只有工具相关的是特例：请求工具用 `tool_calls`，
   * 回填结果用 `tool_call_id`。这一步不能省——直接 JSON 序列化内部结构
   * 会把这两个字段悄悄丢掉，模型就会一直重复调用同一个工具。
   */
  const toWireMessages = (messages: readonly ChatMessage[]): Array<Record<string, unknown>> =>
    messages.map((message) => {
      const wire: Record<string, unknown> = { role: message.role, content: message.content };
      if (message.toolCalls !== undefined && message.toolCalls.length > 0) wire.tool_calls = message.toolCalls;
      if (message.toolCallId !== undefined) wire.tool_call_id = message.toolCallId;
      return wire;
    });

  return {
    id: config.id ?? 'openai-compatible',
    model: config.model,

    async *chat(messages: ChatMessage[], params: ModelParams = {}, signal?: AbortSignal) {
      const body: Record<string, unknown> = {
        model: config.model,
        messages: toWireMessages(messages),
        stream: true,
      };

      if (params.temperature !== undefined) body.temperature = params.temperature;
      if (params.topP !== undefined) body.top_p = params.topP;
      if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
      if (params.stop !== undefined && params.stop.length > 0) body.stop = params.stop;
      if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
      if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty;
      if (params.tools !== undefined && params.tools.length > 0) body.tools = params.tools;
      if (params.toolChoice !== undefined) body.tool_choice = params.toolChoice;
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
        assertComplete(typeof choice?.finish_reason === 'string' ? choice.finish_reason : null);
        const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
        const nonStreamCalls: ToolCallBuffer = new Map();
        mergeToolCalls(nonStreamCalls, choice?.message?.tool_calls);
        const calls = finishToolCalls(nonStreamCalls);
        if (text !== '') yield { type: 'text' as const, text };
        yield {
          type: 'done' as const,
          usage: toUsage(json.usage),
          ...(calls.length > 0 ? { toolCalls: calls } : {}),
        };
        return;
      }

      let finishReason: string | null = null;
      const toolCallBuffer: ToolCallBuffer = new Map();

      for await (const event of iterateSse(res)) {
        for (const line of event.split('\n')) {
          const trimmed = line.trim();
          if (trimmed === '' || trimmed.startsWith(':')) continue;
          if (!trimmed.startsWith('data:')) continue;

          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') {
            assertComplete(finishReason);
            const calls = finishToolCalls(toolCallBuffer);
            yield { type: 'done' as const, usage, ...(calls.length > 0 ? { toolCalls: calls } : {}) };
            return;
          }

          const chunk = parseChunk(payload, event, toolCallBuffer);
          if (chunk.finishReason !== null) finishReason = chunk.finishReason;
          if (chunk.usage) usage = chunk.usage;
          if (chunk.reasoning !== '') yield { type: 'reasoning' as const, text: chunk.reasoning };
          if (chunk.content !== '') yield { type: 'text' as const, text: chunk.content };
        }
      }

      if (finishReason !== null) {
        assertComplete(finishReason);
        const calls = finishToolCalls(toolCallBuffer);
        yield { type: 'done' as const, usage, ...(calls.length > 0 ? { toolCalls: calls } : {}) };
      } else {
        throw new ProviderError('模型连接在完成标记前中断，本轮未保存不完整的回复。', null, '');
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
      return (json.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === 'string' && id !== '');
    },
  };
}
