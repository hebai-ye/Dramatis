import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanEvidence, Ledger, reservation } from './validation-common.mjs';

const wire = { model: 'deepseek-flash', messages: [{ role: 'user', content: '你好' }], max_tokens: 1200 };
test('48 total, 44 quality; failed and aborted calls consume reservation and stop', () => {
  const ledger = new Ledger();
  for (let i = 0; i < 44; i++) {
    const id = ledger.reserve(wire, 'quality');
    ledger.settle(id, { prompt_tokens: 1, completion_tokens: 1 });
  }
  assert.throws(() => ledger.reserve(wire, 'quality'), /C05/);
  for (let i = 0; i < 4; i++) {
    const id = ledger.reserve(wire, 'csp');
    ledger.settle(id, { prompt_tokens: 1, completion_tokens: 1 });
  }
  assert.throws(() => ledger.reserve(wire, 'csp'), /48/);
  for (const outcome of ['failed', 'aborted', 'missing-usage']) {
    const failed = new Ledger();
    const id = failed.reserve(wire, 'quality');
    failed.settle(id, null, outcome);
    assert.equal(failed.state.requests, 1);
    assert.equal(failed.state.spentCny, reservation(wire));
    assert.equal(failed.state.halted, true);
    assert.throws(() => failed.reserve(wire, 'csp'), /halted/);
  }
});
test('5 CNY boundary, restored pending call and invalid usage fail closed', () => {
  const ledger = new Ledger({ version: 1, requests: 0, qualityRequests: 0, spentCny: 5, halted: false, entries: [] });
  assert.throws(() => ledger.reserve(wire, 'quality'), /5 CNY/);
  const exact = new Ledger({
    version: 1,
    requests: 0,
    qualityRequests: 0,
    spentCny: 5 - reservation(wire),
    halted: false,
    entries: [],
  });
  exact.reserve(wire, 'quality');
  assert.equal(exact.state.spentCny, 5);
  assert.throws(() => exact.reserve(wire, 'csp'), /5 CNY/);
  const pending = new Ledger();
  pending.reserve(wire, 'quality');
  assert.equal(new Ledger(pending.state).state.halted, true);
  const invalid = new Ledger();
  const id = invalid.reserve(wire, 'quality');
  invalid.settle(id, { prompt_tokens: -1, completion_tokens: 1 });
  assert.equal(invalid.state.halted, true);
});
test('exports remove secret fields, reasoning and explicit key echoes recursively', () => {
  const cleaned = cleanEvidence(
    {
      text: 'echo TEST-SECRET',
      Authorization: 'Bearer TEST-SECRET',
      nested: { apiKey: 'TEST-SECRET', reasoning_content: 'private', ok: true },
    },
    'TEST-SECRET',
  );
  assert.equal(JSON.stringify(cleaned).includes('TEST-SECRET'), false);
  assert.equal(JSON.stringify(cleaned).includes('reasoning'), false);
  assert.equal(cleaned.nested.ok, true);
});
test('non-secret Low execution profile survives evidence scrubbing while private reasoning is removed', () => {
  const profile = {
    profileId: 'deepseek-flash-low-output-4096-v1',
    maxOutputTokens: 4096,
    model: 'deepseek-flash',
    reasoningEffort: 'low',
  };
  const cleaned = cleanEvidence({ executionProfile: profile, reasoning_content: 'PRIVATE-CHAIN' });
  assert.deepEqual(cleaned.executionProfile, profile);
  assert.equal(JSON.stringify(cleaned).includes('PRIVATE-CHAIN'), false);
});
test('4096 preserves 44 quality/48 total caps and rejects its larger reservation above 5 CNY', () => {
  const larger = { ...wire, max_tokens: 4096 };
  const ledger = new Ledger();
  for (let i = 0; i < 44; i++) {
    const id = ledger.reserve(larger, 'quality');
    ledger.settle(id, { prompt_tokens: 1, completion_tokens: 1 });
  }
  assert.throws(() => ledger.reserve(larger, 'quality'), /C05/);
  for (let i = 0; i < 4; i++) {
    const id = ledger.reserve(larger, 'csp');
    ledger.settle(id, { prompt_tokens: 1, completion_tokens: 1 });
  }
  assert.throws(() => ledger.reserve(larger, 'csp'), /48/);
  const nearCap = new Ledger({
    version: 1,
    requests: 0,
    qualityRequests: 0,
    spentCny: 4.98,
    halted: false,
    entries: [],
  });
  assert.throws(() => nearCap.reserve(larger, 'quality'), /5 CNY/);
  assert.equal(nearCap.state.requests, 0);
  assert.equal(nearCap.state.spentCny, 4.98);
});
