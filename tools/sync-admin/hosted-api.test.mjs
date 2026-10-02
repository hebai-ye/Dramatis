import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const billing = await import('../sync-server/dist/tools/sync-server/src/deepseek-billing.js').catch(() => ({}));
const hosted = await import('../sync-server/dist/tools/sync-server/src/hosted-api.js').catch(() => ({}));
const gateway = await import('../sync-server/dist/tools/sync-server/src/gateway-main.js').catch(() => ({}));

async function fixture(options = {}) {
  const { SYNC_SCHEMA_SQL, hashCredential } = await import('../sync-server/dist/packages/core/src/index.js');
  const { createSpaceQuotaResolver } = await import('../sync-server/dist/tools/sync-server/src/storage-policy.js');
  const { initializeApiAccounting, recordPurchase, createApiLedger } = await import(
    '../sync-server/dist/tools/sync-admin/src/api-accounting.js'
  );
  const { getVipPlan } = await import('../sync-server/dist/tools/sync-admin/src/vip-plans.js');
  const db = new DatabaseSync(':memory:');
  db.exec(SYNC_SCHEMA_SQL);
  createSpaceQuotaResolver(db);
  initializeApiAccounting(db);
  const credential = 'fixture-sync-credential';
  const recovery = 'fixture-recovery-credential';
  db.prepare('INSERT INTO spaces VALUES (?,?,?,?,?,?)').run(
    'fixture-space',
    await hashCredential(credential),
    await hashCredential(recovery),
    'forbidden-wraps',
    '2026-01-01',
    'fixture-epoch',
  );
  db.prepare(`INSERT INTO space_memberships
    (space_handle,space_epoch,started_at,expires_at,revoked_at,max_bytes,revision)
    VALUES (?,?,?,?,?,?,?)`).run(
    'fixture-space',
    'fixture-epoch',
    '2026-10-01T00:00:00Z',
    '2026-11-01T00:00:00Z',
    null,
    268435456,
    1,
  );
  db.exec('BEGIN IMMEDIATE');
  recordPurchase(db, {
    operationId: randomUUID(),
    spaceHandle: 'fixture-space',
    spaceEpoch: 'fixture-epoch',
    plan: getVipPlan('vip-month-256'),
    eventAt: '2026-10-02T00:00:00.000Z',
  });
  db.exec('COMMIT');
  let clock = Date.parse('2026-10-02T00:00:00.000Z');
  let calls = 0;
  const requests = [];
  const fetch = async (url, init) => {
    calls += 1;
    requests.push({ url, body: JSON.parse(init.body), authorization: init.headers.authorization });
    return options.fetch ? options.fetch(url, init) : completion();
  };
  const handler = hosted.createHostedApiHandler({
    db,
    apiKey: 'fixture-provider-key',
    fetch,
    now: () => clock,
    ...options,
    ...(options.fetch ? { fetch } : {}),
  });
  const ledger = createApiLedger(db, () => clock);
  const request = (body = {}, id = randomUUID(), token = credential, path = 'chat/completions') =>
    new Request(`http://127.0.0.1:8789/v1/spaces/fixture-space/${path}`, {
      method: path === 'account' ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-request-id': id,
        'content-type': 'application/json',
      },
      ...(path === 'account'
        ? {}
        : {
            body: JSON.stringify({ messages: [{ role: 'user', content: 'private prompt' }], max_tokens: 16, ...body }),
          }),
    });
  return {
    db,
    ledger,
    handler,
    request,
    requests,
    get calls() {
      return calls;
    },
    setClock: (at) => {
      clock = Date.parse(at);
    },
    summary: () => ledger.summary('fixture-space', 'fixture-epoch'),
    async close() {
      await handler.idle();
      db.close();
    },
  };
}

