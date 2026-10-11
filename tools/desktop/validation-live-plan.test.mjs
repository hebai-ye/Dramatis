import assert from 'node:assert/strict';
import test from 'node:test';
import { planRemainingSamples } from './validation-live-plan.mjs';

const mapping = [
  { blindId: 'B029', caseId: 'affect-1', side: 'shared', repeat: 2 },
  { blindId: 'B011', caseId: 'affect-1', side: 'shared', repeat: 1 },
  { blindId: 'B003', caseId: 'admin-1', side: 'baseline', repeat: 2 },
  { blindId: 'B018', caseId: 'admin-1', side: 'candidate', repeat: 2 },
];
const options = ['B003', 'B029', 'B018', 'B011'].map((id, i) => ({
  value: String(i),
  label: `${id} · ${id === 'B029' || id === 'B011' ? 'affect' : 'admin'}`,
}));

test('skips only the previously attempted semantic tuple after blind IDs change', () => {
  assert.deepEqual(planRemainingSamples(mapping, options), [
    { blindId: 'B003', value: '0', family: 'admin' },
    { blindId: 'B018', value: '2', family: 'admin' },
    { blindId: 'B011', value: '3', family: 'affect' },
  ]);
});
test('rejects a missing or duplicated previously attempted sample', () => {
  assert.throws(() =>
    planRemainingSamples(
      mapping.map((row) => ({ ...row, repeat: 1 })),
      options,
    ),
  );
  assert.throws(() =>
    planRemainingSamples(
      mapping.map((row) => (row.blindId === 'B011' ? { ...row, repeat: 2 } : row)),
      options,
    ),
  );
});
test('rejects mismatched, duplicated or unmapped UI identities instead of guessing', () => {
  assert.throws(() => planRemainingSamples(mapping, options.slice(1)));
  assert.throws(() =>
    planRemainingSamples(
      mapping,
      options.map((row) => ({ ...row, label: 'B003 · admin' })),
    ),
  );
  assert.throws(() =>
    planRemainingSamples(
      mapping,
      options.map((row) => ({ ...row, label: 'unknown · admin' })),
    ),
  );
});
