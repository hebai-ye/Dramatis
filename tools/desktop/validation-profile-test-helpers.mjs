import { lstat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const approvedPrefixes = new Set([
  'validation-profile-',
  'validation-recovery-',
  'validation-shutdown-',
  'validation-shutdown-bound-',
  'validation-shutdown-disconnect-',
]);
const normalized = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

export async function verifiedFixtureDirectory(candidate, prefix) {
  if (!approvedPrefixes.has(prefix) || typeof candidate !== 'string' || !path.isAbsolute(candidate))
    throw Error('unsafe-fixture-cleanup');
  const absolute = path.resolve(candidate);
  const temporaryRoot = path.resolve(tmpdir());
  const name = path.basename(absolute);
  if (
    normalized(path.dirname(absolute)) !== normalized(temporaryRoot) ||
    !name.startsWith(prefix) ||
    !/^[a-zA-Z0-9]{6}$/.test(name.slice(prefix.length))
  )
    throw Error('unsafe-fixture-cleanup');
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('unsafe-fixture-cleanup');
  const resolvedRoot = await realpath(temporaryRoot);
  const resolvedTarget = await realpath(absolute);
  // Both the lexical and actual target must be this exact direct temp child.
  if (normalized(resolvedTarget) !== normalized(path.join(resolvedRoot, name))) throw Error('unsafe-fixture-cleanup');
  return resolvedTarget;
}

export async function removeFixtureDirectory(candidate, prefix) {
  const verified = await verifiedFixtureDirectory(candidate, prefix);
  await rm(verified, { recursive: true, force: true });
}
