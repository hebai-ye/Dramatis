#!/usr/bin/env node
/**
 * Local CDP bridge. A page is writable only after it exposes the strict
 * data-local-bridge contract described in README.md.
 */

import { createServer } from 'node:http';
import { runTargetAsk } from './ask-flow.mjs';
import {
  checkAccess,
  clampTimeout,
  createSerialQueue,
  DEFAULT_ALLOWED_ORIGINS,
  parseOriginList,
  parsePort,
  readLimitedBody,
} from './policy.mjs';
import { bindClientDisconnect, createTargetGuard } from './session.mjs';
import { createDeadline, fetchTargets } from './transport.mjs';

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : (args[index + 1] ?? '');
}

let PORT;
let CDP_PORT;
let ALLOWED_ORIGINS;
try {
  PORT = parsePort(argValue('--port'), 8791, '--port');
  /** Chrome 的调试端口：`--remote-debugging-port` 那个数。 */
  CDP_PORT = parsePort(argValue('--cdp'), 9222, '--cdp');
  ALLOWED_ORIGINS = [
    ...DEFAULT_ALLOWED_ORIGINS,
    ...parseOriginList(process.env.DRAMATIS_BRIDGE_ORIGINS),
    ...parseOriginList(argValue('--allow-origin')),
  ];
} catch (error) {
  process.stderr.write(`[local-bridge] 启动参数错误：${error instanceof Error ? error.message : String(error)}
`);
  process.exit(1);
}
/** 可选配对令牌：设置后每个请求都要带 `Authorization: Bearer <token>`。 */
const TOKEN = argValue('--token') ?? process.env.DRAMATIS_BRIDGE_TOKEN ?? '';
const askQueue = createSerialQueue();

/**
 * 认哪个标签页是「模型网页」：地址里包含这段就算。
 *
 * 可以用 `--pattern` 换掉（换站点、或者拿一个本地假页面做验证时）。
 */
const patternIndex = args.indexOf('--pattern');
const TARGET_PATTERN = patternIndex === -1 ? 'chat.deepseek.com' : args[patternIndex + 1];

function cors(request, response) {
  // 只回显白名单里的来源（checkAccess 已经把关）；没有 Origin 时不发任何 CORS 头
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !ALLOWED_ORIGINS.includes(origin)) return;
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'Origin');
  response.setHeader('access-control-allow-headers', 'content-type, authorization');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  // Chrome 的 Private Network Access：公网页面访问 127.0.0.1 时预检要带这个
  response.setHeader('access-control-allow-private-network', 'true');
}

function send(request, response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  cors(request, response);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

/** 找到模型网页那个标签页。找不到时给的提示要具体到「该怎么办」。 */
async function findTarget(deadline) {
  let targets;
  try {
    targets = await fetchTargets(CDP_PORT, deadline);
  } catch (error) {
    if (deadline.signal.aborted) throw deadline.signal.reason;
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

const targetGuard = createTargetGuard();
const server = createServer((request, response) => {
  void (async () => {
    const url = request.url ?? '/';
    const access = checkAccess({
      method: request.method,
      headers: request.headers,
      port: PORT,
      allowedOrigins: ALLOWED_ORIGINS,
      token: TOKEN,
    });
    if (!access.ok) {
      process.stderr.write(
        `[local-bridge] 拒绝 ${String(access.status)}：Host=${String(request.headers.host)} Origin=${String(request.headers.origin)}
`,
      );
      // 被拒的来源不回 CORS 头，浏览器里的脚本连错误内容都读不到
      response.statusCode = access.status;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: access.error }));
      return;
    }
    if (request.method === 'OPTIONS') {
      cors(request, response);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === 'GET' && url.startsWith('/health')) {
      const deadline = createDeadline(5_000);
      const unbind = bindClientDisconnect(response, deadline);
      try {
        const target = await findTarget(deadline);
        send(request, response, 200, {
          ok: true,
          attached: true,
          page: target.url,
          cdpPort: CDP_PORT,
          hint: targetGuard.isUncertain(target.id)
            ? '上次发送未确认；关闭模型标签页并新开独立标签后再试。'
            : '自动发送会在发送前检查页面兼容契约。',
        });
      } catch (error) {
        send(request, response, 200, {
          ok: true,
          attached: false,
          cdpPort: CDP_PORT,
          hint: error instanceof Error ? error.message : String(error),
        });
      } finally {
        deadline.close();
        unbind();
      }
      return;
    }

    if (request.method === 'POST' && url.startsWith('/ask')) {
      let deadline;
      const onClose = () => {
        if (!response.writableEnded) deadline?.abort(new Error('客户端已断开。'));
      };
      response.on('close', onClose);
      try {
        let body;
        try {
          body = JSON.parse(await readLimitedBody(request));
        } catch (error) {
          if (error?.status === 413) throw error;
          send(request, response, 400, { error: '请求体不是合法 JSON。' });
          return;
        }
        if (body === null || typeof body !== 'object') {
          send(request, response, 400, { error: '请求体必须是 JSON 对象。' });
          return;
        }
        const prompt = typeof body.prompt === 'string' ? body.prompt : '';
        if (prompt.trim() === '') {
          send(request, response, 400, { error: 'prompt 不能是空的。' });
          return;
        }
        const timeoutMs = clampTimeout(body.timeoutMs);
        deadline = createDeadline(timeoutMs);

        // 串行：两个 /ask 同时往一个输入框里填字会互相覆盖
        const text = await askQueue.run(
          async () => {
            const target = await findTarget(deadline);
            targetGuard.check(target.id);
            return await runTargetAsk({ target, prompt, guard: targetGuard, deadline });
          },
          { signal: deadline.signal, deadline },
        );

        process.stdout.write(`[local-bridge] 发出 ${String(prompt.length)} 字，收回 ${String(text.length)} 字\n`);
        send(request, response, 200, { text });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[local-bridge] 失败：${message}\n`);
        const status = error?.status === 413 || error?.status === 429 ? error.status : 500;
        send(request, response, status, { error: message });
      } finally {
        deadline?.close();
        response.off('close', onClose);
      }
      return;
    }

    send(request, response, 404, { error: '没有这个接口（只有 /health 与 /ask）。' });
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(
    `本地助手：http://127.0.0.1:${String(PORT)}（要连的 Chrome 调试端口 ${String(CDP_PORT)}，目标 ${TARGET_PATTERN}）\n`,
  );
  process.stdout.write(`放行来源：${ALLOWED_ORIGINS.join(', ')}${TOKEN === '' ? '' : '；已启用配对令牌'}
`);
  process.stdout.write('提醒：它驱动的是网页本身，不是官方接口；请先确认你接受这件事再长期开着。\n');
});