const rawUsage = {
  prompt_tokens: 100,
  prompt_cache_hit_tokens: 40,
  prompt_cache_miss_tokens: 60,
  completion_tokens: 10,
  total_tokens: 110,
  completion_tokens_details: { reasoning_tokens: 5 },
};
function completion(usage = rawUsage) {
  return Response.json({
    id: 'fixture-upstream',
    object: 'chat.completion',
    model: 'deepseek-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: 'private reply' }, finish_reason: 'stop' }],
    usage,
  });
}
function sse(usage = rawUsage, separate = false, duplicate = false) {
  const data = {
    id: 'fixture-upstream',
    choices: [{ index: 0, delta: { content: 'private reply' }, finish_reason: 'stop' }],
    ...(separate ? {} : { usage }),
  };
  const chunks = [`data: ${JSON.stringify(data)}\n\n`];
  if (separate || duplicate) chunks.push(`data: ${JSON.stringify({ id: 'fixture-upstream', choices: [], usage })}\n\n`);
  chunks.push('data: [DONE]\n\n');
  return new Response(chunks.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

test('报价按缓存拆分整数计算，reasoning作为输出子项不重复收费', () => {
  assert.equal(typeof billing.validateDeepSeekUsage, 'function', '网关必须有严格usage校验');
  const usage = billing.validateDeepSeekUsage(
    {
      prompt_tokens: 100,
      prompt_cache_hit_tokens: 40,
      prompt_cache_miss_tokens: 60,
      completion_tokens: 10,
      total_tokens: 110,
      completion_tokens_details: { reasoning_tokens: 5 },
    },
    16384,
  );
  assert.equal(billing.quoteDeepSeekUsage(usage, 'offpeak'), 100800n);
  assert.equal(billing.quoteDeepSeekUsage(usage, 'peak'), 201600n);
  assert.equal(billing.requiredDeepSeekReserve(16384), 2228224000n);
});

test('缺失、负数、不安全整数及计数不一致均拒绝，而非补零', () => {
  assert.equal(typeof billing.validateDeepSeekUsage, 'function');
  const good = {
    prompt_tokens: 100,
    prompt_cache_hit_tokens: 40,
    prompt_cache_miss_tokens: 60,
    completion_tokens: 10,
    total_tokens: 110,
  };
  for (const patch of [
    { prompt_cache_hit_tokens: undefined },
    { prompt_tokens: -1 },
    { total_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { total_tokens: 111 },
    { prompt_cache_miss_tokens: 61 },
    { completion_tokens: 17, total_tokens: 117 },
    { completion_tokens_details: { reasoning_tokens: 11 } },
    { prompt_tokens: 1048577, prompt_cache_miss_tokens: 1048537, total_tokens: 1048587 },
  ]) {
    assert.throws(() => billing.validateDeepSeekUsage({ ...good, ...patch }, 16));
  }
});

test('北京时间节假日与完整请求区间定价，跨界即待核对', () => {
  assert.equal(typeof billing.deepSeekPriceAt, 'function');
  const config = { validFrom: '2026-01-01T00:00:00Z', validUntil: '2027-01-01T00:00:00Z' };
  assert.equal(billing.deepSeekPriceAt(Date.parse('2026-10-02T02:00Z'), config).period, 'offpeak');
  assert.equal(billing.deepSeekPriceAt(Date.parse('2026-09-28T02:00Z'), config).period, 'peak');
  assert.equal(billing.deepSeekPriceAt(Date.parse('2026-01-02T02:00Z'), config).period, 'offpeak');
  assert.equal(billing.deepSeekPriceAt(Date.parse('2026-02-20T02:00Z'), config).period, 'offpeak');
  assert.equal(billing.deepSeekPriceAt(Date.parse('2026-06-19T02:00Z'), config).period, 'offpeak');
  assert.throws(() => billing.deepSeekPriceAt(Date.parse('2027-01-04T02:00Z'), config));
  assert.throws(() => billing.deepSeekPriceAt(Date.parse('2026-10-04T00:00Z')));
  assert.throws(() =>
    billing.deepSeekPriceForInterval(Date.parse('2026-09-28T00:59Z'), Date.parse('2026-09-28T04:01Z'), config),
  );
  assert.equal(
    billing.deepSeekPriceForInterval(Date.parse('2026-09-28T02:00Z'), Date.parse('2026-09-28T02:01Z'), config).period,
    'peak',
  );
});

test('普通空间凭证鉴权，拒绝恢复凭证、admin token与账户ID', async () => {
  assert.equal(typeof hosted.createHostedApiHandler, 'function');
  const f = await fixture();
  try {
    for (const token of ['fixture-recovery-credential', 'fixture-admin-token', 'fixture-account-id'])
      assert.equal((await f.handler(f.request({}, randomUUID(), token))).status, 401);
    const account = await f.handler(f.request({}, randomUUID(), 'fixture-sync-credential', 'account'));
    assert.equal(account.status, 200);
    const text = await account.text();
    assert.match(text, /5000000000/);
    assert.doesNotMatch(text, /credential|provider-key|wraps|private prompt/);
    assert.equal(f.calls, 0);
  } finally {
    await f.close();
  }
});

test('鉴权等待期间凭证轮换与epoch变化后不能启动上游', async () => {
  assert.equal(typeof hosted.createHostedApiHandler, 'function');
  for (const sql of ["UPDATE spaces SET credential_hash='rotated'", "UPDATE spaces SET epoch='new-epoch'"]) {
    const f = await fixture();
    try {
      const pending = f.handler(f.request());
      f.db.exec(sql);
      assert.equal((await pending).status, 409);
      assert.equal(f.calls, 0);
      assert.equal(f.summary().reservedNanoyuan, '0');
    } finally {
      await f.close();
    }
  }
});

test('固定官方URL和模型，纳元结算后同UUID不能重发', async () => {
  assert.equal(typeof hosted.createHostedApiHandler, 'function');
  const f = await fixture();
  try {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const response = await f.handler(f.request({}, id));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, 'private reply');
    assert.equal(f.requests[0].url, 'https://api.deepseek.com/chat/completions');
    assert.equal(f.requests[0].body.model, 'deepseek-flash');
    assert.deepEqual(f.requests[0].body.thinking, { type: 'disabled' });
    assert.equal(f.requests[0].body.max_tokens, 16);
    assert.equal(f.requests[0].authorization, 'Bearer fixture-provider-key');
    assert.equal(f.summary().spentNanoyuan, '100800');
    assert.equal(f.summary().reservedNanoyuan, '0');
    assert.equal((await f.handler(f.request({}, id))).status, 409);
    assert.equal((await f.handler(f.request({}, id.toUpperCase()))).status, 409);
    assert.equal(f.calls, 1);
    const safe = JSON.stringify(f.summary());
    assert.doesNotMatch(safe, /private prompt|private reply|fixture-sync-credential|fixture-provider-key/);
  } finally {
    await f.close();
  }
});

test('未知字段、图片、thinking、超输出上限与非UUID在预留前拒绝', async () => {
  assert.equal(typeof hosted.createHostedApiHandler, 'function');
  const f = await fixture();
  try {
    for (const body of [
      { model: 'other-model' },
      { base_url: 'https://attacker.invalid' },
      { api_key: 'attacker' },
      { thinking: { type: 'enabled' } },
      { max_tokens: 16385 },
      { max_tokens: 0 },
      { stream_options: { include_usage: false } },
      { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'private' } }] }] },
    ])
      assert.equal((await f.handler(f.request(body))).status, 400);
    assert.equal((await f.handler(f.request({}, 'not-a-uuid'))).status, 400);
    assert.equal(f.calls, 0);
    assert.equal(f.summary().reservedNanoyuan, '0');
  } finally {
    await f.close();
  }
});

