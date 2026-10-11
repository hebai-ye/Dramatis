import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CANDIDATE_CSP, createValidationHost } from './validation-host.mjs';

test('enforced isolated host denies outbound until armed, runs fake stream/nonstream and persists no secrets', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quality-host-test-'));
  const host = await createValidationHost({ port: 0, ledgerPath: path.join(dir, 'ledger.json'), initialize: true });
  const base = `http://127.0.0.1:${host.address().port}`;
  const post = (route, body, headers = {}) =>
    fetch(base + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, ...headers },
      body: JSON.stringify(body),
    });
  try {
    const home = await fetch(`${base}/`);
    assert.equal(home.headers.get('content-security-policy'), CANDIDATE_CSP);
    assert.equal(home.headers.has('content-security-policy-report-only'), false);
    const wire = {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'test' }],
      stream: true,
      max_tokens: 1200,
      reasoning_effort: 'low',
      thinking: { type: 'enabled' },
    };
    assert.equal((await post('/validation-api/v1/chat/completions', wire)).status, 403);
    for (const upstream of [
      'https://third-party.example/v1/chat/completions',
      'https://api.deepseek.com/v1/chat/completions?key=x',
      'https://x@api.deepseek.com/v1/chat/completions',
      'https://api.deepseek.com/v1/chat/completions#x',
      'http://api.deepseek.com/v1/chat/completions',
    ]) {
      assert.equal((await post('/validation-api/arm', { mode: 'real', upstream })).status, 400);
    }
    assert.equal(
      (
        await fetch(`${base}/validation-api/arm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
          body: '{"mode":"fake"}',
        })
      ).status,
      403,
    );
    await post('/validation-api/arm', { mode: 'fake', fakeScenario: 'stream' });
    const stream = await post('/validation-api/v1/chat/completions', wire, { authorization: 'Bearer TEST-SECRET' });
    assert.match(await stream.text(), /\[DONE\]/);
    await post('/validation-api/arm', { mode: 'fake', fakeScenario: 'json' });
    const json = await post('/validation-api/v1/chat/completions', wire);
    assert.equal((await json.json()).choices[0].message.content, '隔离 fake 回复');
    const status = await (await fetch(`${base}/validation-api/status`)).json();
    assert.equal(status.real.requests, 0);
    assert.equal(status.fake.requests, 2);
    assert.equal((await readFile(path.join(dir, 'ledger.json'), 'utf8')).includes('TEST-SECRET'), false);
    for (const [scenario, outcome] of [
      ['missing', 'missing-usage'],
      ['error', 'failed'],
      ['length', 'budget-truncation'],
    ]) {
      await post('/validation-api/arm', { mode: 'fake', fakeScenario: scenario, resetFake: true });
      await (await post('/validation-api/v1/chat/completions', wire)).text();
      const stopped = await (await fetch(`${base}/validation-api/status`)).json();
      assert.equal(stopped.fake.requests, 1);
      assert.equal(stopped.fake.halted, true);
      assert.equal(stopped.fake.entries[0].status, outcome);
      assert.equal(stopped.fake.spentCny, stopped.fake.entries[0].reservationCny);
      assert.equal((await post('/validation-api/v1/chat/completions', wire)).status, 409);
    }
  } finally {
    await new Promise((resolve) => host.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('shared real ledger survives restart; fake upstream validates low wire without a network model request', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quality-durable-test-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  let calls = 0;
  const upstreamFetch = async (_url, init) => {
    calls++;
    const wire = JSON.parse(init.body);
    assert.equal(wire.reasoning_effort, 'low');
    assert.equal(wire.max_tokens, 1200);
    assert.equal(wire.model, 'deepseek-flash');
    assert.equal(wire.temperature, undefined);
    return Response.json({
      choices: [{ message: { content: 'fake transport' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
  };
  let host = await createValidationHost({ port: 0, ledgerPath, initialize: true, upstreamFetch });
  let base = `http://127.0.0.1:${host.address().port}`;
  const post = (route, body, headers = {}) =>
    fetch(base + route, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  try {
    await post('/validation-api/arm', { mode: 'real' });
    for (const purpose of ['quality', 'csp']) {
      const response = await post(
        '/validation-api/v1/chat/completions',
        { messages: [{ role: 'user', content: 'test' }], temperature: 0.9 },
        { 'x-validation-purpose': purpose, authorization: 'Bearer TEST-SECRET' },
      );
      await response.text();
    }
    assert.equal(calls, 2);
    await new Promise((resolve) => host.close(resolve));
    host = await createValidationHost({ port: 0, ledgerPath, upstreamFetch });
    base = `http://127.0.0.1:${host.address().port}`;
    const status = await (await fetch(`${base}/validation-api/status`)).json();
    assert.equal(status.mode, 'locked');
    assert.equal(status.real.requests, 2);
    assert.equal(status.real.qualityRequests, 1);
    assert.equal(status.real.spentCny, 0.00036);
    assert.equal((await readFile(ledgerPath, 'utf8')).includes('TEST-SECRET'), false);
  } finally {
    await new Promise((resolve) => host.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
