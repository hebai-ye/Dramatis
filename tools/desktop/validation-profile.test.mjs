import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Ledger, reservation } from './validation-common.mjs';
import { createValidationHost } from './validation-host.mjs';
import { removeFixtureDirectory, verifiedFixtureDirectory } from './validation-profile-test-helpers.mjs';

test('reservation uses the validated actual output ceiling and rejects arbitrary limits', () => {
  // These one-field JSON wires are 19 UTF-8 bytes, plus the approved output ceiling.
  for (const [max_tokens, expected] of [
    [1200, 0.009638],
    [4096, 0.032806],
  ]) {
    const wire = { max_tokens };
    assert.equal(reservation(wire), expected);
    const ledger = new Ledger();
    ledger.reserve(wire, 'quality');
    assert.equal(ledger.state.entries[0].maxOutputTokens, max_tokens);
  }
  for (const max_tokens of [undefined, null, 0, -1, 1201, 4097, 1e6, '4096', 4096.5])
    assert.throws(() => reservation({ max_tokens }), /output-token-limit/);
});

for (const maxOutputTokens of [1200, 4096]) {
  test(`host forwards ${maxOutputTokens}, records exact upstream bytes hash, and preserves model/Low`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'validation-profile-'));
    const ledgerPath = path.join(dir, 'ledger.json');
    let actualBody, flushBeforeDispatch;
    const host = await createValidationHost({
      port: 0,
      ledgerPath,
      initialize: true,
      maxOutputTokens,
      upstreamFetch: async (_url, init) => {
        actualBody = init.body;
        const persisted = JSON.parse((await readFile(ledgerPath, 'utf8')).trim().split('\n').at(-1));
        flushBeforeDispatch = persisted.state.entries.at(-1).status;
        return Response.json({
          choices: [{ message: { content: 'fixture' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 23 },
        });
      },
    });
    const base = `http://127.0.0.1:${host.address().port}`;
    const post = (route, body) =>
      fetch(`${base}/validation-api/${route}`, {
        method: 'POST',
        headers: {
          origin: base,
          'content-type': 'application/json',
          authorization: 'Bearer FIXTURE-SECRET',
          'x-validation-purpose': 'quality',
        },
        body: JSON.stringify(body),
      });
    try {
      await post('arm', { mode: 'real' });
      const response = await post('v1/chat/completions', {
        max_tokens: maxOutputTokens,
        messages: [{ role: 'user', content: 'fixture' }],
        stream: true,
        temperature: 1,
        top_p: 0.5,
      });
      await response.text();
      const wire = JSON.parse(actualBody);
      assert.equal(wire.max_tokens, maxOutputTokens);
      assert.equal(wire.model, 'deepseek-flash');
      assert.equal(wire.reasoning_effort, 'low');
      assert.deepEqual(wire.thinking, { type: 'enabled' });
      assert.deepEqual(wire.stream_options, { include_usage: true });
      assert.equal(wire.temperature, undefined);
      assert.equal(wire.top_p, undefined);
      const expectedHash = createHash('sha256').update(actualBody, 'utf8').digest('hex');
      assert.equal(response.headers.get('x-validation-upstream-wire-hash'), expectedHash);
      assert.equal(response.headers.get('x-validation-max-output-tokens'), String(maxOutputTokens));
      assert.equal(
        response.headers.get('x-validation-execution-profile'),
        `deepseek-flash-low-output-${maxOutputTokens}-v1`,
      );
      const status = await (await fetch(`${base}/validation-api/status`)).json();
      assert.equal(status.executionProfile.maxOutputTokens, maxOutputTokens);
      assert.equal(status.real.entries[0].upstreamWireHash, expectedHash);
      assert.deepEqual(status.real.entries[0].executionProfile, status.executionProfile);
      assert.equal(
        status.real.entries[0].reservationCny,
        (Buffer.byteLength(actualBody, 'utf8') * 2 + maxOutputTokens * 8) / 1_000_000,
      );
      assert.equal(status.real.spentCny, 0.000206);
      assert.equal(flushBeforeDispatch, 'pending');
      assert.equal((await readFile(ledgerPath, 'utf8')).includes('FIXTURE-SECRET'), false);
      assert.equal((await post('v1/chat/completions', { max_tokens: 4097, messages: [] })).status, 400);
      assert.equal((await (await fetch(`${base}/validation-api/status`)).json()).real.requests, 1);
    } finally {
      await new Promise((resolve) => host.close(resolve));
      await removeFixtureDirectory(dir, 'validation-profile-');
    }
  });
}

test('unsupported server profile is rejected before bind or journal creation', async () => {
  for (const maxOutputTokens of [0, 1201, 4097, '4096'])
    await assert.rejects(createValidationHost({ port: 0, maxOutputTokens }), /output-token-limit/);
});

test('fixture cleanup verifies the canonical direct temp child and refuses root, sibling or wrong prefix', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'validation-profile-'));
  try {
    assert.equal(await verifiedFixtureDirectory(dir, 'validation-profile-'), await realpath(dir));
    await assert.rejects(verifiedFixtureDirectory(tmpdir(), 'validation-profile-'), /unsafe-fixture-cleanup/);
    await assert.rejects(verifiedFixtureDirectory(dir, 'validation-recovery-'), /unsafe-fixture-cleanup/);
    await assert.rejects(
      verifiedFixtureDirectory(path.join(dir, 'child'), 'validation-profile-'),
      /unsafe-fixture-cleanup/,
    );
    await assert.rejects(
      verifiedFixtureDirectory(path.resolve(tmpdir(), '..', path.basename(dir)), 'validation-profile-'),
      /unsafe-fixture-cleanup/,
    );
  } finally {
    await removeFixtureDirectory(dir, 'validation-profile-');
  }
});

test('4096 reservation/hash includes the complete second-round private wire without saving its body', () => {
  const full = {
    model: 'deepseek-flash',
    max_tokens: 4096,
    reasoning_effort: 'low',
    messages: [
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'PRIVATE-CHAIN-中文',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'move', arguments: '{"x":1}' } }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
    ],
    tools: [
      {
        type: 'function',
        function: { name: 'move', parameters: { type: 'object', properties: { x: { type: 'number' } } } },
      },
    ],
    stream: true,
    stream_options: { include_usage: true },
  };
  const redacted = structuredClone(full);
  delete redacted.messages[0].reasoning_content;
  const ledger = new Ledger();
  ledger.reserve(full, 'quality');
  const entry = ledger.state.entries[0];
  assert.equal(entry.reservationCny, (Buffer.byteLength(JSON.stringify(full), 'utf8') * 2 + 32768) / 1_000_000);
  assert.ok(entry.reservationCny > reservation(redacted));
  assert.equal(entry.upstreamWireHash, createHash('sha256').update(JSON.stringify(full), 'utf8').digest('hex'));
  assert.notEqual(entry.upstreamWireHash, createHash('sha256').update(JSON.stringify(redacted), 'utf8').digest('hex'));
  assert.equal(JSON.stringify(ledger.state).includes('PRIVATE-CHAIN'), false);
  assert.equal(JSON.stringify(ledger.state).includes('reasoning_content'), false);
});
