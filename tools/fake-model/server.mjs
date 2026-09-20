#!/usr/bin/env node
/**
 * 假模型服务（开发用，零依赖）。
 *
 * 目的：让「一整轮对话」能在本机**不花钱、可重复**地跑完——真实生成、意图判断、
 * 一轮分析（抽取 + 情绪推演）各一次调用，形状与真服务商完全一致（OpenAI 兼容 +
 * SSE 流）。界面回归、自动化验证、以后安卓真机联调都用它当模型。
 *
 * 它不假装聪明：按请求里出现的提示词特征分派到几种固定回答，
 * 其余（角色生成）返回一句 canned 的剧中台词。每个请求都会打到 stderr，
 * 方便核对「这一回合到底发了几次调用」。
 *
 * 用它：
 *
 * ```bash
 * node tools/fake-model/server.mjs            # 默认 127.0.0.1:5280
 * node tools/fake-model/server.mjs --port 5290
 * ```
 *
 * 然后在应用的「模型接入」里填 接口地址 `http://127.0.0.1:5280`、模型 `fake-model`、
 * 密钥随便填一个非空字符串。
 */
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const PORT = Number(portIndex === -1 ? 5280 : args[portIndex + 1]);
const HOST = '127.0.0.1';

/** 一次请求的判定结果。 */
function classify(text) {
  if (text.includes('"speakers"') || text.includes('mode 取四种之一')) return 'intent';
  if (text.includes('"observations"') && text.includes('updates')) return 'analysis';
  if (text.includes('keyFacts')) return 'summary';
  return 'generate';
}

/** 从提示词里抠出「在场角色：A、B、C」里的名字。 */
function castOf(text) {
  const match = /在场角色：(.+)/.exec(text);
  if (match === null) return [];
  return (match[1] ?? '')
    .split(/[、,]/)
    .map((name) => name.trim())
    .filter((name) => name !== '' && name !== '无' && !name.includes('未指定'));
}

function locationOf(text) {
  const match = /地点：(.+)/.exec(text);
  if (match === null) return '';
  const value = (match[1] ?? '').trim();
  return value === '未指定' ? '' : value;
}

/** 最后一条玩家说的话，用来让 canned 回复读起来像在接话。 */
function lastPlayerLine(text) {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim();
    if (line === '' || !line.includes('：')) continue;
    if (/^(地点|时间|玩家扮演|在场角色|对话)/.test(line)) continue;
    return line.slice(line.indexOf('：') + 1).trim();
  }
  return '';
}

function replyFor(kind, text) {
  const cast = castOf(text);
  const speaker = cast[0] ?? '小满';
  const place = locationOf(text);

  if (kind === 'intent') {
    return JSON.stringify({
      speakers: [{ name: speaker, intent: '先试探对方的来意，不急着交底', mode: 'reply' }],
    });
  }

  if (kind === 'analysis') {
    return JSON.stringify({
      summary: place === '' ? '玩家又追问了一句，角色答了话。' : `玩家在${place}追问了一句，角色答了话。`,
      importance: 0.45,
      location: '',
      observations: cast.map((name, index) => ({
        speaker: name,
        perception: index === 0 ? '他问得这么细，八成已经知道点什么了。' : '这话得记在心里，回头对得上。',
      })),
      updates: cast.slice(0, 1).map((name) => ({
        observer: name,
        deltaValence: 0.05,
        deltaArousal: 0.05,
        reason: '被追问了一句，警觉起来。',
      })),
    });
  }

  if (kind === 'summary') {
    return JSON.stringify({
      summary: '这一段里玩家反复追问货的来路，角色各自挡了一半话。',
      keyFacts: ['货单没上总账', '旧图在陈九手上'],
    });
  }

  const echo = lastPlayerLine(text);
  const tail = echo === '' ? '你别问了。' : '这事我记得。';
  return `「${tail}」${speaker}把手里的东西放下，抬眼看了看${place === '' ? '门口' : place}。\n\n他没再往下说。`;
}

function sse(res, status, cors, chunks) {
  res.writeHead(status, {
    ...cors,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const url = req.url ?? '';
  if (req.method === 'GET' && url.endsWith('/models')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
    return;
  }

  if (req.method !== 'POST' || !url.includes('/chat/completions')) {
    res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '假模型只有 /v1/chat/completions 这一个入口' } }));
    return;
  }

  let body = '';
  req.on('data', (piece) => {
    body += piece;
  });
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = {};
    }

    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const text = messages.map((message) => `${String(message.role)}:${String(message.content ?? '')}`).join('\n');
    const kind = classify(text);
    const content = replyFor(kind, text);
    const promptChars = text.length;
    const usage = {
      prompt_tokens: Math.ceil(promptChars / 2),
      completion_tokens: Math.ceil(content.length / 2),
      total_tokens: 0,
    };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

    process.stderr.write(`[fake-model] ${kind} · 提示 ${String(promptChars)} 字 · 输出 ${String(content.length)} 字\n`);

    const wantUsage = parsed.stream_options?.include_usage === true;
    const chunks = [
      {
        id: 'fake-1',
        object: 'chat.completion.chunk',
        model: parsed.model ?? 'fake-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      },
      ...content.match(/[\s\S]{1,24}/g).map((piece) => ({
        id: 'fake-1',
        object: 'chat.completion.chunk',
        model: parsed.model ?? 'fake-model',
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      })),
    ];
    if (wantUsage) {
      chunks.push({
        id: 'fake-1',
        object: 'chat.completion.chunk',
        model: parsed.model ?? 'fake-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage,
      });
    }

    sse(res, 200, cors, chunks);
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`假模型服务：http://${HOST}:${String(PORT)}/v1（模型 fake-model）\n`);
});
