/** Disposable loopback QA: serves the built product and synthetic SSE; never calls an external service. */

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const root = resolve('apps/web/dist');
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const server = createServer(async (req, res) => {
  res.setHeader('Permissions-Policy', 'clipboard-read=(), clipboard-write=()');
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'synthetic-admin' }] }));
    return;
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let raw = '';
    for await (const part of req) {
      raw += part;
      if (raw.length > 2_000_000) {
        res.writeHead(413);
        res.end();
        return;
      }
    }
    const input = JSON.parse(raw),
      messages = input.messages ?? [];
    const text = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    const afterTools = messages.at(-1)?.role === 'tool';
    console.log(
      JSON.stringify({ at: new Date().toISOString(), path: req.url, afterTools, scenario: text.slice(-100) }),
    );
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    const emit = (delta) => {
      if (!res.destroyed)
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    };
    const finish = () => {
      if (!res.destroyed)
        res.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`,
        );
    };
    if (text.includes('长等待')) await wait(15000);
    else await wait(350);
    if (!text.includes('无思考')) {
      emit({ reasoning_content: '这是本机夹具提供的合成思考：检查草稿与场景目标。' });
      await wait(800);
    }
    if (text.includes('仅思考')) {
      finish();
      return;
    }
    if (afterTools) {
      for (const content of ['已整理好三项结果。', '角色卡和世界书等待采纳，场景已按工具结果处理。']) {
        emit({ content });
        await wait(600);
      }
      finish();
      return;
    }
    emit({ content: '正在为合成世界准备素材。' });
    await wait(600);
    if (text.includes('三工具') || text.includes('解析拒绝')) {
      const tools = text.includes('解析拒绝')
        ? [
            ['unknown_synthetic_tool', {}],
            ['set_scene', { location: 123 }],
          ]
        : [
            [
              'upsert_character_card',
              {
                name: '合成长名的旧城酒馆老板·完整草稿预览',
                description: '只用于本机验收的角色描述。'.repeat(40),
                personality: '谨慎而健谈',
              },
            ],
            [
              'upsert_world_book',
              { name: '合成旧城设定', entries: [{ keys: ['旧城'], content: '合成旧城的钟楼。'.repeat(20) }] },
            ],
            ['set_scene', { title: '合成黄昏码头', location: '合成东码头', summary: '工具即时设置的合成场景' }],
          ];
      emit({
        tool_calls: tools.map(([name, args], index) => ({
          index,
          id: `call_${index}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        })),
      });
    }
    if (text.includes('流式长文'))
      for (let i = 0; i < 24; i++) {
        emit({ content: `\n合成段落 ${i}：用于验证上滚阅读时不会被新内容拉回底部。` });
        await wait(600);
      }
    finish();
    return;
  }
  const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  let path = resolve(root, `.${pathname}`);
  if (path !== root && !path.startsWith(root + sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (path === root || !existsSync(path)) path = resolve(root, 'index.html');
  try {
    res.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    res.end(readFileSync(path));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
server.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () =>
  console.log(`SYNTHETIC_QA http://127.0.0.1:${server.address().port}`),
);
