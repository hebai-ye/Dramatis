import type { ChatToolCall } from '../../../../packages/core/src/prompt/types';

type RawCall = { id?: string; name?: string; arguments?: string };
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** Private raw response observations; never infer fields filled in by the production parser. */
export function createRawProtocolResponse() {
  let reasoning: string | undefined;
  let invalid = false;
  const calls = new Map<number, RawCall>();
  let cancelStream: (() => void) | undefined;
  function observe(value: unknown, streaming: boolean) {
    const payload = record(value);
    const choices = payload?.choices;
    const choice = Array.isArray(choices) ? record(choices[0]) : undefined;
    const message = record(streaming ? (choice?.delta ?? choice?.message) : choice?.message);
    if (!message) return;
    if (Object.hasOwn(message, 'reasoning_content') && message.reasoning_content !== null) {
      if (typeof message.reasoning_content !== 'string') invalid = true;
      else reasoning = (reasoning ?? '') + message.reasoning_content;
    }
    if (!Object.hasOwn(message, 'tool_calls')) return;
    if (message.tool_calls === null) return;
    if (!Array.isArray(message.tool_calls)) {
      invalid = true;
      return;
    }
    for (const [position, item] of message.tool_calls.entries()) {
      const call = record(item);
      const index = streaming ? call?.index : position;
      if (!call || typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
        invalid = true;
        continue;
      }
      const existing = calls.get(index) ?? {};
      const fn = record(call.function);
      if (Object.hasOwn(call, 'id')) {
        if (typeof call.id !== 'string' || call.id === '' || (existing.id !== undefined && existing.id !== call.id))
          invalid = true;
        else existing.id = call.id;
      }
      if (fn && Object.hasOwn(fn, 'name')) {
        if (typeof fn.name !== 'string' || fn.name === '' || (existing.name !== undefined && existing.name !== fn.name))
          invalid = true;
        else existing.name = fn.name;
      }
      if (fn && Object.hasOwn(fn, 'arguments')) {
        if (typeof fn.arguments !== 'string') invalid = true;
        else existing.arguments = (existing.arguments ?? '') + fn.arguments;
      }
      calls.set(index, existing);
    }
  }
  return {
    observe,
    stream(response: Response) {
      const reader = response.body?.getReader();
      if (!reader) return response;
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        buffer = '';
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
        cancelStream = undefined;
      };
      const event = (source: string) => {
        const lines = source
          .split('\n')
          .map((line) => line.trimStart())
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim());
        const standalone = lines.every((line) => {
          if (line === '[DONE]') return true;
          try {
            JSON.parse(line);
            return true;
          } catch {
            return false;
          }
        });
        for (const payload of standalone ? lines : [lines.join('\n')]) {
          if (!payload || finished) continue;
          if (payload === '[DONE]') {
            finished = true;
            continue;
          }
          try {
            observe(JSON.parse(payload), true);
          } catch {
            invalid = true;
          }
        }
      };
      cancelStream = release;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (released) {
                controller.close();
                return;
              }
              buffer += decoder.decode(chunk.value, { stream: !chunk.done });
              buffer = buffer.replace(/\r\n/g, '\n');
              let boundary = buffer.indexOf('\n\n');
              while (boundary >= 0) {
                event(buffer.slice(0, boundary));
                buffer = buffer.slice(boundary + 2);
                boundary = buffer.indexOf('\n\n');
              }
              if (chunk.done) {
                if (buffer.trim()) event(buffer);
                release();
                controller.close();
              } else controller.enqueue(chunk.value);
            } catch (error) {
              release();
              controller.error(error);
            }
          },
          cancel() {
            release();
          },
        }),
        { status: response.status, statusText: response.statusText, headers: response.headers },
      );
    },
    matches(normalized: readonly ChatToolCall[]) {
      const raw = [...calls.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1]);
      return (
        !invalid &&
        raw.length === normalized.length &&
        raw.every((call, index) => {
          const parsed = normalized[index];
          return (
            parsed !== undefined &&
            call.id !== undefined &&
            call.name !== undefined &&
            call.arguments !== undefined &&
            call.id === parsed.id &&
            call.name === parsed.function.name &&
            call.arguments === parsed.function.arguments
          );
        })
      );
    },
    reasoning() {
      return reasoning;
    },
    clear() {
      cancelStream?.();
      reasoning = undefined;
      calls.clear();
      invalid = false;
    },
  };
}
