import { basename, posix, relative } from 'node:path';
import { normalizePath, type Plugin, type ResolvedConfig } from 'vite';

const QUERY = '?lazy-module-url';
const PREFIX = '\0dramatis-lazy-module:';
const MARKER = '__DRAMATIS_LAZY_DEPENDENCIES_';

/** 给运行时提供构建后的模块地址和未在首屏加载的静态依赖，不提前导入编辑器。 */
export function lazyModuleUrls(): Plugin {
  let config: ResolvedConfig;
  const references = new Set<string>();
  return {
    name: 'dramatis-lazy-module-urls',
    enforce: 'pre',
    configResolved(resolved) {
      config = resolved;
    },
    async resolveId(source, importer) {
      if (!source.endsWith(QUERY)) return null;
      const resolved = await this.resolve(source.slice(0, -QUERY.length), importer);
      if (!resolved) this.error(`无法解析懒加载模块：${source}`);
      return PREFIX + resolved.id;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const moduleId = id.slice(PREFIX.length);
      if (config.command === 'serve') {
        const url = `${config.base}${normalizePath(relative(config.root, moduleId))}`;
        return `export default { url: ${JSON.stringify(url)}, dependencies: [] };`;
      }
      const reference = this.emitFile({
        type: 'chunk',
        id: moduleId,
        name: basename(moduleId).replace(/\.[^.]+$/, ''),
        preserveSignature: 'exports-only',
      });
      references.add(reference);
      return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
    },
    resolveFileUrl({ referenceId, relativePath }) {
      if (!references.has(referenceId)) return null;
      return `({ url: new URL(${JSON.stringify(relativePath)}, import.meta.url).href, dependencies: ${JSON.stringify(`${MARKER}${referenceId}__`)} })`;
    },
    renderChunk(code, chunk, _options, meta) {
      if (!code.includes(MARKER)) return null;
      const emitted = new Set([...references].map((reference) => this.getFileName(reference)));
      const initial = new Set<string>();
      const collect = (file: string, found: Set<string>) => {
        if (found.has(file)) return;
        found.add(file);
        for (const dependency of meta.chunks[file]?.imports ?? []) collect(dependency, found);
      };
      for (const candidate of Object.values(meta.chunks)) {
        if (candidate.isEntry && !emitted.has(candidate.fileName)) collect(candidate.fileName, initial);
      }
      for (const reference of references) {
        const marker = `${MARKER}${reference}__`;
        const tokens = ['"', "'", '`'].map((quote) => `${quote}${marker}${quote}`);
        if (!tokens.some((token) => code.includes(token))) continue;
        const target = this.getFileName(reference);
        const dependencies = new Set<string>();
        for (const dependency of meta.chunks[target]?.imports ?? []) collect(dependency, dependencies);
        dependencies.delete(target);
        const urls = [...dependencies]
          .filter((file) => !initial.has(file))
          .sort()
          .map((file) => {
            const path = posix.relative(posix.dirname(chunk.fileName), file);
            return `new URL(${JSON.stringify(path)}, import.meta.url).href`;
          });
        for (const token of tokens) code = code.replaceAll(token, `[${urls.join(',')}]`);
      }
      return { code, map: null };
    },
  };
}
