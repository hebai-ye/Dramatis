import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildProductionOutput, fingerprintBuildInputs, productionBuildIsFresh } from './build-inputs.mjs';

async function put(root, path, value) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dramatis-build-inputs-'));
  t.after(async () => {
    const target = resolve(root);
    const allowed = resolve(tmpdir()) + sep;
    assert.ok(target.startsWith(allowed) && target.split(sep).at(-1).startsWith('dramatis-build-inputs-'));
    await rm(target, { recursive: true, force: true });
  });
  for (const [path, value] of Object.entries({
    'package.json': '{}',
    'pnpm-lock.yaml': 'lock',
    'pnpm-workspace.yaml': 'packages: []',
    'tsconfig.base.json': '{}',
    'apps/web/package.json': '{}',
    'apps/web/index.html': '<html></html>',
    'apps/web/vite.config.ts': 'export default {}',
    'apps/web/tsconfig.json': '{"extends":"../../tsconfig.base.json"}',
    'apps/web/tsconfig.tools.json': '{"extends":"./tsconfig.json"}',
    'apps/web/src/main.ts': 'main',
    'apps/web/public/portraits/hero.webp': 'portrait',
    'apps/web/public/sw.js': 'service worker',
    'apps/web/tools/shell-assets.ts': 'plugin',
    'packages/core/package.json': '{}',
    'packages/core/tsconfig.json': '{"extends":"../../tsconfig.base.json"}',
    'packages/core/src/index.ts': 'core',
  }))
    await put(root, path, value);
  return root;
}

const options = { env: { NODE_ENV: 'production', VITE_FLAG: 'a' }, viteVersion: '8.3.0' };

test('fingerprint changes for content, additions, removals and preserved mtime', async (t) => {
  const root = await fixture(t);
  const before = await fingerprintBuildInputs(root, options);
  const portrait = join(root, 'apps/web/public/portraits/hero.webp');
  const priorTime = new Date(1_700_000_000_000);
  await utimes(portrait, priorTime, priorTime);
  await writeFile(portrait, 'PORTRAIT');
  await utimes(portrait, priorTime, priorTime);
  assert.notEqual(await fingerprintBuildInputs(root, options), before);
  const changed = await fingerprintBuildInputs(root, options);
  await put(root, 'apps/web/tools/extra.ts', 'added');
  assert.notEqual(await fingerprintBuildInputs(root, options), changed);
  await rm(join(root, 'apps/web/tools/extra.ts'));
  assert.equal(await fingerprintBuildInputs(root, options), changed);
});

test('fingerprint covers lock, env, tsconfig reference chain and mode versions', async (t) => {
  const root = await fixture(t);
  const before = await fingerprintBuildInputs(root, options);
  await put(root, 'pnpm-lock.yaml', 'new lock');
  assert.notEqual(await fingerprintBuildInputs(root, options), before);
  const changed = await fingerprintBuildInputs(root, options);
  assert.notEqual(await fingerprintBuildInputs(root, { ...options, env: { ...options.env, VITE_FLAG: 'b' } }), changed);
  assert.notEqual(await fingerprintBuildInputs(root, { ...options, viteVersion: '8.4.0' }), changed);
  await put(root, 'apps/web/tsconfig.json', '{"extends":"./tsconfig.extra.json"}');
  await put(root, 'apps/web/tsconfig.extra.json', '{"extends":"../../tsconfig.base.json"}');
  const withReference = await fingerprintBuildInputs(root, options);
  await put(
    root,
    'apps/web/tsconfig.extra.json',
    '{"extends":"../../tsconfig.base.json","compilerOptions":{"strict":true}}',
  );
  assert.notEqual(await fingerprintBuildInputs(root, options), withReference);
  await put(root, 'apps/web/.env.production.local', 'VITE_SECRET=first');
  const withEnvFile = await fingerprintBuildInputs(root, options);
  await put(root, 'apps/web/.env.production.local', 'VITE_SECRET=second');
  assert.notEqual(await fingerprintBuildInputs(root, options), withEnvFile);
});

test('missing required input and symlink fail stale', async (t) => {
  const root = await fixture(t);
  await rm(join(root, 'apps/web/index.html'));
  await assert.rejects(fingerprintBuildInputs(root, options));
  await put(root, 'apps/web/index.html', 'index');
  await rm(join(root, 'apps/web/public/sw.js'));
  await assert.rejects(fingerprintBuildInputs(root, options));
  await put(root, 'apps/web/public/sw.js', 'service worker');
  const { symlink } = await import('node:fs/promises');
  try {
    await symlink(join(root, 'package.json'), join(root, 'apps/web/public/linked.json'));
  } catch (error) {
    if (error.code === 'EPERM') {
      try {
        await symlink(root, join(root, 'apps/web/public/linked'), 'junction');
      } catch (junctionError) {
        if (junctionError.code === 'EPERM') {
          t.diagnostic('Windows account cannot create symlinks or junctions; link branch skipped');
          return;
        }
        throw junctionError;
      }
    } else {
      throw error;
    }
  }
  await assert.rejects(fingerprintBuildInputs(root, options), /symlink/i);
});