test('文本工具多轮载荷允许，stream_options强制usage并支持两种末块', async () => {
  assert.equal(typeof hosted.createHostedApiHandler, 'function');
  for (const separate of [false, true]) {
    const f = await fixture({ fetch: async () => sse(rawUsage, separate, true) });
    try {
      const response = await f.handler(
        f.request({
          stream: true,
          messages: [
            { role: 'user', content: 'private prompt' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
            },
            { role: 'tool', tool_call_id: 'call_1', content: 'private tool result' },
          ],
          tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
        }),
      );
      assert.equal(response.status, 200);
      assert.match(await response.text(), /private reply/);
      await f.handler.idle();
      assert.deepEqual(f.requests[0].body.stream_options, { include_usage: true });
      assert.equal(f.summary().spentNanoyuan, '100800');
      assert.equal(f.summary().reservedNanoyuan, '0');
    } finally {
      await f.close();
    }
  }
});

test('上游错误、缺usage与不一致usage保持预留且隐藏上游错误原文', async () => {
  assert.equal(typeof hosted.createHostedApiHandler, 'function');
  for (const response of [
    Response.json({ error: 'SECRET_PROVIDER_ERROR' }, { status: 429 }),
    Response.json({ choices: [] }),
    completion({ ...rawUsage, total_tokens: 999 }),
  ]) {
    const f = await fixture({ fetch: async () => response });
    try {
      const result = await f.handler(f.request());
      assert.equal(result.status, 502);
      assert.doesNotMatch(await result.text(), /SECRET_PROVIDER_ERROR/);
      assert.equal(f.summary().reservedNanoyuan, '2097280000');
      assert.equal(f.summary().spentNanoyuan, '0');
    } finally {
      await f.close();
    }
  }
});

