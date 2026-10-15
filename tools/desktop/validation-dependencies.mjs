import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { hash } from './validation-common.mjs';

const corePrefix = 'packages/core/src/';
const adminPrefix = `${corePrefix}admin/`;
const productionFile = (file) =>
  file.startsWith(corePrefix) && file.endsWith('.ts') && !/\.test\.ts$|\/eval\//.test(file);
const digest = (source) => createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex');

/** Include new and untracked production sources, rather than only the historical git tree. */
export async function listCandidateProductionFiles(root) {
  const files = [];
  async function visit(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw Error(`Symbolic core dependency: ${file}; cannot verify source`);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && productionFile(file)) files.push(file);
    }
  }
  await visit(corePrefix.slice(0, -1));
  return files.sort();
}

export async function hashValidationDependencies({ baselineFiles, candidateFiles, readBaseline, readCandidate }) {
  const baseline = [...new Set(baselineFiles.filter(productionFile))].sort();
  const candidate = [...new Set(candidateFiles.filter(productionFile))].sort();
  const historical = new Set(baseline);
  const current = new Set(candidate);
  const additions = candidate.filter((file) => !historical.has(file));
  for (const file of additions)
    if (!file.startsWith(adminPrefix)) throw Error(`New non-admin dependency: ${file}; cannot label shared baseline`);
  const dependencyHashes = {};
  for (const file of baseline) {
    if (!current.has(file)) throw Error(`Missing candidate dependency: ${file}`);
    const pair = { baseline: digest(await readBaseline(file)), candidate: digest(await readCandidate(file)) };
    if (!file.startsWith(adminPrefix) && pair.baseline !== pair.candidate)
      throw Error(`Non-admin dependency changed: ${file}; cannot label shared baseline`);
    dependencyHashes[file] = pair;
  }
  // Candidate additions have no historical blob. Keep them outside the frozen baseline's map.
  const candidateOnlyDependencyHashes = {};
  for (const file of additions) candidateOnlyDependencyHashes[file] = digest(await readCandidate(file));
  const baselineSources = Object.fromEntries(
    Object.entries(dependencyHashes).map(([file, pair]) => [file, pair.baseline]),
  );
  const candidateSources = {
    ...Object.fromEntries(Object.entries(dependencyHashes).map(([file, pair]) => [file, pair.candidate])),
    ...candidateOnlyDependencyHashes,
  };
  return {
    dependencyHashes,
    candidateOnlyDependencyHashes,
    sourceHashes: { baseline: hash(baselineSources), candidate: hash(candidateSources) },
  };
}