async function validOutput(root, files = ['/assets/main.js', '/assets/main.css']) {
  await put(
    root,
    'apps/web/dist/index.html',
    '<!doctype html><html><head><script type="module" src="/assets/main.js"></script><link rel="stylesheet" href="/assets/main.css"></head><body></body></html>',
  );
  await put(root, 'apps/web/dist/assets/main.js', 'code');
  await put(root, 'apps/web/dist/assets/main.css', 'styles');
  await put(root, 'apps/web/dist/assets/shell-assets.json', JSON.stringify({ files }));
  await put(root, 'apps/web/dist/sw.js', `worker\n// Shell assets: ${JSON.stringify(files)}\n`);
}

test('successful build writes provenance and later input changes require rebuild', async (t) => {
  const root = await fixture(t);
  assert.equal(await productionBuildIsFresh(root, options), false);
  assert.equal(await buildProductionOutput(root, () => validOutput(root), options), 'built');
  assert.equal(await productionBuildIsFresh(root, options), true);
  assert.equal(
    await buildProductionOutput(
      root,
      () => {
        throw Error('should reuse');
      },
      options,
    ),
    'reused',
  );
  await put(root, 'apps/web/src/new.ts', 'new');
  assert.equal(await productionBuildIsFresh(root, options), false);
});

test('failed or changing build cannot keep old provenance', async (t) => {
  const root = await fixture(t);
  await buildProductionOutput(root, () => validOutput(root), options);
  await assert.rejects(
    buildProductionOutput(
      root,
      async () => {
        throw Error('build failed');
      },
      { ...options, force: true },
    ),
    /build failed/,
  );
  assert.equal(await productionBuildIsFresh(root, options), false);
  await assert.rejects(
    buildProductionOutput(
      root,
      async () => {
        await validOutput(root);
        await put(root, 'apps/web/src/main.ts', 'changed during build');
      },
      options,
    ),
    /changed during build/i,
  );
  assert.equal(await productionBuildIsFresh(root, options), false);
});

test('missing, unsafe or inconsistent shell assets reject output', async (t) => {
  const root = await fixture(t);
  for (const files of [['/assets/missing.js'], ['../escape.js'], ['/assets/main.js', '/assets/main.css']]) {
    await assert.rejects(
      buildProductionOutput(
        root,
        async () => {
          await validOutput(root, files);
          if (files[0] === '/assets/main.js') await put(root, 'apps/web/dist/sw.js', 'worker\n// Shell assets: []\n');
        },
        options,
      ),
    );
    assert.equal(await productionBuildIsFresh(root, options), false);
  }
  const provenance = join(root, 'apps/web/dist/.desktop-build-inputs.json');
  await assert.rejects(readFile(provenance, 'utf8'));
});

test('index must reference a real module entry included with linked CSS in the shell manifest', async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    buildProductionOutput(
      root,
      async () => {
        await validOutput(root);
        await put(root, 'apps/web/dist/index.html', '<!doctype html><html><body></body></html>');
      },
      options,
    ),
  );
  await assert.rejects(
    buildProductionOutput(
      root,
      async () => {
        await validOutput(root, ['/assets/main.js']);
      },
      options,
    ),
  );
  await assert.rejects(
    buildProductionOutput(
      root,
      async () => {
        await validOutput(root);
        await put(root, 'apps/web/dist/index.html', '<!-- <script type="module" src="/assets/main.js"></script> -->');
      },
      options,
    ),
  );
  await assert.rejects(
    buildProductionOutput(
      root,
      async () => {
        await validOutput(root);
        await put(root, 'apps/web/dist/index.html', '<script type="module" src="/assets/main.css"></script>');
      },
      options,
    ),
  );
  await assert.equal(await productionBuildIsFresh(root, options), false);
});

test('changed JS, SW body and other dist files invalidate provenance', async (t) => {
  const root = await fixture(t);
  await buildProductionOutput(root, () => validOutput(root), options);
  assert.equal(await productionBuildIsFresh(root, options), true);
  await put(root, 'apps/web/dist/assets/main.js', 'mutated code');
  assert.equal(await productionBuildIsFresh(root, options), false);
  await buildProductionOutput(root, () => validOutput(root), options);
  await put(root, 'apps/web/dist/sw.js', 'mutated worker\n// Shell assets: ["/assets/main.js","/assets/main.css"]\n');
  assert.equal(await productionBuildIsFresh(root, options), false);
  await buildProductionOutput(root, () => validOutput(root), options);
  await put(root, 'apps/web/dist/favicon.png', 'new file');
  assert.equal(await productionBuildIsFresh(root, options), false);
});

test('existing service works without local dependencies and its provenance is reported unknown', async (t) => {
  const root = await fixture(t);
  const source = fileURLToPath(new URL('./launch.mjs', import.meta.url));
  await put(root, 'tools/desktop/launch.mjs', await readFile(source));
  await put(
    root,
    'tools/desktop/build-inputs.mjs',
    await readFile(fileURLToPath(new URL('./build-inputs.mjs', import.meta.url))),
  );
  const server = createServer((_request, response) => response.end('existing'));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const port = server.address().port;
    const launcher = join(root, 'tools/desktop/launch.mjs');
    const child = spawn(process.execPath, [launcher, '--prod', '--no-open'], {
      env: { ...process.env, DRAMATIS_PORT: String(port) },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const code = await new Promise((done) => child.on('exit', done));
    assert.equal(code, 0);
    assert.match(output, /构建来源无法确认/);
    assert.equal(server.listening, true);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
