import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const digest = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

/** Old admin sources exist only in a temporary directory; the ignored test bundle may include compiled code. */
export async function withBaselineAdmin(callback) {
  const manifest = JSON.parse(await readFile(path.join(root, 'docs/quality-fixtures/manifest.json'), 'utf8'));
  for (const [file, hashes] of Object.entries(manifest.dependencyHashes)) {
    if (
      !file.startsWith('packages/core/src/admin/') &&
      digest(await readFile(path.join(root, file), 'utf8')) !== hashes.baseline
    )
      throw Error(`Baseline dependency drift: ${file}`);
  }
  const temp = await mkdtemp(path.join(tmpdir(), 'dramatis-quality-admin-'));
  try {
    for (const name of ['turn.ts', 'tools.ts']) {
      const file = `packages/core/src/admin/${name}`;
      const raw = execFileSync('git', ['show', `${manifest.baselineCommit}:${file}`], { cwd: root, encoding: 'utf8' });
      if (digest(raw) !== manifest.dependencyHashes[file].baseline) throw Error(`Baseline source mismatch: ${file}`);
      const source = raw.replace(/from\s+(['"])(\.[^'"]+)\1/g, (_match, quote, relative) => {
        const target =
          relative === './tools.js'
            ? path.join(temp, 'tools.ts')
            : path.resolve(root, 'packages/core/src/admin', relative.replace(/\.js$/, '.ts'));
        return `from ${quote}${target.replace(/\\/g, '/')}${quote}`;
      });
      await writeFile(path.join(temp, name), source);
    }
    const entry = path.join(temp, 'entry.ts');
    await writeFile(
      entry,
      `export { runAdminTurn } from './turn';\nexport { parseAdminToolCall } from './tools';\nexport const BASELINE_COMMIT = '${manifest.baselineCommit}';\n`,
    );
    return await callback(entry.replace(/\\/g, '/'));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
