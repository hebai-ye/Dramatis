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
 * node tools/fake-model/server.mjs --reasoning --chunk-ms 120   # 模拟「先流推理、再流正文」的模型
 * ```
 *
 * 然后在应用的「模型接入」里填 接口地址 `http://127.0.0.1:5280`、模型 `fake-model`、
 * 密钥随便填一个非空字符串。
 */
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const PORT = Number(portIndex === -1 ? 5280 : args[portIndex + 1]);
/** 每块之间的间隔：用来观察「流式到底有没有在动」（默认不睡，跑得最快）。 */
const chunkIndex = args.indexOf('--chunk-ms');
const CHUNK_MS = Number(chunkIndex === -1 ? 0 : args[chunkIndex + 1]);
/** 先流一段推理流，再流正文：模仿 deepseek-reasoner 那种「先想很久」的形态。 */
const WITH_REASONING = args.includes('--reasoning');
const HOST = '127.0.0.1';

/** 一次请求的判定结果。 */
function classify(text) {
  if (text.includes('"speakers"') || text.includes('mode 取四种之一')) return 'intent';
  if (text.includes('"observations"') && text.includes('updates')) return 'analysis';
  if (text.includes('keyFacts')) return 'summary';
  // 记忆合并的那段提示词（顺序 27a）：它既不是意图也不是分析，单独认出来
  if (text.includes('压成 1–3 句')) return 'consolidate';
  return 'generate';
}

/** 稳定的小哈希：用来让「重要度」按请求内容轮流取不同的值。 */
function hashOf(text) {
  let hash = 7;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 1_000_003;
  }
  return hash;
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

  if (kind === 'consolidate') {
    // 合并的回复：1–3 句「印象」。假模型只求形态对（真模型才会写得像人话）。
    return `${place === '' ? '这段时间' : `在${place}的这段时间`}我一直在留意账房那边的动静，也答应过${speaker}先不声张。`;
  }

  if (kind === 'analysis') {
    /*
     * 重要度**给一个分布**，不要固定一个数。
     *
     * 原来是恒定的 0.45——于是本机演练永远测不到「低重要度那一档」：
     * 记忆合并（顺序 27a）只在 ≤0.5 的记忆上动手，恒定 0.45 时门槛两侧
     * 其实都碰不到真实形态。现在按请求内容轮流给 0.3 / 0.45 / 0.7，
     * 让「该合并的」和「该留着的」同时存在。
     */
    const importance = [0.3, 0.45, 0.7][Math.abs(hashOf(text)) % 3];
    return JSON.stringify({
      summary: place === '' ? '玩家又追问了一句，角色答了话。' : `玩家在${place}追问了一句，角色答了话。`,
      importance,
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

async function sse(res, status, cors, chunks, chunkMs = 0) {
  res.writeHead(status, {
    ...cors,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    // 有间隔才是真的「流式」：用它来观察界面有没有一段段地长出来
    if (chunkMs > 0) await new Promise((resolve) => setTimeout(resolve, chunkMs));
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
      // 模仿推理模型：先把推理流一段段吐完，再吐正文
      ...(WITH_REASONING
        ? '先看这一轮谁在场、他刚才说了什么，再决定用哪种语气回。'.match(/[\s\S]{1,12}/g).map((piece) => ({
            id: 'fake-1',
            object: 'chat.completion.chunk',
            model: parsed.model ?? 'fake-model',
            choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }],
          }))
        : []),
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

    sse(res, 200, cors, chunks, CHUNK_MS);
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`假模型服务：http://${HOST}:${String(PORT)}/v1（模型 fake-model）\n`);
});
