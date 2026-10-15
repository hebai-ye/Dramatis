import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../apps/web/node_modules/vite/dist/node/index.js';
import { hash } from './validation-common.mjs';
import { hashValidationDependencies, listCandidateProductionFiles } from './validation-dependencies.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 20_000_000 });
const baselineCommit = git('rev-parse', '4c5169a').trim();
const commit = git('rev-parse', 'HEAD').trim();
const adminFiles = ['packages/core/src/admin/prompt.ts', 'packages/core/src/admin/tools.ts'];
const baselineFiles = git('ls-tree', '-r', '--name-only', baselineCommit, 'packages/core/src').trim().split('\n');
const { dependencyHashes, candidateOnlyDependencyHashes, sourceHashes } = await hashValidationDependencies({
  baselineFiles,
  candidateFiles: await listCandidateProductionFiles(root),
  readBaseline: (file) => git('show', `${baselineCommit}:${file}`),
  readCandidate: (file) => readFile(path.join(root, file), 'utf8'),
});
const temp = await mkdtemp(path.join(tmpdir(), 'dramatis-quality-baseline-'));
async function cleanupBaselineTemp() {
  if (
    path.dirname(path.resolve(temp)) !== path.resolve(tmpdir()) ||
    !path.basename(temp).startsWith('dramatis-quality-baseline-')
  )
    throw Error('Refusing cleanup outside the owned baseline temporary directory');
  await rm(temp, { recursive: true, force: true });
}
const server = await createServer({ configFile: false, root, server: { middlewareMode: true }, appType: 'custom' });
try {
  for (const file of adminFiles) {
    const source = git('show', `${baselineCommit}:${file}`).replace(
      /from\s+(['"])(\.[^'"]+)\1/g,
      (_match, quote, relative) => {
        const resolved =
          relative === './tools.js'
            ? path.join(temp, 'tools.ts')
            : path.resolve(root, path.dirname(file), relative.replace(/\.js$/, '.ts'));
        return `from ${quote}${resolved.replace(/\\/g, '/')}${quote}`;
      },
    );
    await writeFile(path.join(temp, path.basename(file)), source);
  }
  const { makeCases } = await server.ssrLoadModule('/apps/web/tests/quality/fixtures.ts');
  const baselinePrompt = await server.ssrLoadModule(path.join(temp, 'prompt.ts').replace(/\\/g, '/'));
  const baselineTools = await server.ssrLoadModule(path.join(temp, 'tools.ts').replace(/\\/g, '/'));
  const baseline = makeCases(baselinePrompt.buildAdminMessages, baselineTools.ADMIN_TOOLS);
  const candidate = makeCases();
  const wrap = (cases, side) =>
    cases.map((item) => ({
      ...item,
      fixtureHash: hash(item.input),
      requestHash: hash(item.request),
      commit: side === 'baseline' ? baselineCommit : commit,
      source: side === 'baseline' ? 'git-blob-4c5169a-admin + hash-verified-shared-dependencies' : 'working-tree',
      sourceHash: sourceHashes[side],
    }));
  const output = {
    schema: 2,
    fixedTime: '2026-10-03T00:00:00.000Z',
    baselineCommit,
    candidateCommit: commit,
    dependencyHashes,
    candidateOnlyDependencyHashes,
    baseline: wrap(baseline, 'baseline'),
    candidate: wrap(candidate, 'candidate'),
  };
  output.comparison = baseline.map((b, i) => ({
    caseId: b.caseId,
    identical: hash(b.request) === hash(candidate[i].request),
    evaluation:
      hash(b.request) === hash(candidate[i].request)
        ? 'shared-current-state-only; two repeats total'
        : 'two repeats per side; exploratory',
  }));
  const destination = path.join(root, 'docs/quality-fixtures/manifest.json');
  await mkdir(path.dirname(destination), { recursive: true });
  // Re-generation never replaces the already frozen baseline with candidate data.
  try {
    const old = JSON.parse(await readFile(destination, 'utf8'));
    if (old.schema === 1) {
      // One-way metadata correction: v1 input held shared entities; v2 freezes exact builder inputs.
      // Every already-frozen production request must remain byte-equivalent after canonicalization.
      if (hash(old.baseline.map((c) => c.request)) !== hash(output.baseline.map((c) => c.request)))
        throw Error('Frozen requests changed; refusing schema migration');
    } else if (hash(old.baseline) !== hash(output.baseline))
      throw Error('Frozen baseline mismatch; refusing overwrite');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const formatted = execFileSync(
    process.execPath,
    [path.join(root, 'node_modules/@biomejs/biome/bin/biome'), 'format', '--stdin-file-path', destination],
    { cwd: root, input: JSON.stringify(output), encoding: 'utf8', maxBuffer: 20_000_000 },
  );
  await writeFile(destination, formatted);
  console.log(
    JSON.stringify({
      destination,
      baselineCommit,
      cases: baseline.length,
      identical: output.comparison.filter((c) => c.identical).length,
      baselineHash: hash(output.baseline),
    }),
  );
} finally {
  await server.close();
  await cleanupBaselineTemp();
}
