import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { applySqlitePragmas } from '../../../packages/core/src/index.js';
import { apiAccountingAvailable, createApiLedger } from '../../sync-admin/src/api-accounting.js';
import {
  DEEPSEEK_PRICE_CONFIRMED_AT,
  DEFAULT_DEEPSEEK_PRICE_UNTIL,
  type DeepSeekPriceConfig,
} from './deepseek-billing.js';
import { createHostedApiHandler, HOSTED_MAX_BODY_BYTES } from './hosted-api.js';

interface GatewayConfig {
  enabled: boolean;
  host: '127.0.0.1';
  port: 8789;
  dataPath: string;
  apiKey: string;
  priceConfig: DeepSeekPriceConfig;
}
type HostedHandler = ReturnType<typeof createHostedApiHandler>;

export function readGatewayConfig(env: Record<string, string | undefined>): GatewayConfig {
  const apiKey = env.DRAMATIS_API_KEY?.trim() ?? '';
  if (apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new Error('invalid-api-configuration');
  const validUntil = env.DRAMATIS_API_PRICE_VALID_UNTIL ?? DEFAULT_DEEPSEEK_PRICE_UNTIL;
  const cutoff = Date.parse(validUntil);
  const confirmed = Date.parse(DEEPSEEK_PRICE_CONFIRMED_AT);
  // Operators must recheck the official price; this release cannot promise a permanent rate.
  if (!Number.isSafeInteger(cutoff) || cutoff <= confirmed || cutoff > confirmed + 7 * 86_400_000)
    throw new Error('invalid-price-confirmation-cutoff');
  return {
    enabled: env.DRAMATIS_API_ENABLED === '1' && apiKey !== '',
    host: '127.0.0.1',
    port: 8789,
    dataPath: resolve(env.DRAMATIS_API_DATA ?? './data/sync.db'),
    apiKey,
    priceConfig: { validFrom: DEEPSEEK_PRICE_CONFIRMED_AT, validUntil: new Date(cutoff).toISOString() },
  };
}

function safeFailure(response: ServerResponse, status: number, code: string) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.end();
    return;
  }
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify({ error: { code } }));
}
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}
async function waitDrain(response: ServerResponse, terminated: AbortSignal): Promise<void> {
  if (response.destroyed || response.writableEnded || terminated.aborted) return;
  await new Promise<void>((done) => {
    const finish = () => {
      response.off('drain', finish);
      response.off('close', finish);
      response.off('error', finish);
      terminated.removeEventListener('abort', finish);
      done();
    };
    response.once('drain', finish);
    response.once('close', finish);
    response.once('error', finish);
    terminated.addEventListener('abort', finish, { once: true });
  });
}

/** Actual HTTP streaming with bounded input, output backpressure and cancellation of only the relay. */
export async function serveHostedHttp(request: IncomingMessage, response: ServerResponse, handler: HostedHandler) {
  const client = new AbortController();
  request.once('aborted', () => client.abort());
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const disconnect = () => {
    client.abort();
    void reader?.cancel().catch(() => {});
  };
  response.once('close', disconnect);
  try {
    const declaredLength = header(request, 'content-length');
    if (
      declaredLength !== undefined &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > HOSTED_MAX_BODY_BYTES)
    ) {
      request.resume();
      safeFailure(response, 413, 'payload-too-large');
      return;
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      bytes += chunk.byteLength;
      if (bytes > HOSTED_MAX_BODY_BYTES) {
        request.resume();
        safeFailure(response, 413, 'payload-too-large');
        return;
      }
      chunks.push(chunk);
    }
    if (client.signal.aborted) return;
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const headers = new Headers();
    for (const name of ['authorization', 'x-request-id', 'content-type']) {
      const value = header(request, name);
      if (value !== undefined) headers.set(name, value);
    }
    const method = request.method ?? 'GET';
    const input = new Request(`http://127.0.0.1:8789${request.url ?? '/'}`, {
      method,
      headers,
      signal: client.signal,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
    });
    const output = await handler(input);
    if (response.destroyed || client.signal.aborted) {
      await output.body?.cancel().catch(() => {});
      return;
    }
    response.statusCode = output.status;
    output.headers.forEach((value, name) => {
      response.setHeader(name, value);
    });
    if (!output.body) {
      response.end();
      return;
    }
    reader = output.body.getReader();
    const relayEnded = new AbortController();
    // reader.closed rejects immediately when the upstream deadline errors the relay,
    // even while the HTTP socket has not emitted drain/close/error.
    void reader.closed.then(
      () => relayEnded.abort(),
      () => relayEnded.abort(),
    );
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done || response.destroyed) break;
      if (!response.write(chunk.value)) await waitDrain(response, relayEnded.signal);
      if (response.destroyed || relayEnded.signal.aborted) break;
    }
    if (!response.destroyed) response.end();
  } catch {
    safeFailure(response, 500, 'gateway-unavailable');
  } finally {
    response.off('close', disconnect);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

export async function startGateway(config: GatewayConfig) {
  if (!config.enabled) return null;
  if (config.host !== '127.0.0.1' || config.port !== 8789 || config.apiKey === '')
    throw new Error('invalid-api-configuration');
  if (!existsSync(config.dataPath)) throw new Error('api-database-unavailable');
  const db = new DatabaseSync(config.dataPath);
  try {
    applySqlitePragmas(db);
    if (!apiAccountingAvailable(db)) throw new Error('api-schema-unavailable');
  } catch (error) {
    db.close();
    throw error;
  }
  const handler = createHostedApiHandler({ db, apiKey: config.apiKey, priceConfig: config.priceConfig });
  let ready = false;
  let closing = false;
  const server = createServer((request, response) => {
    if (!ready || closing) {
      request.resume();
      safeFailure(response, 503, 'gateway-unavailable');
      return;
    }
    void serveHostedHttp(request, response, handler);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5000;
  try {
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        accept();
      });
    });
    // Bind before recovering: a second process failing EADDRINUSE must not touch the active ledger.
    createApiLedger(db).recover();
    ready = true;
  } catch (error) {
    server.close();
    db.close();
    throw error;
  }
  const bounded = async (work: Promise<unknown>, milliseconds: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      work.then(() => true),
      new Promise<false>((done) => {
        timer = setTimeout(() => done(false), milliseconds);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return completed;
  };
  return {
    server,
    handler,
    async close(): Promise<boolean> {
      closing = true;
      const serverClosed = new Promise<void>((done) => server.close(done));
      let drained = await bounded(Promise.all([serverClosed, handler.idle()]), 10_000);
      if (!drained) {
        handler.stop();
        server.closeAllConnections();
        drained = await bounded(Promise.all([serverClosed, handler.idle()]), 2000);
      }
      // An uncooperative network implementation requires process exit; don't close its live DB.
      if (drained) db.close();
      return drained;
    },
  };
}

export async function runGateway() {
  try {
    const config = readGatewayConfig(process.env);
    if (!config.enabled) {
      process.stdout.write('Hosted API disabled.\n');
      return;
    }
    const gateway = await startGateway(config);
    if (!gateway) return;
    process.stdout.write('Hosted API listening on 127.0.0.1:8789 (public price snapshot).\n');
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void gateway.close().then((drained) => process.exit(drained ? 0 : 1));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch {
    process.stderr.write('Hosted API startup failed; check protected configuration and schema.\n');
    process.exit(1);
  }
}
