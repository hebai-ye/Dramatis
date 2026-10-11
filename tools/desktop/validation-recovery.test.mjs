import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Ledger } from './validation-common.mjs';
import { createValidationHost, validationCliOptions } from './validation-host.mjs';
import { openBudgetJournal } from './validation-journal.mjs';
import { removeFixtureDirectory } from './validation-profile-test-helpers.mjs';

const wire = { messages: [{ role: 'user', content: 'fixture-only' }], max_tokens: 1200 };
async function fixture(status = 'budget-truncation', edit = () => {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'validation-recovery-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  const journal = openBudgetJournal(ledgerPath, { initialize: true });
  const ledger = new Ledger();
  ledger.reserve(wire, 'quality');
  journal.commit(ledger.state);
  if (status !== 'pending') ledger.settle(1, null, status);
  edit(ledger.state);
  journal.commit(ledger.state);
  const checkpointHash = journal.checkpointHash;
  journal.close();
  return { dir, ledgerPath, checkpointHash, before: structuredClone(ledger.state) };
}
const recoveryFor = (f) => ({
  lastEntryId: 1,
  checkpointHash: f.checkpointHash,
  approvedChoice: '4096-preserve-ledger',
});
const baseOf = (host) => `http://127.0.0.1:${host.address().port}`;
const statusOf = async (host) => (await fetch(`${baseOf(host)}/validation-api/status`)).json();
const post = (host, route, body) =>
  fetch(`${baseOf(host)}/validation-api/${route}`, {
    method: 'POST',
    headers: { origin: baseOf(host), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const close = (host) => new Promise((resolve) => host.close(resolve));

test('4096 startup and ordinary arm never clear a halted truncation without explicit approval', async () => {
  const f = await fixture();
  const host = await createValidationHost({ port: 0, ledgerPath: f.ledgerPath, maxOutputTokens: 4096 });
  try {
    assert.equal((await statusOf(host)).real.halted, true);
    assert.equal((await post(host, 'arm', { mode: 'real', recover: true })).status, 409);
    assert.deepEqual((await statusOf(host)).real, f.before);
  } finally {
    await close(host);
    await removeFixtureDirectory(f.dir, 'validation-recovery-');
  }
});

test('checkpoint-bound approval appends durable audit, preserves first charge, and later failures halt again', async () => {
  const f = await fixture();
  let calls = 0;
  let host = await createValidationHost({
    port: 0,
    ledgerPath: f.ledgerPath,
    maxOutputTokens: 4096,
    recovery: recoveryFor(f),
    upstreamFetch: async () => {
      calls++;
      return Response.json({ error: { message: 'fixture failed' } }, { status: 429 });
    },
  });
  try {
    let state = await statusOf(host);
    assert.equal(state.mode, 'locked');
    assert.equal(state.real.halted, false);
    assert.equal(state.real.requests, 1);
    assert.equal(state.real.qualityRequests, 1);
    assert.equal(state.real.spentCny, f.before.spentCny);
    assert.deepEqual(state.real.entries, f.before.entries);
    assert.equal(state.real.recoveryAudit.length, 1);
    assert.equal(state.real.recoveryAudit[0].previousCheckpointHash, f.checkpointHash);
    assert.equal(state.real.recoveryAudit[0].previousStop, 'budget-truncation');
    assert.equal(state.real.recoveryAudit[0].approvedChoice, '4096-preserve-ledger');
    assert.notEqual(state.checkpointHash, f.checkpointHash);
    await close(host);
    await assert.rejects(
      createValidationHost({ port: 0, ledgerPath: f.ledgerPath }),
      /execution-profile-ledger-mismatch/,
    );
    host = await createValidationHost({
      port: 0,
      ledgerPath: f.ledgerPath,
      maxOutputTokens: 4096,
      upstreamFetch: async () => {
        calls++;
        return new Response('{}', { status: 429 });
      },
    });
    state = await statusOf(host);
    assert.equal(state.real.recoveryAudit.length, 1);
    assert.equal(state.real.requests, 1);
    assert.equal(state.real.spentCny, f.before.spentCny);
    assert.equal((await post(host, 'arm', { mode: 'real' })).status, 200);
    await (await post(host, 'v1/chat/completions', { messages: [], max_tokens: 4096 })).text();
    state = await statusOf(host);
    assert.equal(calls, 1);
    assert.equal(state.real.requests, 2);
    assert.ok(state.real.spentCny > f.before.spentCny);
    assert.deepEqual(state.real.entries[0], f.before.entries[0]);
    assert.equal(state.real.entries[1].status, 'failed');
    assert.equal(state.real.halted, true);
    assert.equal((await post(host, 'arm', { mode: 'real' })).status, 409);
  } finally {
    await close(host);
    await removeFixtureDirectory(f.dir, 'validation-recovery-');
  }
});

test('wrong checkpoint, id, choice, profile and every non-truncation stop refuse without a journal write', async () => {
  for (const outcome of ['budget-truncation', 'pending', 'failed', 'missing-usage', 'aborted', 'unknown']) {
    const f = await fixture(outcome);
    try {
      const original = await readFile(f.ledgerPath, 'utf8');
      const attempts =
        outcome === 'budget-truncation'
          ? [
              { recovery: { ...recoveryFor(f), checkpointHash: '0'.repeat(64) }, maxOutputTokens: 4096 },
              { recovery: { ...recoveryFor(f), lastEntryId: 2 }, maxOutputTokens: 4096 },
              { recovery: { ...recoveryFor(f), approvedChoice: undefined }, maxOutputTokens: 4096 },
              { recovery: recoveryFor(f), maxOutputTokens: 1200 },
            ]
          : [{ recovery: recoveryFor(f), maxOutputTokens: 4096 }];
      for (const options of attempts) {
        await assert.rejects(
          createValidationHost({ port: 0, ledgerPath: f.ledgerPath, ...options }),
          /recovery-refused/,
        );
        assert.equal(await readFile(f.ledgerPath, 'utf8'), original);
      }
    } finally {
      await removeFixtureDirectory(f.dir, 'validation-recovery-');
    }
  }
});

test('corrupt suffix, legacy checkpoint, excess charge and duplicate recovery refuse', async () => {
  for (const variant of ['corrupt', 'legacy', 'overcharge', 'duplicate', 'unknown-history', 'rolled-back-history']) {
    const f = await fixture('budget-truncation', (state) => {
      if (variant === 'overcharge') {
        state.entries[0].chargedCny += 1;
        state.spentCny += 1;
      }
    });
    try {
      if (variant === 'corrupt') await writeFile(f.ledgerPath, `${await readFile(f.ledgerPath, 'utf8')}{broken\n`);
      if (variant === 'legacy') await writeFile(f.ledgerPath, JSON.stringify(f.before));
      if (variant === 'unknown-history' || variant === 'rolled-back-history') {
        const journal = openBudgetJournal(f.ledgerPath);
        const edited = structuredClone(f.before);
        if (variant === 'unknown-history') edited.entries[0].status = 'failed';
        else {
          edited.requests = 0;
          edited.qualityRequests = 0;
          edited.entries = [];
          edited.spentCny = 0;
        }
        journal.commit(edited);
        journal.commit(f.before);
        f.checkpointHash = journal.checkpointHash;
        journal.close();
      }
      if (variant === 'duplicate') {
        const host = await createValidationHost({
          port: 0,
          ledgerPath: f.ledgerPath,
          maxOutputTokens: 4096,
          recovery: recoveryFor(f),
        });
        f.checkpointHash = (await statusOf(host)).checkpointHash;
        await close(host);
      }
      const original = await readFile(f.ledgerPath, 'utf8');
      await assert.rejects(
        createValidationHost({ port: 0, ledgerPath: f.ledgerPath, maxOutputTokens: 4096, recovery: recoveryFor(f) }),
        /recovery-refused/,
      );
      assert.equal(await readFile(f.ledgerPath, 'utf8'), original);
    } finally {
      await removeFixtureDirectory(f.dir, 'validation-recovery-');
    }
  }
});

test('CLI requires explicit paired entry/checkpoint and 4096 without initialization', () => {
  const digest = 'a'.repeat(64);
  assert.equal(validationCliOptions([]).maxOutputTokens, 1200);
  const approved = validationCliOptions([
    '--output-tokens=4096',
    '--resume-truncation=1',
    `--resume-checkpoint=${digest}`,
  ]);
  assert.deepEqual(approved.recovery, {
    lastEntryId: 1,
    checkpointHash: digest,
    approvedChoice: '4096-preserve-ledger',
  });
  for (const args of [
    ['--resume-truncation=1'],
    [`--resume-checkpoint=${digest}`],
    ['--output-tokens=1200', '--resume-truncation=1', `--resume-checkpoint=${digest}`],
    ['--initialize-ledger', '--output-tokens=4096', '--resume-truncation=1', `--resume-checkpoint=${digest}`],
    ['--output-tokens=4096', '--output-tokens=1200'],
    ['--output-tokens=4097'],
    ['--resume-truncation=2'],
  ])
    assert.throws(() => validationCliOptions(args), /cli-option|recovery-refused/);
});

test('initialize refuses to append a fresh zero-budget over existing historical checkpoints', async () => {
  const f = await fixture();
  try {
    const original = await readFile(f.ledgerPath, 'utf8');
    await assert.rejects(
      createValidationHost({ port: 0, ledgerPath: f.ledgerPath, initialize: true }),
      /ledger-existing/,
    );
    assert.equal(await readFile(f.ledgerPath, 'utf8'), original);
  } finally {
    await removeFixtureDirectory(f.dir, 'validation-recovery-');
  }
});

test('recovery audit flush failure retains the exclusive lock and never dispatches', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    await assert.rejects(
      createValidationHost({
        port: 0,
        ledgerPath: f.ledgerPath,
        maxOutputTokens: 4096,
        recovery: recoveryFor(f),
        journalIo: {
          write(...args) {
            writeSync(...args);
            throw Error('injected-audit-write-failure');
          },
        },
        upstreamFetch: async () => {
          calls++;
          return Response.json({});
        },
      }),
      /durability-unavailable/,
    );
    assert.equal(calls, 0);
    await assert.rejects(createValidationHost({ port: 0, ledgerPath: f.ledgerPath }), /ledger-locked/);
  } finally {
    await removeFixtureDirectory(f.dir, 'validation-recovery-');
  }
});