test('客户端取消后继续取末块usage并结算', async () => {
  assert.equal(typeof hosted.createHostedApiHandler, 'function');
  let controller;
  const stream = new ReadableStream({
    start(value) {
      controller = value;
    },
  });
  const f = await fixture({
    fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
  });
  try {
    const response = await f.handler(f.request({ stream: true }));
    await response.body.cancel();
    controller.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{}], usage: rawUsage })}\n\ndata: [DONE]\n\n`),
    );
    controller.close();
    await f.handler.idle();
    assert.equal(f.summary().spentNanoyuan, '100800');
    assert.equal(f.summary().reservedNanoyuan, '0');
  } finally {
    await f.close();
  }
});

test('并发同空间仅一个未决，重复pending不重新请求', async () => {
  assert.equal(typeof hosted.createHostedApiHandler, 'function');
  let finish;
  const f = await fixture({
    fetch: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  try {
    const id = randomUUID();
    const first = f.handler(f.request({}, id));
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal((await f.handler(f.request())).status, 409);
    assert.equal((await f.handler(f.request({}, id))).status, 409);
    finish(Response.json({ error: 'hidden' }, { status: 500 }));
    assert.equal((await first).status, 502);
    assert.equal((await f.handler(f.request({}, id))).status, 409);
    assert.equal(f.calls, 1);
  } finally {
    await f.close();
  }
});

test('完整区间跨价边界与运营快照过期保留待核对', async () => {
  assert.equal(typeof hosted.createHostedApiHandler, 'function');
  let f;
  f = await fixture({
    priceConfig: { validFrom: '2026-09-28T00:00Z', validUntil: '2026-10-03T16:00Z' },
    fetch: async () => {
      f.setClock('2026-09-28T04:01Z');
      return completion();
    },
  });
  try {
    // Activate this isolated fixture's paid window before the boundary test.
    f.db.exec("UPDATE space_memberships SET started_at='2026-09-01T00:00Z'");
    f.setClock('2026-09-28T00:59Z');
    assert.equal((await f.handler(f.request())).status, 502);
    assert.equal(f.summary().spentNanoyuan, '0');
    assert.equal(f.summary().reservedNanoyuan, '2097280000');
  } finally {
    await f.close();
  }
});

test('运营入口默认关闭且只使用固定回环配置', () => {
  assert.equal(typeof gateway.readGatewayConfig, 'function');
  assert.equal(gateway.readGatewayConfig({}).enabled, false);
  assert.equal(gateway.readGatewayConfig({ DRAMATIS_API_ENABLED: '1' }).enabled, false);
  const config = gateway.readGatewayConfig({
    DRAMATIS_API_ENABLED: '1',
    DRAMATIS_API_KEY: 'private-key',
    DRAMATIS_API_DATA: './isolated.db',
    DRAMATIS_API_HOST: '0.0.0.0',
    DRAMATIS_API_PORT: '80',
  });
  assert.equal(config.enabled, true);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8789);
  assert.throws(() =>
    gateway.readGatewayConfig({
      DRAMATIS_API_ENABLED: '1',
      DRAMATIS_API_KEY: 'private-key',
      DRAMATIS_API_PRICE_VALID_UNTIL: '2099-01-01T00:00Z',
    }),
  );
});

test('SSE CRLF换行跨网络片段仍能核验usage', async () => {
  let controller;
  const stream = new ReadableStream({
    start(value) {
      controller = value;
    },
  });
  const f = await fixture({
    fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
  });
  try {
    const response = await f.handler(f.request({ stream: true }));
    const result = response.text();
    const raw = `data: ${JSON.stringify({ choices: [{}], usage: rawUsage })}\r\n\r\ndata: [DONE]\r\n\r\n`;
    for (const character of raw) controller.enqueue(new TextEncoder().encode(character));
    controller.close();
    await result;
    await f.handler.idle();
    assert.equal(f.summary().spentNanoyuan, '100800');
    assert.equal(f.summary().reservedNanoyuan, '0');
  } finally {
    await f.close();
  }
});

test('客户端停止读取时stop仍解除背压并保留待核对', async () => {
  const payload =
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(200000) } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [], usage: rawUsage })}\n\ndata: [DONE]\n\n`;
  const f = await fixture({
    fetch: async () => new Response(payload, { headers: { 'content-type': 'text/event-stream' } }),
  });
  let response;
  try {
    response = await f.handler(f.request({ stream: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    f.handler.stop();
    const idle = await Promise.race([
      f.handler.idle().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    assert.equal(idle, true, 'stop必须能退出被客户端背压阻塞的消费任务');
    assert.equal(f.summary().reservedNanoyuan, '2097280000');
    assert.equal(f.summary().spentNanoyuan, '0');
    assert.equal(f.summary().requests[0].state, 'pending');
  } finally {
    await response?.body.cancel().catch(() => {});
    await f.close();
  }
});

test('上游已给有效usage但没有DONE时保留计数及预留供核对', async () => {
  const f = await fixture({
    fetch: async () =>
      new Response(`data: ${JSON.stringify({ id: 'fixture-upstream', choices: [{}], usage: rawUsage })}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      }),
  });
  try {
    const response = await f.handler(f.request({ stream: true }));
    await response.text();
    await f.handler.idle();
    const request = f.summary().requests[0];
    assert.equal(request.state, 'pending');
    assert.equal(request.usage?.promptTokens, 100);
    assert.equal(request.upstreamId, 'fixture-upstream');
    assert.equal(f.summary().reservedNanoyuan, '2097280000');
  } finally {
    await f.close();
  }
});

test('上游超时与断流不能释放预留或自动重试', async () => {
  for (const mode of ['timeout', 'disconnect']) {
    let controller;
    const stream = new ReadableStream({
      start(value) {
        controller = value;
      },
    });
    const f = await fixture({
      upstreamTimeoutMs: 25,
      fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    });
    try {
      const response = await f.handler(f.request({ stream: true }));
      const text = response.text().catch(() => 'safe stream termination');
      if (mode === 'disconnect') controller.error(new Error('SECRET_PROVIDER_DISCONNECT'));
      assert.doesNotMatch(await text, /SECRET_PROVIDER_DISCONNECT/);
      await f.handler.idle();
      assert.equal(f.summary().requests[0].state, 'pending');
      assert.equal(f.summary().reservedNanoyuan, '2097280000');
      assert.equal(f.summary().spentNanoyuan, '0');
      assert.equal(f.calls, 1);
    } finally {
      await f.close();
    }
  }
});

test('已取消且确定未发送的请求释放预留并保持ID不可重放', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    controller.abort();
    const id = randomUUID();
    const request = new Request(f.request({}, id), { signal: controller.signal });
    assert.equal((await f.handler(request)).status, 499);
    assert.equal(f.summary().reservedNanoyuan, '0');
    assert.equal(f.summary().requests[0].state, 'released');
    assert.equal((await f.handler(f.request({}, id))).status, 409);
    assert.equal(f.calls, 0);
  } finally {
    await f.close();
  }
});

test('HTTP壳在usage到达前实际输出内容，客户端断开后仍结算', async () => {
  let controller;
  const stream = new ReadableStream({
    start(value) {
      controller = value;
    },
  });
  const f = await fixture({
    fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
  });
  const server = createServer((request, response) => {
    void gateway.serveHostedHttp(request, response, f.handler);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const original = f.request({ stream: true });
    const fetchResult = fetch(`http://127.0.0.1:${server.address().port}/v1/spaces/fixture-space/chat/completions`, {
      method: 'POST',
      headers: original.headers,
      body: await original.text(),
    });
    controller.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'first content' } }] })}\n\n`),
    );
    const response = await fetchResult;
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /first content/);
    assert.equal(f.summary().spentNanoyuan, '0');
    await reader.cancel();
    controller.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify({ choices: [], usage: rawUsage })}\n\ndata: [DONE]\n\n`),
    );
    controller.close();
    await f.handler.idle();
    assert.equal(f.summary().spentNanoyuan, '100800');
    assert.equal(f.summary().reservedNanoyuan, '0');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await f.close();
  }
});

