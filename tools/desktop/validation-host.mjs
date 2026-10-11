import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, Ledger } from './validation-common.mjs';
import { openBudgetJournal } from './validation-journal.mjs';
import { executionProfile, upstreamWireHash } from './validation-profile.mjs';
import { recoverApprovedTruncation } from './validation-recovery.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const OFFICIAL_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
export const CANDIDATE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
function fakeResponse(kind) {
  if (kind === 'error')
    return new Response('{"error":{"message":"fake error"}}', {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  const usage = kind === 'missing' ? undefined : { prompt_tokens: 32, completion_tokens: 16 };
  const finish = kind === 'length' ? 'length' : 'stop';
  if (kind === 'json')
    return Response.json({ choices: [{ message: { content: '隔离 fake 回复' }, finish_reason: finish }], usage });
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: '隔离 fake 回复' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const part of chunks) {
          controller.enqueue(new TextEncoder().encode(part));
          await new Promise((r) => setTimeout(r, kind === 'slow' ? 1500 : 5));
        }
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

export async function createValidationHost({
  port = 6285,
  ledgerPath = path.join(root, 'apps/web/tests/quality/.local/ledger.json'),
  initialize = false,
  upstreamFetch = fetch,
  journalIo = {},
  maxOutputTokens = 1200,
  recovery,
} = {}) {
  const profile = executionProfile(maxOutputTokens);
  let real, journal;
  let fake = new Ledger();
  let mode = 'locked',
    upstream = OFFICIAL_ENDPOINT,
    fakeScenario = 'stream',
    busy = false,
    shuttingDown = false;
  const activeControllers = new Set();
  const violations = [];
  const send = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    res.once('finish', () => {
      // close() reaps connections idle at that moment. An active SSE response can
      // finish later and become keep-alive idle; reap it only after response finish.
      if (shuttingDown) server.closeIdleConnections();
    });
    if (!real) return send(res, 503, { error: 'initializing' });
    res.setHeader('Content-Security-Policy', CANDIDATE_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('x-validation-execution-profile', profile.profileId);
    res.setHeader('x-validation-max-output-tokens', String(profile.maxOutputTokens));
    if (shuttingDown || !server.address()) return send(res, 503, { error: 'host-shutting-down' });
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== `127.0.0.1:${server.address().port}`)
      return send(res, 403, { error: 'loopback-host-required' });
    const route = new URL(req.url, origin).pathname;
    try {
      if (req.method === 'POST') {
        if (req.headers.origin !== origin || !String(req.headers['content-type']).startsWith('application/json'))
          return send(res, 403, { error: 'same-origin-json-required' });
        let source = '';
        for await (const chunk of req) {
          source += chunk.toString();
          if (source.length > 2_000_000) return send(res, 413, { error: 'request-too-large' });
        }
        const body = JSON.parse(source || '{}');
        if (route === '/validation-api/arm') {
          if (busy) return send(res, 409, { error: 'request-in-progress' });
          if (!['fake', 'real', 'locked'].includes(body.mode)) return send(res, 400, { error: 'invalid-mode' });
          if (body.mode === 'real') {
            if (real.state.halted) return send(res, 409, { error: 'ledger-halted' });
            if ((body.upstream ?? OFFICIAL_ENDPOINT) !== OFFICIAL_ENDPOINT)
              return send(res, 400, { error: 'official-deepseek-endpoint-only' });
            upstream = OFFICIAL_ENDPOINT;
          }
          if (body.mode === 'fake' && body.resetFake === true) fake = new Ledger();
          mode = body.mode;
          fakeScenario = ['stream', 'json', 'missing', 'error', 'slow', 'length'].includes(body.fakeScenario)
            ? body.fakeScenario
            : 'stream';
          return send(res, 200, { mode });
        }
        if (route === '/validation-api/violation') {
          // Exclude URLs, sourceFile, samples and originalPolicy: they can contain secrets.
          violations.push({
            directive: String(body.directive ?? '')
              .replace(/[^a-z-]/g, '')
              .slice(0, 80),
            disposition: body.disposition === 'enforce' ? 'enforce' : 'report',
          });
          return send(res, 200, { ok: true });
        }
        if (route === '/validation-api/v1/chat/completions') {
          if (mode === 'locked') return send(res, 403, { error: 'explicit-start-required' });
          if (busy) return send(res, 409, { error: 'one-request-at-a-time' });
          if (body.max_tokens !== undefined && body.max_tokens !== profile.maxOutputTokens)
            return send(res, 400, { error: 'execution-profile-output-token-mismatch' });
          const wire = {
            ...body,
            model: 'deepseek-flash',
            max_tokens: profile.maxOutputTokens,
            reasoning_effort: 'low',
            thinking: { type: 'enabled' },
          };
          delete wire.temperature;
          delete wire.top_p;
          delete wire.presence_penalty;
          delete wire.frequency_penalty;
          if (!Array.isArray(wire.messages)) return send(res, 400, { error: 'messages-required' });
          if (wire.stream !== false) {
            wire.stream = true;
            wire.stream_options = { include_usage: true };
          } else delete wire.stream_options;
          const upstreamBody = JSON.stringify(wire);
          res.setHeader('x-validation-upstream-wire-hash', upstreamWireHash(upstreamBody));
          const ledger = mode === 'real' ? real : fake,
            isReal = mode === 'real';
          const purpose = req.headers['x-validation-purpose'] === 'quality' ? 'quality' : 'csp';
          let id;
          try {
            id = ledger.reserve(wire, purpose);
          } catch {
            return send(res, 409, { error: 'budget-blocked', ledger: ledger.state });
          }
          busy = true;
          if (isReal) {
            try {
              journal.commit(real.state);
            } catch {
              real.state.halted = true;
              mode = 'locked';
              busy = false;
              return send(res, 503, { error: 'ledger-durability-unavailable' });
            }
          }
          const controller = new AbortController();
          activeControllers.add(controller);
          let usage = null,
            finishReason = null,
            outcome = 'complete';
          const timer = setTimeout(() => controller.abort(), 120_000);
          res.on('close', () => {
            if (!res.writableEnded) controller.abort();
          });
          const inspect = (raw) => {
            try {
              const obj = JSON.parse(raw);
              if (obj.usage) usage = obj.usage;
              if (obj.choices?.[0]?.finish_reason) finishReason = obj.choices[0].finish_reason;
            } catch {
              /* Provider owns syntax parsing. Missing usage fails closed. */
            }
          };
          try {
            if (res.destroyed) {
              controller.abort();
              throw Error('aborted');
            }
            const response = isReal
              ? await upstreamFetch(upstream, {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    authorization: String(req.headers.authorization ?? ''),
                  },
                  body: upstreamBody,
                  signal: controller.signal,
                  redirect: 'error',
                })
              : fakeResponse(fakeScenario);
            if (!response.ok) {
              outcome = 'failed';
              await response.body?.cancel();
              send(res, response.status, { error: 'upstream-http-error' });
            } else {
              const type = response.headers.get('content-type') ?? 'application/json';
              res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
              if (type.includes('text/event-stream')) {
                let buffer = '';
                const decoder = new TextDecoder();
                for await (const chunk of response.body) {
                  if (controller.signal.aborted) throw Error('aborted');
                  buffer += decoder.decode(chunk, { stream: true });
                  let newline = buffer.indexOf('\n');
                  while (newline >= 0) {
                    const line = buffer.slice(0, newline).trim();
                    buffer = buffer.slice(newline + 1);
                    if (line.startsWith('data:')) inspect(line.slice(5).trim());
                    newline = buffer.indexOf('\n');
                  }
                  if (buffer.length > 2_000_000) throw Error('oversized-event');
                  res.write(chunk);
                }
                if (buffer.startsWith('data:')) inspect(buffer.slice(5).trim());
              } else {
                const text = await response.text();
                inspect(text);
                res.write(text);
              }
              if (['length', 'max_tokens'].includes(finishReason)) outcome = 'budget-truncation';
              else if (!['stop', 'tool_calls'].includes(finishReason)) outcome = 'incomplete-or-unknown-finish';
            }
          } catch {
            outcome = controller.signal.aborted ? 'aborted' : 'failed';
            if (!res.headersSent) send(res, 502, { error: outcome });
          } finally {
            clearTimeout(timer);
            activeControllers.delete(controller);
            const pending = structuredClone(ledger.state);
            ledger.settle(id, usage, outcome);
            if (isReal) {
              try {
                journal.commit(real.state);
              } catch {
                real.state = pending;
                real.state.halted = true;
                mode = 'locked';
              }
            }
            busy = false;
            if (!res.writableEnded) res.end();
          }
          return;
        }
        return send(res, 404, { error: 'unknown-endpoint' });
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'method-not-allowed' });
      if (route === '/validation-api/status')
        return send(res, 200, {
          mode,
          busy,
          real: real.state,
          fake: fake.state,
          violations,
          executionProfile: profile,
          executionProfileHash: hash(profile),
          checkpointHash: journal.checkpointHash,
        });
      if (route === '/validation-api/manifest') {
        res.setHeader('content-type', 'application/json');
        return res.end(await readFile(path.join(root, 'docs/quality-fixtures/manifest.json')));
      }
      let folder, relative;
      if (route === '/validation-bootstrap.js') {
        folder = path.join(root, 'tools/desktop');
        relative = 'validation-bootstrap.js';
      } else if (route.startsWith('/validation/')) {
        folder = path.join(root, 'apps/web/tests/quality/build');
        relative = route.slice('/validation/'.length) || 'index.html';
      } else {
        folder = path.join(root, 'apps/web/dist');
        relative = route === '/' ? 'index.html' : decodeURIComponent(route.slice(1));
      }
      const file = path.resolve(folder, relative);
      if (!file.startsWith(path.resolve(folder) + path.sep)) return send(res, 403, { error: 'invalid-path' });
      let content;
      try {
        content = await readFile(file);
      } catch {
        return send(res, 404, { error: 'build-required-or-not-found' });
      }
      if (file.endsWith('index.html') && !route.startsWith('/validation/'))
        content = Buffer.from(
          content.toString().replace('<head>', '<head><script src="/validation-bootstrap.js"></script>'),
        );
      res.setHeader('content-type', mime[path.extname(file)] ?? 'application/octet-stream');
      res.end(content);
    } catch {
      if (!res.headersSent) send(res, 500, { error: 'validation-host-error' });
      else res.end();
    }
  });
  // Bind first: a failed startup must not touch or overwrite any budget.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    journal = openBudgetJournal(ledgerPath, { initialize, ...journalIo });
    real = new Ledger(journal.state);
    if (recovery !== undefined) recoverApprovedTruncation(real, journal, recovery, profile.maxOutputTokens);
    if (real.state.recoveryAudit !== undefined && real.state.executionProfile?.profileId !== profile.profileId)
      throw Error('execution-profile-ledger-mismatch: recovered journal requires its approved execution profile');
    server.once('close', () => journal.close());
  } catch (error) {
    journal?.close();
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  // CLI uses this bounded, self-owned lifecycle. Old running processes do not gain it.
  server.shutdown = async ({ timeoutMs = 5000 } = {}) => {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw Error('invalid-shutdown-timeout');
    shuttingDown = true;
    mode = 'locked';
    for (const controller of activeControllers) controller.abort();
    let timer;
    const closed = new Promise((resolve) => server.close(() => resolve(true)));
    const bounded = new Promise((resolve) => {
      timer = setTimeout(() => {
        server.closeAllConnections();
        resolve(false);
      }, timeoutMs);
    });
    const connectionsClosed = await Promise.race([closed, bounded]);
    clearTimeout(timer);
    // A disconnected client can let server.close finish while an abort-ignoring
    // upstream is still running. Connection closure alone is not a clean exit.
    const clean = connectionsClosed && busy === false && activeControllers.size === 0;
    // If a transport ignores abort, retain its already durable pending reservation.
    journal.close();
    return { clean, busy };
  };
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = validationCliOptions(process.argv.slice(2));
  const server = await createValidationHost(options);
  let exiting = false;
  const exit = async () => {
    if (exiting) return;
    exiting = true;
    const { clean } = await server.shutdown();
    process.exitCode = clean ? 0 : 1;
    process.exit(process.exitCode);
  };
  process.once('SIGINT', exit);
  process.once('SIGTERM', exit);
  console.log(
    `Validation ready (locked, ${options.maxOutputTokens} output tokens): http://127.0.0.1:${server.address().port}/validation/ ; production dist: / ; real requests require explicit UI start`,
  );
}

