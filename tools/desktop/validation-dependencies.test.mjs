import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { hash } from './validation-common.mjs';
import { hashValidationDependencies, listCandidateProductionFiles } from './validation-dependencies.mjs';

const shared = 'packages/core/src/model/card.ts';
const admin = 'packages/core/src/admin/tools.ts';
const added = 'packages/core/src/admin/world-book.ts';
const historical = { [shared]: 'export const shared = 1;\n', [admin]: 'export const tools = [];\n' };
const compute = (candidate, baselineFiles = Object.keys(historical)) =>
  hashValidationDependencies({
    baselineFiles,
    candidateFiles: Object.keys(candidate),
    readBaseline: (file) => historical[file],
    readCandidate: (file) => candidate[file],
  });

test('persisted baseline keeps its fixed canonical hash and historical source map', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../../docs/quality-fixtures/manifest.json', import.meta.url), 'utf8'),
  );
  assert.equal(hash(manifest.baseline), 'a490d9633ebf203737f87890b429b1181120cc1f6f9cd618a5b55f3d22820f3b');
  const sourceHash = hash(
    Object.fromEntries(Object.entries(manifest.dependencyHashes).map(([file, pair]) => [file, pair.baseline])),
  );
  assert.equal(
    manifest.baseline.every((fixture) => fixture.sourceHash === sourceHash),
    true,
  );
});

test('new admin dependency changes candidate hash while the complete baseline remains frozen', async () => {
  const old = await compute(historical);
  const first = await compute({ ...historical, [added]: 'export const complete = true;\n' });
  const second = await compute({ ...historical, [added]: 'export const complete = false;\n' });
  const fixture = { caseId: 'admin-1', input: {}, request: { messages: [] }, sourceHash: old.sourceHashes.baseline };
  const frozenHash = hash([fixture]);
  for (const result of [first, second]) {
    assert.deepEqual(result.dependencyHashes, old.dependencyHashes);
    assert.equal(result.sourceHashes.baseline, old.sourceHashes.baseline);
    assert.equal(hash([{ ...fixture, sourceHash: result.sourceHashes.baseline }]), frozenHash);
    assert.deepEqual(Object.keys(result.candidateOnlyDependencyHashes), [added]);
    assert.notEqual(result.sourceHashes.candidate, old.sourceHashes.candidate);
    assert.notEqual(hash([{ ...fixture, sourceHash: result.sourceHashes.candidate }]), frozenHash);
  }
  assert.notEqual(first.candidateOnlyDependencyHashes[added], second.candidateOnlyDependencyHashes[added]);
  assert.notEqual(first.sourceHashes.candidate, second.sourceHashes.candidate);
  assert.notEqual(
    hash([{ ...fixture, sourceHash: first.sourceHashes.candidate }]),
    hash([{ ...fixture, sourceHash: second.sourceHashes.candidate }]),
  );
});

test('normalized CRLF sources keep both historical and new admin dependency hashes stable', async () => {
  const lf = { ...historical, [added]: 'export const complete = true;\n' };
  const crlf = Object.fromEntries(Object.entries(lf).map(([file, source]) => [file, source.replace(/\n/g, '\r\n')]));
  assert.deepEqual(await compute(crlf), await compute(lf));
});

test('new non-admin production dependency is refused before reading any source', async () => {
  const addedShared = 'packages/core/src/model/new-shared.ts';
  let reads = 0;
  await assert.rejects(
    hashValidationDependencies({
      baselineFiles: Object.keys(historical),
      candidateFiles: [...Object.keys(historical), addedShared],
      readBaseline: () => reads++,
      readCandidate: () => reads++,
    }),
    /New non-admin dependency: packages\/core\/src\/model\/new-shared.ts; cannot label shared baseline/,
  );
  assert.equal(reads, 0);
});

test('changed shared source and missing historical dependency still refuse freezing', async () => {
  await assert.rejects(compute({ ...historical, [shared]: 'changed shared source' }), /Non-admin dependency changed/);
  await assert.rejects(compute({ [shared]: historical[shared] }), /Missing candidate dependency/);
});

test('working tree enumeration includes untracked admin sources and excludes tests and eval', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dramatis-quality-dependencies-'));
  try {
    const files = [shared, admin, added, 'packages/core/src/admin/world-book.test.ts', 'packages/core/src/eval/new.ts'];
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), 'source');
    }
    assert.deepEqual(await listCandidateProductionFiles(root), [admin, added, shared].sort());
    const result = await compute({ ...historical, [added]: 'new source', [files[3]]: 'test', [files[4]]: 'eval' });
    assert.deepEqual(Object.keys(result.candidateOnlyDependencyHashes), [added]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
