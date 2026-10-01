import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

/** 将未打开过的懒加载模块也纳入离线外壳；每次产物变化都会更新 SW。 */
export function shellAssets(): Plugin {
  return {
    name: 'dramatis-shell-assets',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((file) => /\.(js|css)$/.test(file))
        .map((file) => `/${file}`)
        .sort();
      this.emitFile({ type: 'asset', fileName: 'assets/shell-assets.json', source: JSON.stringify({ files }) });
      const worker = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: `${worker}\n// Shell assets: ${JSON.stringify(files)}\n`,
      });
    },
  };
}