test('HTTP壳超体积在鉴权与上游前拒绝', async () => {
  const f = await fixture();
  const server = createServer((request, response) => {
    void gateway.serveHostedHttp(request, response, f.handler);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/spaces/fixture-space/chat/completions`, {
      method: 'POST',
      body: 'x'.repeat(8 * 1024 * 1024 + 1),
    });
    assert.equal(response.status, 413);
    assert.equal(f.calls, 0);
    assert.equal(f.summary().reservedNanoyuan, '0');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await f.close();
  }
});

test('HTTP已输出内容后上游超时只结束流，不再重写已发送的header', async () => {
  let controller;
  const stream = new ReadableStream({
    start(value) {
      controller = value;
    },
  });
  const f = await fixture({
    upstreamTimeoutMs: 40,
    fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
  });
  const works = [];
  const server = createServer((request, response) => {
    const work = gateway.serveHostedHttp(request, response, f.handler);
    works.push(work);
    void work.catch(() => response.end());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const original = f.request({ stream: true });
    const result = fetch(`http://127.0.0.1:${server.address().port}/v1/spaces/fixture-space/chat/completions`, {
      method: 'POST',
      headers: original.headers,
      body: await original.text(),
    });
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
    const response = await result;
    await response.text();
    await f.handler.idle();
    assert.equal((await Promise.allSettled(works))[0].status, 'fulfilled');
    assert.equal(f.summary().requests[0].state, 'pending');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await f.close();
  }
});

