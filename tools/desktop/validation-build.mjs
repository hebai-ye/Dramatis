import { fileURLToPath } from 'node:url';
import { build } from '../../apps/web/node_modules/vite/dist/node/index.js';
import { withBaselineAdmin } from './validation-baseline.mjs';

await withBaselineAdmin(async (baselineEntry) =>
  build({
    configFile: false,
    root: fileURLToPath(new URL('../../apps/web/tests/quality', import.meta.url)),
    base: '/validation/',
    plugins: [
      {
        name: 'isolated-baseline-admin',
        resolveId(id) {
          if (id === 'virtual:validation-baseline-admin') return baselineEntry;
        },
      },
    ],
    build: { outDir: 'build', emptyOutDir: true, target: 'es2022' },
  }),
);
