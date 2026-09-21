#!/usr/bin/env node
/**
 * 本地助手（顺序 38）：把「网页版桥接」从手动复制粘贴变成自动。
 *
 * 它做的事只有一件：**驱动你自己已经登录的那个模型网页标签页**——
 * 把你在这个应用里要发的那段提示词打进去、按发送、等回复、把回复文字交回来。
 * 应用那边的桥接面板因此可以一键完成，用户不用再复制来粘贴去。
 *
 * ```
 * Dramatis（浏览器）  ──HTTP──▶  本地助手（本机 8791）  ──CDP──▶  你的 Chrome 里的
 *   POST /ask {prompt}                零依赖 Node                        chat.deepseek.com 标签页
 * ```
 *
 * ## 怎么用
 *
 * ```bash
 * # 1) 用一个「开着调试端口」的 Chrome 打开模型网页并登录
 * "C:\Program Files\Google\Chrome\Application\chrome.exe" \
 *     --remote-debugging-port=9222 --user-data-dir=%TEMP%\dramatis-deepseek \
 *     https://chat.deepseek.com
 *
 * # 2) 起这个助手
 * node tools/local-bridge/server.mjs --port 8791
 *
 * # 3) 回到应用：没有 API Key 时，桥接面板上会多出一个「用本地助手自动发送」
 * ```
 *
 * ## 三条必须写清楚的事
 *
 * 1. **这不是官方接口**。它驱动的是网页本身，等于「有个手在替你点」。DeepSeek 的
 *    服务条款没有允许这种自动化，账号有被限制的风险。**默认不用**、要用户自己起这个进程。
 * 2. **它只在本机跑，也只连本机的 Chrome**。提示词与回复不经过任何第三方；
 *    但你的会话本来就在那些服务器上，这一点没有变化。
 * 3. **它不偷你的密码，也不需要你的密码**。它连的是你已经登录好的那个浏览器。
 */

import { createServer } from 'node:http';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const PORT = Number(portIndex === -1 ? 8791 : args[portIndex + 1]);
const cdpIndex = args.indexOf('--cdp');
/** Chrome 的调试端口：`--remote-debugging-port` 那个数。 */
const CDP_PORT = Number(cdpIndex === -1 ? 9222 : args[cdpIndex + 1]);

/**
 * 认哪个标签页是「模型网页」：地址里包含这段就算。
 *
 * 可以用 `--pattern` 换掉（换站点、或者拿一个本地假页面做验证时）。
 */
const patternIndex = args.indexOf('--pattern');
const TARGET_PATTERN = patternIndex === -1 ? 'chat.deepseek.com' : args[patternIndex + 1];
/** 等回复时每轮之间停多久。 */
const POLL_MS = 1200;
/** 连续多少次「内容没变」就算写完了（3 次大约 3.6 秒）。 */
const STABLE_ROUNDS = 3;

function cors(response) {
  // 只允许本机页面调用：应用跑在 https://dramatissync.com 或本机 5273 上
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'content-type');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
}