test('真实socket暂停读取时上游超时也能唤醒HTTP背压等待', async () => {
  let emitted = 0;
  const block = new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(100000) } }] })}\n\n`,
  );
  const f = await fixture({
    upstreamTimeoutMs: 150,
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (++emitted <= 120) controller.enqueue(block);
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  let served = false;
  let responseRef;
  const server = createServer((request, response) => {
    responseRef = response;
    void gateway.serveHostedHttp(request, response, f.handler).then(() => {
      served = true;
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = connect(server.address().port, '127.0.0.1');
  socket.on('error', () => {});
  try {
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.pause();
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'private prompt' }],
      max_tokens: 16,
      stream: true,
    });
    socket.write(
      `POST /v1/spaces/fixture-space/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
        `Authorization: Bearer fixture-sync-credential\r\nX-Request-Id: ${randomUUID()}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    await f.handler.idle();
    assert.equal(f.summary().requests[0].state, 'pending');
    assert.equal(f.summary().requests[0].pendingReason, 'upstream-timeout');
    assert.equal(f.summary().reservedNanoyuan, '2097280000');
    assert.equal(f.summary().spentNanoyuan, '0');
    assert.equal(served, true, 'HTTP壳不能在上游已终止后仍卡在drain等待');
    assert.equal(responseRef.writableEnded || responseRef.destroyed, true);
  } finally {
    socket.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await f.close();
  }
});

test('真实socket短暂暂停保持预留，恢复读取后由最终usage结算', async () => {
  let emitted = 0;
  const block = new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(100000) } }] })}\n\n`,
  );
  const f = await fixture({
    upstreamTimeoutMs: 5000,
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            emitted += 1;
            if (emitted <= 120) controller.enqueue(block);
            else {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ choices: [], usage: rawUsage })}\n\ndata: [DONE]\n\n`,
                ),
              );
              controller.close();
            }
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  let serve;
  const server = createServer((request, response) => {
    serve = gateway.serveHostedHttp(request, response, f.handler);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = connect(server.address().port, '127.0.0.1');
  socket.on('error', () => {});
  socket.on('data', () => {});
  try {
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.pause();
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'private prompt' }],
      max_tokens: 16,
      stream: true,
    });
    socket.write(
      `POST /v1/spaces/fixture-space/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
        `Authorization: Bearer fixture-sync-credential\r\nX-Request-Id: ${randomUUID()}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.summary().requests[0].state, 'sent');
    assert.equal(f.summary().reservedNanoyuan, '2097280000');
    assert.equal(f.summary().spentNanoyuan, '0');
    socket.resume();
    await serve;
    await f.handler.idle();
    assert.equal(f.summary().requests[0].state, 'settled');
    assert.equal(f.summary().reservedNanoyuan, '0');
    assert.equal(f.summary().spentNanoyuan, '100800');
  } finally {
    socket.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await f.close();
  }
});
