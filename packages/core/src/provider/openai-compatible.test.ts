/**
 * 审计 B10：流式失败的边角。
 */
import { describe, expect, it, vi } from 'vitest';
import { createOpenAICompatibleProvider, ProviderError } from './openai-compatible.js';

function providerFor(response: Response | (() => Response), onWarning?: (message: string) => void) {
  return createOpenAICompatibleProvider({
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-test',
    model: 'm',
    fetchImpl: async () => (typeof response === 'function' ? response() : response),
    ...(onWarning === undefined ? {} : { onWarning }),
  });
}

async function run(provider: ReturnType<typeof providerFor>): Promise<{ text: string; types: string[] }> {
  let text = '';
  const types: string[] = [];
  for await (const event of provider.chat([{ role: 'user', content: 'hi' }])) {
    types.push(event.type);
    if (event.type === 'text') text += event.text;
  }
  return { text, types };
}

const sse = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const json = (body: string) => new Response(body, { headers: { 'content-type': 'application/json' } });

describe('非流式回退（审计 B10）', () => {
  it('200 + error 体：抛 ProviderError，不当空回复', async () => {
    const provider = providerFor(json(JSON.stringify({ error: { message: '余额不足' } })));
    await expect(run(provider)).rejects.toThrow('余额不足');
    await expect(run(providerFor(json(JSON.stringify({ error: '网关挂了' }))))).rejects.toBeInstanceOf(ProviderError);
  });

  it('非 JSON（HTML 错误页）：抛 ProviderError 而不是 SyntaxError', async () => {
    const provider = providerFor(json('<html>502 Bad Gateway</html>'));
    await expect(run(provider)).rejects.toBeInstanceOf(ProviderError);
    await expect(run(providerFor(json('<html></html>')))).rejects.toThrow('不是可识别的 JSON');
  });

  it('正常 JSON 照旧', async () => {
    const provider = providerFor(
      json(JSON.stringify({ choices: [{ message: { content: '好' }, finish_reason: 'stop' }] })),
    );
    expect((await run(provider)).text).toBe('好');
  });

  it('200 但没有任何 choice：报错，不落空回复', async () => {
    await expect(run(providerFor(json('{}')))).rejects.toThrow('没有返回任何回复内容');
  });
});

describe('流里夹着错误体（审计 B10）', () => {
  it('流到一半服务端塞一条 error：抛 ProviderError，不落半条回复', async () => {
    const provider = providerFor(
      sse('data: {"choices":[{"delta":{"content":"半"}}]}\n\ndata: {"error":{"message":"额度用完了"}}\n\n'),
    );
    await expect(run(provider)).rejects.toThrow('额度用完了');
  });

  it('error 是字符串也认', async () => {
    await expect(run(providerFor(sse('data: {"error":"网关挂了"}\n\n')))).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('未知 finish_reason 只警告（审计 B10）', () => {
  it.each(['eos', 'end_turn', 'STOP', 'stop_sequence'])('%s：回复照常保存，并记一条警告', async (reason) => {
    const warn = vi.fn();
    const provider = providerFor(
      () =>
        sse(
          `data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"${reason}"}]}\n\ndata: [DONE]\n\n`,
        ),
      warn,
    );
    expect((await run(provider)).text).toBe('好');
    if (reason !== 'STOP') expect(warn).toHaveBeenCalledTimes(1);
  });

  it('大写 LENGTH 仍然拦下', async () => {
    const provider = providerFor(
      sse('data: {"choices":[{"delta":{"content":"半"},"finish_reason":"LENGTH"}]}\n\ndata: [DONE]\n\n'),
      () => undefined,
    );
    await expect(run(provider)).rejects.toThrow('长度上限');
  });

  it('别名 max_tokens 也算长度上限', async () => {
    const provider = providerFor(
      sse('data: {"choices":[{"delta":{"content":"半"},"finish_reason":"max_tokens"}]}\n\ndata: [DONE]\n\n'),
      () => undefined,
    );
    await expect(run(provider)).rejects.toThrow('长度上限');
  });

  it('非流式回的未知 finish_reason 同样只警告', async () => {
    const warn = vi.fn();
    const provider = providerFor(
      json(JSON.stringify({ choices: [{ message: { content: '好' }, finish_reason: 'eos' }] })),
      warn,
    );
    expect((await run(provider)).text).toBe('好');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('SSE 多行 data（审计 B10）', () => {
  it('规范写法：一个事件里多行 data 拼成一份 JSON', async () => {
    const provider = providerFor(
      sse(
        'data: {"choices":[{"delta":\ndata: {"content":"拼起来"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ),
    );
    expect((await run(provider)).text).toBe('拼起来');
  });

  it('不规范写法：每行一个完整 JSON、单换行分隔，照旧逐行处理', async () => {
    const provider = providerFor(
      sse(
        'data: {"choices":[{"delta":{"content":"一"}}]}\ndata: {"choices":[{"delta":{"content":"二"},"finish_reason":"stop"}]}\ndata: [DONE]\n\n',
      ),
    );
    expect((await run(provider)).text).toBe('一二');
  });
});

describe('提前退出时取消流（审计 B10）', () => {
  it('上层 break 之后底层流被 cancel', async () => {
    const cancel = vi.fn();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"一"}}]}\n\n'));
      },
      cancel,
    });
    const provider = providerFor(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    for await (const event of provider.chat([{ role: 'user', content: 'hi' }])) {
      if (event.type === 'text') break;
    }
    expect(cancel).toHaveBeenCalled();
  });
});