function send(response, status, body) {
  cors(response);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** 问 Chrome 要「现在有哪些标签页」。 */
async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json`);
  if (!response.ok) throw new Error(`Chrome 的调试端口回了 ${String(response.status)}。`);
  return await response.json();
}

/** 找到模型网页那个标签页。找不到时给的提示要具体到「该怎么办」。 */
async function findTarget() {
  let targets;
  try {
    targets = await listTargets();
  } catch (error) {
    throw new Error(
      `连不上 Chrome 的调试端口（${String(CDP_PORT)}）：${error instanceof Error ? error.message : String(error)}。` +
        `先用 --remote-debugging-port=${String(CDP_PORT)} 重启 Chrome，再打开模型网页并登录。`,
    );
  }
  const page = targets.find((target) => target.type === 'page' && String(target.url).includes(TARGET_PATTERN));
  if (page === undefined) {
    throw new Error(`没找到 ${TARGET_PATTERN} 的标签页：先在那个 Chrome 里打开它并登录。`);
  }
  return page;
}

/** 一个极小的 CDP 客户端：连上某个标签页，发命令、等回答。 */
async function withCdp(target, work) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('连不上那个标签页的调试通道。')), { once: true });
  });

  socket.addEventListener('message', (event) => {
    let payload;
    try {
      payload = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const waiter = pending.get(payload.id);
    if (waiter === undefined) return;
    pending.delete(payload.id);
    waiter(payload);
  });

  const call = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  try {
    return await work(call);
  } finally {
    socket.close();
  }
}

/** 在页面里跑一段表达式，拿它的值。 */
async function evaluate(call, expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.result?.exceptionDetails !== undefined) {
    throw new Error(`页面里那段脚本出错了：${String(result.result.exceptionDetails.text ?? '')}`);
  }
  return result.result?.result?.value;
}

/**
 * 「输入框在哪、怎么发、怎么读回复」各站点不一样，全写在下面这一处：
 * 换站点时只改这里。
 */
const SELECTORS = {
  composer: 'textarea',
  sendButton: 'button[type="submit"], button[aria-label*="发送"], button[aria-label*="Send"]',
  messages: '[class*="message"], [class*="Message"], [data-message-author-role]',
};

async function readLastReply(call) {
  const expression = `(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(SELECTORS.messages)})];
    const last = nodes[nodes.length - 1];
    if (last === undefined) return '';
    return (last.innerText ?? '').trim();
  })()`;
  return String((await evaluate(call, expression)) ?? '');
}

/** 把提示词填进输入框。用原生 setter + input 事件，受控输入（React 那类）才认。 */
async function fillComposer(call, prompt) {
  const expression = `(() => {
    const box = document.querySelector(${JSON.stringify(SELECTORS.composer)});
    if (box === null) return 'no-composer';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter !== undefined) setter.call(box, ${JSON.stringify(prompt)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus();
    return 'ok';
  })()`;
  const result = await evaluate(call, expression);
  if (result !== 'ok') throw new Error('在页面上没找到输入框（站点的结构可能变了）。');
}

async function clickSend(call) {
  const expression = `(() => {
    const button = document.querySelector(${JSON.stringify(SELECTORS.sendButton)});
    if (button !== null) { button.click(); return 'clicked'; }
    const box = document.querySelector(${JSON.stringify(SELECTORS.composer)});
    if (box === null) return 'no-composer';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return 'enter';
  })()`;
  const result = await evaluate(call, expression);
  if (result === 'no-composer') throw new Error('页面上没有输入框，发不出去。');
}

/**
 * 等回复：每隔一会儿读一次「最后一条消息」，连续几轮不变就当写完了。
 *
 * 为什么不用「等那个『停止生成』按钮消失」：那是站点自己才知道的状态，换站点就得重写；
 * 而「内容稳定下来了」这个判据在哪都成立，也不需要认识站点的任何按钮。
 */
async function waitForReply(call, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  let stable = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const current = await readLastReply(call);
    if (current === '' || current === previous) {
      if (current !== '') stable += 1;
      if (stable >= STABLE_ROUNDS) return current;
      continue;
    }
    previous = current;
    stable = 0;
  }
  throw new Error(`等了 ${String(Math.round(timeoutMs / 1000))} 秒还没写完（可能它在思考，也可能页面变了）。`);
}

const server = createServer((request, response) => {
  void (async () => {
    const url = request.url ?? '/';
    if (request.method === 'OPTIONS') {
      cors(response);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === 'GET' && url.startsWith('/health')) {
      try {
        const target = await findTarget();
        send(response, 200, { ok: true, attached: true, page: target.url, cdpPort: CDP_PORT });
      } catch (error) {
        send(response, 200, {
          ok: true,
          attached: false,
          cdpPort: CDP_PORT,
          hint: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (request.method === 'POST' && url.startsWith('/ask')) {
      try {
        const body = JSON.parse(await readBody(request));
        const prompt = typeof body.prompt === 'string' ? body.prompt : '';
        if (prompt.trim() === '') {
          send(response, 400, { error: 'prompt 不能是空的。' });
          return;
        }
        const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : 180_000;

        const target = await findTarget();
        const text = await withCdp(target, async (call) => {
          await call('Runtime.enable');
          await fillComposer(call, prompt);
          await clickSend(call);
          return await waitForReply(call, timeoutMs);
        });

        process.stdout.write(`[local-bridge] 发出 ${String(prompt.length)} 字，收回 ${String(text.length)} 字\n`);
        send(response, 200, { text });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[local-bridge] 失败：${message}\n`);
        send(response, 500, { error: message });
      }
      return;
    }

    send(response, 404, { error: '没有这个接口（只有 /health 与 /ask）。' });
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(
    `本地助手：http://127.0.0.1:${String(PORT)}（要连的 Chrome 调试端口 ${String(CDP_PORT)}，目标 ${TARGET_PATTERN}）\n`,
  );
  process.stdout.write('提醒：它驱动的是网页本身，不是官方接口；请先确认你接受这件事再长期开着。\n');
});