export function validationCliOptions(args) {
  const allowed =
    /^(--initialize-ledger|--output-tokens=(1200|4096)|--resume-truncation=1|--resume-checkpoint=[a-f0-9]{64})$/;
  if (args.some((arg) => !allowed.test(arg))) throw Error('invalid-validation-cli-option');
  const values = (prefix) => args.filter((arg) => arg.startsWith(prefix));
  if (
    ['--initialize-ledger', '--output-tokens=', '--resume-truncation=', '--resume-checkpoint='].some(
      (prefix) => values(prefix).length > 1,
    )
  )
    throw Error('duplicate-validation-cli-option');
  const maxOutputTokens = Number(values('--output-tokens=')[0]?.split('=')[1] ?? 1200);
  const resume = values('--resume-truncation=')[0];
  const checkpoint = values('--resume-checkpoint=')[0]?.split('=')[1];
  if (
    Boolean(resume) !== Boolean(checkpoint) ||
    (resume && (maxOutputTokens !== 4096 || args.includes('--initialize-ledger')))
  )
    throw Error('recovery-refused: explicit 4096 profile, entry 1 and checkpoint are required');
  return {
    initialize: args.includes('--initialize-ledger'),
    maxOutputTokens,
    ...(resume
      ? { recovery: { lastEntryId: 1, checkpointHash: checkpoint, approvedChoice: '4096-preserve-ledger' } }
      : {}),
  };
}
