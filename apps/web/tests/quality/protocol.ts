import type { ChatToolCall } from '../../../../packages/core/src/prompt/types';
import { canonicalJson } from './evidence';
import { createRawProtocolResponse } from './protocol-response';
import type { WireRequest } from './types';

export class QualityProtocolError extends Error {
  constructor() {
    super('工具多轮协议上下文无法恢复或身份顺序不匹配；已在发送前停止，请勿自动重试。');
    this.name = 'QualityProtocolError';
  }
}

/** Run-local transport adapter shared by both engines. Never put this state in evidence. */
export function createQualityProtocol(signal?: AbortSignal) {
  let closed = false;
  let prefix = '';
  let prefixLength = 0;
  let dispatches = 0;
  const observation = createRawProtocolResponse();
  let pending: { prefix: string; length: number; assistant: string; reasoning: string } | undefined;
  const clear = () => {
    closed = true;
    prefix = '';
    observation.clear();
    pending = undefined;
  };
  signal?.addEventListener('abort', clear, { once: true });
  if (signal?.aborted) clear();
  const assertOpen = () => {
    if (closed || signal?.aborted) throw new QualityProtocolError();
  };
  return {
    prepare(body: WireRequest) {
      assertOpen();
      if (++dispatches > 2) throw new QualityProtocolError();
      const messages = body.messages;
      const assistants = messages.filter((message) => message.tool_calls?.length);
      if (pending) {
        const assistant = messages[pending.length];
        const tools = messages.slice(pending.length + 1);
        const calls = assistant?.tool_calls ?? [];
        if (
          assistants.length !== 1 ||
          canonicalJson(messages.slice(0, pending.length)) !== pending.prefix ||
          canonicalJson(assistant) !== pending.assistant ||
          tools.length !== calls.length ||
          tools.some((tool, index) => tool.role !== 'tool' || tool.tool_call_id !== calls[index]?.id)
        )
          throw new QualityProtocolError();
        // No invented empty chain: this string was captured from the corresponding response.
        if (!assistant) throw new QualityProtocolError();
        assistant.reasoning_content = pending.reasoning;
        pending = undefined;
      } else if (assistants.length || messages.some((message) => message.role === 'tool')) {
        throw new QualityProtocolError();
      }
      // This adapter is intentionally bounded to D02's two-round run, not arbitrary histories.
      prefix = canonicalJson(messages);
      prefixLength = messages.length;
      observation.clear();
    },
    async response(response: Response) {
      assertOpen();
      if (!response.ok) return response;
      if (response.headers.get('content-type')?.includes('text/event-stream')) return observation.stream(response);
      // Production JSON fallback drops reasoning; observe privately without changing its parser.
      const reader = response.clone().body?.getReader();
      if (!reader) return response;
      let raw = '';
      const abortCopy = () => {
        void reader.cancel().catch(() => undefined);
      };
      signal?.addEventListener('abort', abortCopy, { once: true });
      try {
        const decoder = new TextDecoder();
        for (;;) {
          const chunk = await reader.read();
          assertOpen();
          if (chunk.done) break;
          raw += decoder.decode(chunk.value, { stream: true });
        }
        raw += decoder.decode();
        const json: unknown = JSON.parse(raw);
        assertOpen();
        observation.observe(json, false);
      } catch {
        assertOpen();
        // The unchanged production parser owns malformed/error JSON handling.
      } finally {
        raw = '';
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
        signal?.removeEventListener('abort', abortCopy);
      }
      return response;
    },
    complete(text: string, calls: ChatToolCall[]) {
      assertOpen();
      if (!observation.matches(calls)) throw new QualityProtocolError();
      if (calls.length) {
        const reasoning = observation.reasoning();
        if (reasoning === undefined || new Set(calls.map((call) => call.id)).size !== calls.length) {
          throw new QualityProtocolError();
        }
        pending = {
          prefix,
          length: prefixLength,
          assistant: canonicalJson({ role: 'assistant', content: text, tool_calls: calls }),
          reasoning,
        };
      }
      observation.clear();
      prefix = '';
    },
    dispose() {
      clear();
      signal?.removeEventListener('abort', clear);
    },
  };
}
