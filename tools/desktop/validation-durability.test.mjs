import assert from 'node:assert/strict';
import { fsyncSync, writeSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Ledger } from './validation-common.mjs';
import { createValidationHost } from './validation-host.mjs';
import { removeFixtureDirectory } from './validation-profile-test-helpers.mjs';

const wire = { messages: [{ role: 'user', content: 'fake-only' }], stream: true, max_tokens: 1200 };
const baseOf = (host) => `http://127.0.0.1:${host.address().port}`;
const post = (host, route, body) =>
  fetch(`${baseOf(host)}/validation-api/${route}`, {
    method: 'POST',
    headers: { origin: baseOf(host), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const status = async (host) => (await fetch(`${baseOf(host)}/validation-api/status`)).json();
const close = (host) => new Promise((resolve) => host.close(resolve));
const fakeCompletion = () =>
  Response.json({
    choices: [{ message: { content: 'fake' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  });

test('unsupported flush capability prevents startup and cannot dispatch real traffic', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quality-no-flush-'));
  let calls = 0;
  try {
    await assert.rejects(
      createValidationHost({
        port: 0,
        ledgerPath: path.join(dir, 'ledger.json'),
        initialize: true,
        journalIo: {
          sync() {
            throw Error('unsupported');
          },
        },
        upstreamFetch: async () => {
          calls++;
          return fakeCompletion();
        },
      }),
      /durability-unavailable/,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('journal write failure retains an in-memory pending reservation and a restart-blocking lock', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quality-write-failure-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  let fail = false,
    calls = 0;
  const host = await createValidationHost({
    port: 0,
    ledgerPath,
    initialize: true,
    journalIo: {
      write(...args) {
        if (fail) throw Error('injected-write-failure');
        return writeSync(...args);
      },
    },
    upstreamFetch: async () => {
      calls++;
      return fakeCompletion();
    },
  });
  try {
    await post(host, 'arm', { mode: 'real' });
    fail = true;
    assert.equal((await post(host, 'v1/chat/completions', wire)).status, 503);
    const stopped = await status(host);
    assert.equal(calls, 0);
    assert.equal(stopped.real.requests, 1);
    assert.equal(stopped.real.entries[0].status, 'pending');
    assert.equal(stopped.real.halted, true);
  } finally {
    await close(host);
  }
  try {
    await assert.rejects(createValidationHost({ port: 0, ledgerPath }), /ledger.*locked/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real dispatch follows a synchronous flush and flush failure preserves pending without dispatch', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quality-flush-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  let fail = false,
    syncs = 0,
    calls = 0;
  const host = await createValidationHost({
    port: 0,
    ledgerPath,
    initialize: true,
    journalIo: {
      sync(fd) {
        if (fail) throw Error('injected-sync-failure');
        fsyncSync(fd);
        syncs++;
      },
    },
    upstreamFetch: async () => {
      calls++;
      assert.ok(syncs >= 2);
      return fakeCompletion();
    },
  });
  try {
    await post(host, 'arm', { mode: 'real' });
    await (await post(host, 'v1/chat/completions', wire)).text();
    assert.equal(calls, 1);
    fail = true;
    assert.equal((await post(host, 'v1/chat/completions', wire)).status, 503);
    assert.equal(calls, 1);
    const stopped = await status(host);
    assert.equal(stopped.busy, false);
    assert.equal(stopped.real.requests, 2);
    assert.equal(stopped.real.entries.at(-1).status, 'pending');
    assert.equal(stopped.real.halted, true);
    assert.match(await readFile(ledgerPath, 'utf8'), /pending/);
  } finally {
    await close(host);
  }
  try {
    await assert.rejects(createValidationHost({ port: 0, ledgerPath }), /ledger.*locked/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('same-ledger concurrent host and occupied-port startup cannot rewrite the active journal', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quality-exclusive-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  const host = await createValidationHost({ port: 0, ledgerPath, initialize: true });
  let accidental;
  try {
    const before = await readFile(ledgerPath, 'utf8');
    try {
      accidental = await createValidationHost({ port: 0, ledgerPath });
    } catch (error) {
      assert.match(error.message, /ledger.*locked/i);
    }
    assert.equal(accidental, undefined, 'concurrent host must reject the same ledger');
    assert.equal(await readFile(ledgerPath, 'utf8'), before);
    const other = path.join(dir, 'other.json');
    const untouched = JSON.stringify(new Ledger().state);
    await writeFile(other, untouched);
    await assert.rejects(createValidationHost({ port: host.address().port, ledgerPath: other }), /EADDRINUSE/);
    assert.equal(await readFile(other, 'utf8'), untouched);
  } finally {
    if (accidental) await close(accidental);
    await close(host);
    await rm(dir, { recursive: true, force: true });
  }
});

test('host restart sees persisted pending reservation and refuses real arming', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quality-pending-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  const ledger = new Ledger();
  ledger.reserve(wire, 'quality');
  await writeFile(ledgerPath, JSON.stringify(ledger.state));
  const host = await createValidationHost({ port: 0, ledgerPath });
  try {
    assert.equal((await status(host)).real.requests, 1);
    assert.equal((await post(host, 'arm', { mode: 'real' })).status, 409);
  } finally {
    await close(host);
    await rm(dir, { recursive: true, force: true });
  }
});

test('real-mode client abort cancels fake upstream, keeps reservation and survives restart halted', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quality-abort-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  let upstreamAborted = false;
  let host = await createValidationHost({
    port: 0,
    ledgerPath,
    initialize: true,
    upstreamFetch: async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
            init.signal.addEventListener(
              'abort',
              () => {
                upstreamAborted = true;
                controller.error(Error('aborted'));
              },
              { once: true },
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  try {
    await post(host, 'arm', { mode: 'real' });
    const controller = new AbortController();
    const response = await fetch(`${baseOf(host)}/validation-api/v1/chat/completions`, {
      method: 'POST',
      headers: { origin: baseOf(host), 'content-type': 'application/json' },
      body: JSON.stringify(wire),
      signal: controller.signal,
    });
    await response.body.getReader().read();
    controller.abort();
    for (let attempt = 0; attempt < 50 && (await status(host)).busy; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const stopped = await status(host);
    assert.equal(upstreamAborted, true);
    assert.equal(stopped.busy, false);
    assert.equal(stopped.real.requests, 1);
    assert.equal(stopped.real.halted, true);
    assert.equal(stopped.real.entries[0].status, 'aborted');
    assert.equal(stopped.real.spentCny, stopped.real.entries[0].reservationCny);
    await close(host);
    host = await createValidationHost({ port: 0, ledgerPath });
    assert.equal((await status(host)).real.halted, true);
  } finally {
    await close(host);
    await rm(dir, { recursive: true, force: true });
  }
});

test('settlement flush failure does not replace the durable pending reservation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'quality-settle-flush-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  let fail = false;
  const host = await createValidationHost({
    port: 0,
    ledgerPath,
    initialize: true,
    journalIo: {
      sync(fd) {
        if (fail) throw Error('injected-sync-failure');
        fsyncSync(fd);
      },
    },
    upstreamFetch: async () => {
      fail = true;
      return fakeCompletion();
    },
  });
  try {
    await post(host, 'arm', { mode: 'real' });
    await (await post(host, 'v1/chat/completions', wire)).text();
    const stopped = await status(host);
    assert.equal(stopped.busy, false);
    assert.equal(stopped.real.entries[0].status, 'pending');
    assert.equal(stopped.real.halted, true);
  } finally {
    await close(host);
    await rm(dir, { recursive: true, force: true });
  }
});

test('owned host shutdown aborts an active transport and persists the failure before closing the journal', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'validation-shutdown-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  let aborted = false;
  const host = await createValidationHost({
    port: 0,
    ledgerPath,
    initialize: true,
    upstreamFetch: async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
            init.signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                controller.error(Error('shutdown'));
              },
              { once: true },
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  try {
    await post(host, 'arm', { mode: 'real' });
    const response = await post(host, 'v1/chat/completions', wire);
    const reader = response.body.getReader();
    await reader.read();
    const result = await host.shutdown({ timeoutMs: 1000 });
    assert.equal(aborted, true);
    assert.equal(result.clean, true);
    assert.equal(result.busy, false);
    await reader.cancel().catch(() => {});
    const checkpoint = JSON.parse((await readFile(ledgerPath, 'utf8')).trim().split('\n').at(-1));
    assert.equal(checkpoint.state.entries[0].status, 'aborted');
    assert.equal(checkpoint.state.halted, true);
    const restarted = await createValidationHost({ port: 0, ledgerPath });
    try {
      assert.equal((await post(restarted, 'arm', { mode: 'real' })).status, 409);
    } finally {
      await close(restarted);
    }
  } finally {
    await close(host);
    await removeFixtureDirectory(dir, 'validation-shutdown-');
  }
});

test('bounded shutdown of an abort-ignoring transport leaves a durable pending budget blocking restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'validation-shutdown-bound-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  let finishTransport, entered;
  const dispatched = new Promise((resolve) => {
    entered = resolve;
  });
  const host = await createValidationHost({
    port: 0,
    ledgerPath,
    initialize: true,
    upstreamFetch: async () => {
      entered();
      return new Promise((resolve) => {
        finishTransport = resolve;
      });
    },
  });
  try {
    await post(host, 'arm', { mode: 'real' });
    const request = post(host, 'v1/chat/completions', wire).catch(() => null);
    await dispatched;
    const result = await host.shutdown({ timeoutMs: 30 });
    assert.equal(result.clean, false);
    const checkpoint = JSON.parse((await readFile(ledgerPath, 'utf8')).trim().split('\n').at(-1));
    assert.equal(checkpoint.state.entries[0].status, 'pending');
    const restarted = await createValidationHost({ port: 0, ledgerPath });
    try {
      assert.equal((await post(restarted, 'arm', { mode: 'real' })).status, 409);
    } finally {
      await close(restarted);
    }
    finishTransport(fakeCompletion());
    await request;
  } finally {
    finishTransport?.(fakeCompletion());
    await close(host);
    await removeFixtureDirectory(dir, 'validation-shutdown-bound-');
  }
});

test('client disconnect does not make an abort-ignoring pending upstream a clean shutdown', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'validation-shutdown-disconnect-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  let finishTransport, entered, sawAbort;
  const dispatched = new Promise((resolve) => {
    entered = resolve;
  });
  const upstreamAborted = new Promise((resolve) => {
    sawAbort = resolve;
  });
  const host = await createValidationHost({
    port: 0,
    ledgerPath,
    initialize: true,
    upstreamFetch: async (_url, init) => {
      init.signal.addEventListener('abort', sawAbort, { once: true });
      entered();
      return new Promise((resolve) => {
        finishTransport = resolve;
      });
    },
  });
  const controller = new AbortController();
  try {
    await post(host, 'arm', { mode: 'real' });
    const request = fetch(`${baseOf(host)}/validation-api/v1/chat/completions`, {
      method: 'POST',
      headers: { origin: baseOf(host), 'content-type': 'application/json' },
      body: JSON.stringify(wire),
      signal: controller.signal,
    }).catch(() => null);
    await dispatched;
    controller.abort();
    await request;
    await upstreamAborted;
    const before = await status(host);
    assert.equal(before.busy, true);
    assert.equal(before.real.entries[0].status, 'pending');
    const checkpointBefore = await readFile(ledgerPath, 'utf8');
    const result = await host.shutdown({ timeoutMs: 100 });
    assert.equal(result.clean, false);
    assert.equal(result.busy, true);
    assert.equal(await readFile(ledgerPath, 'utf8'), checkpointBefore);
    const restarted = await createValidationHost({ port: 0, ledgerPath });
    try {
      const restored = await status(restarted);
      assert.equal(restored.real.requests, before.real.requests);
      assert.equal(restored.real.spentCny, before.real.spentCny);
      assert.equal(restored.real.entries[0].status, 'pending');
      assert.equal((await post(restarted, 'arm', { mode: 'real' })).status, 409);
    } finally {
      await close(restarted);
    }
    // Let the ignored transport return only after the journal has closed.
    finishTransport(fakeCompletion());
    assert.equal(await readFile(ledgerPath, 'utf8'), checkpointBefore);
  } finally {
    controller.abort();
    finishTransport?.(fakeCompletion());
    await close(host);
    await removeFixtureDirectory(dir, 'validation-shutdown-disconnect-');
  }
});
