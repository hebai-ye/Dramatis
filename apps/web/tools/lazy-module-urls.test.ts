import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, createServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import type { LazyModuleAddress } from '../src/lib/lazy-module';
import { lazyModuleUrls } from './lazy-module-urls';

const workspaces: string[] = [];
afterEach(async () => {
  for (const workspace of workspaces.splice(0)) {
    if (dirname(resolve(workspace)) !== resolve(tmpdir())) throw new Error('测试临时目录超出预期根目录');
    await rm(workspace, { recursive: true, force: true });
  }
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'dramatis-lazy-test-'));
  workspaces.push(root);
  await Promise.all([
    writeFile(
      join(root, 'entry.ts'),
      `import panelA from './PanelA.ts?lazy-module-url';
       import panelB from './PanelB.ts?lazy-module-url';
       import { initial } from './initial.ts';
       export { panelA, panelB, initial };`,
    ),
    writeFile(
      join(root, 'PanelA.ts'),
      `import { initial } from './initial.ts';
       import { shared } from './shared.ts';
       export function PanelA() { return 'A-' + initial + '-' + shared; }`,
    ),
    writeFile(
      join(root, 'PanelB.ts'),
      `import { shared } from './shared.ts';
       export function PanelB() { return 'B-' + shared; }`,
    ),
    writeFile(join(root, 'shared.ts'), `import { leaf } from './leaf.ts'; export const shared = 'shared-' + leaf;`),
    writeFile(join(root, 'leaf.ts'), `export const leaf = 'leaf';`),
    writeFile(join(root, 'initial.ts'), `export const initial = 'initial';`),
  ]);
  return root;
}

describe('懒加载模块构建地址', () => {
  it('发出独立 hash 模块，并提供完整静态依赖而排除首屏已加载的模块', async () => {
    const root = await workspace();
    const output = await build({
      configFile: false,
      root,
      plugins: [lazyModuleUrls()],
      logLevel: 'silent',
      build: {
        outDir: join(root, 'dist'),
        minify: false,
        lib: { entry: join(root, 'entry.ts'), formats: ['es'], fileName: 'entry' },
        rolldownOptions: { output: { chunkFileNames: 'chunks/[name]-[hash].js' } },
      },
    });
    const result = Array.isArray(output) ? output[0] : output;
    if (!result || !('output' in result)) throw new Error('测试构建必须产生模块输出');
    const chunks = result.output.filter((item) => item.type === 'chunk');
    const entry = chunks.find(
      (item) => item.isEntry && item.facadeModuleId === join(root, 'entry.ts').replaceAll('\\', '/'),
    );
    const panel = chunks.find((item) => item.modules[join(root, 'PanelA.ts').replaceAll('\\', '/')]);
    const shared = chunks.find((item) => item.modules[join(root, 'shared.ts').replaceAll('\\', '/')]);
    expect(entry).toBeDefined();
    expect(panel).toBeDefined();
    expect(shared).toBeDefined();
    if (!entry || !panel || !shared) throw new Error('缺少测试产物');
    expect(entry.imports).not.toContain(panel.fileName);
    const built = (await import(/* @vite-ignore */ pathToFileURL(join(root, 'dist', entry.fileName)).href)) as {
      panelA: LazyModuleAddress;
      panelB: LazyModuleAddress;
    };
    expect(built.panelA.url).toBe(pathToFileURL(join(root, 'dist', panel.fileName)).href);
    expect(built.panelA.dependencies).toEqual([pathToFileURL(join(root, 'dist', shared.fileName)).href]);
    expect(built.panelB.dependencies).toEqual(built.panelA.dependencies);
    const loaded = await import(/* @vite-ignore */ built.panelA.url);
    expect(loaded.PanelA()).toBe('A-initial-shared-leaf');
  });

  it('开发环境返回可由 Vite 编译的源模块地址，兼容非根 base', async () => {
    const root = await workspace();
    const server = await createServer({
      configFile: false,
      root,
      base: '/nested/',
      plugins: [lazyModuleUrls()],
      logLevel: 'silent',
      server: { middlewareMode: true, watch: null },
    });
    try {
      const transformed = await server.transformRequest('/PanelA.ts?lazy-module-url');
      expect(transformed).not.toBeNull();
      if (!transformed) throw new Error('缺少开发模块输出');
      const compiled = await import(
        /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`
      );
      expect(compiled.default).toEqual({ url: '/nested/PanelA.ts', dependencies: [] });
    } finally {
      await server.close();
    }
  });
});
