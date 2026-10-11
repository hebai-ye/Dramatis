import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const REQUIRED_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'apps/web/package.json',
  'apps/web/index.html',
  'apps/web/vite.config.ts',
  'apps/web/public/sw.js',
  'apps/web/tools/shell-assets.ts',
  'packages/core/package.json',
];
const SOURCE_DIRS = ['apps/web/src', 'apps/web/public', 'apps/web/tools', 'packages/core/src'];
const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];
const PROVENANCE = 'apps/web/dist/.desktop-build-inputs.json';
const FORMAT = 2;

function contained(root, absolute) {
  const path = relative(root, absolute);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw Error(`构建输入越界：${path}`);
  return path.replaceAll('\\', '/');
}

async function safeStat(root, absolute) {
  const name = contained(root, absolute);
  let current = root;
  for (const part of name.split('/')) {
    if (!part) continue;
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw Error(`Dangerous symlink: ${name}`);
  }
  return lstat(absolute);
}

async function addFile(root, absolute, records) {
  const stat = await safeStat(root, absolute);
  if (!stat.isFile()) throw Error(`构建输入不是文件：${contained(root, absolute)}`);
  const bytes = await readFile(absolute);
  records.set(contained(root, absolute), createHash('sha256').update(bytes).digest('hex'));
}

async function addTree(root, absolute, records) {
  const stat = await safeStat(root, absolute);
  if (!stat.isDirectory()) throw Error(`构建输入不是目录：${contained(root, absolute)}`);
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const path = join(absolute, entry.name);
    if (entry.isSymbolicLink()) throw Error(`Dangerous symlink: ${contained(root, path)}`);
    if (entry.isDirectory()) await addTree(root, path, records);
    else if (entry.isFile()) await addFile(root, path, records);
    else throw Error(`特殊文件不可用于构建：${contained(root, path)}`);
  }
}

function stripJsonComments(raw) {
  let result = '';
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const next = raw[i + 1];
    if (quoted) {
      result += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      result += c;
    } else if (c === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      result += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i++;
    } else result += c;
  }
  return result.replace(/,\s*([}\]])/g, '$1');
}

async function addTsconfig(root, absolute, records, visited) {
  const normalized = resolve(absolute);
  if (visited.has(normalized)) return;
  visited.add(normalized);
  await addFile(root, normalized, records);
  const config = JSON.parse(stripJsonComments(await readFile(normalized, 'utf8')));
  const parents = config.extends === undefined ? [] : Array.isArray(config.extends) ? config.extends : [config.extends];
  for (const parent of parents) {
    if (typeof parent !== 'string' || !parent.startsWith('.')) throw Error(`不支持仓库外 tsconfig extends：${parent}`);
    const path = resolve(dirname(normalized), parent.endsWith('.json') ? parent : `${parent}.json`);
    contained(root, path);
    await addTsconfig(root, path, records, visited);
  }
  for (const reference of config.references ?? []) {
    if (typeof reference.path !== 'string') throw Error('tsconfig reference 缺少 path');
    const target = resolve(dirname(normalized), reference.path);
    contained(root, target);
    const path = target.endsWith('.json') ? target : join(target, 'tsconfig.json');
    await addTsconfig(root, path, records, visited);
  }
}

async function viteVersion(root) {
  for (const path of ['apps/web/node_modules/vite/package.json', 'node_modules/vite/package.json']) {
    try {
      return JSON.parse(await readFile(join(root, path), 'utf8')).version;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw Error('找不到 Vite 版本，请先安装依赖');
}

export async function fingerprintBuildInputs(root, options = {}) {
  root = resolve(root);
  const records = new Map();
  for (const path of REQUIRED_FILES) await addFile(root, join(root, path), records);
  for (const path of SOURCE_DIRS) await addTree(root, join(root, path), records);
  const visited = new Set();
  for (const path of ['apps/web/tsconfig.json', 'apps/web/tsconfig.tools.json', 'packages/core/tsconfig.json']) {
    await addTsconfig(root, join(root, path), records, visited);
  }
  for (const file of ENV_FILES) {
    const path = join(root, 'apps/web', file);
    try {
      await lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    await addFile(root, path, records);
  }
  const env = Object.entries(options.env ?? process.env)
    .filter(([key]) => key === 'NODE_ENV' || key === 'NODE_OPTIONS' || key === 'BASE_URL' || key.startsWith('VITE_'))
    .sort(([a], [b]) => a.localeCompare(b));
  const context = {
    format: FORMAT,
    mode: 'production',
    node: options.nodeVersion ?? process.version,
    vite: options.viteVersion ?? (await viteVersion(root)),
    env,
    files: [...records].sort(([a], [b]) => a.localeCompare(b)),
  };
  return createHash('sha256').update(JSON.stringify(context)).digest('hex');
}

async function regularOutput(root, path) {
  const stat = await safeStat(root, join(root, path));
  if (!stat.isFile()) throw Error(`构建产物不是文件：${path}`);
}

function htmlAttribute(tag, name) {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

async function outputFingerprint(root) {
  const records = new Map();
  const walk = async (dir) => {
    const stat = await safeStat(root, dir);
    if (!stat.isDirectory()) throw Error('构建产物目录无效');
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (
        entry.name === '.desktop-build-inputs.json' ||
        /^\.desktop-build-inputs\.json\.[0-9a-f-]+\.tmp$/.test(entry.name)
      ) {
        if (dir === join(root, 'apps/web/dist')) continue;
      }
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error(`Dangerous symlink: ${contained(root, path)}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) await addFile(root, path, records);
      else throw Error(`特殊文件不可用于构建：${contained(root, path)}`);
    }
  };
  await walk(join(root, 'apps/web/dist'));
  return createHash('sha256')
    .update(JSON.stringify([...records].sort(([a], [b]) => a.localeCompare(b))))
    .digest('hex');
}

async function validateOutput(root) {
  await regularOutput(root, 'apps/web/dist/index.html');
  await regularOutput(root, 'apps/web/dist/sw.js');
  await regularOutput(root, 'apps/web/dist/assets/shell-assets.json');
  const files = JSON.parse(await readFile(join(root, 'apps/web/dist/assets/shell-assets.json'), 'utf8')).files;
  if (!Array.isArray(files)) throw Error('离线资源清单无效');
  for (const file of files) {
    if (
      typeof file !== 'string' ||
      !/^\/assets\/[A-Za-z0-9._/-]+\.(js|css)$/.test(file) ||
      file.split('/').includes('..') ||
      file.includes('//')
    ) {
      throw Error(`不安全的离线资源路径：${String(file)}`);
    }
    await regularOutput(root, `apps/web/dist${file}`);
  }
  const manifest = new Set(files);
  const index = (await readFile(join(root, 'apps/web/dist/index.html'), 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
  let moduleEntries = 0;
  for (const [, kind, tag] of index.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const isModule = kind.toLowerCase() === 'script' && htmlAttribute(tag, 'type')?.toLowerCase() === 'module';
    const isStyleOrPreload =
      kind.toLowerCase() === 'link' &&
      htmlAttribute(tag, 'rel')
        ?.toLowerCase()
        .split(/\s+/)
        .some((rel) => rel === 'stylesheet' || rel === 'modulepreload');
    if (!isModule && !isStyleOrPreload) continue;
    const asset = htmlAttribute(tag, isModule ? 'src' : 'href');
    if (isModule) moduleEntries++;
    if (isModule && !asset?.endsWith('.js')) throw Error('HTML 模块入口不是 JS 文件');
    if (
      isStyleOrPreload &&
      !asset?.endsWith(htmlAttribute(tag, 'rel')?.toLowerCase().includes('stylesheet') ? '.css' : '.js')
    )
      throw Error('HTML 样式或预加载入口类型不符');
    if (!manifest.has(asset)) throw Error(`HTML 入口资源未列入离线清单：${String(asset)}`);
  }
  if (moduleEntries === 0) throw Error('HTML 缺少模块入口');
  const worker = await readFile(join(root, 'apps/web/dist/sw.js'), 'utf8');
  if (!worker.endsWith(`\n// Shell assets: ${JSON.stringify(files)}\n`)) throw Error('sw.js 离线资源尾注与清单不一致');
  return outputFingerprint(root);
}

export async function productionBuildIsFresh(root, options = {}) {
  try {
    const metadata = JSON.parse(await readFile(join(root, PROVENANCE), 'utf8'));
    if (metadata.format !== FORMAT || metadata.fingerprint !== (await fingerprintBuildInputs(root, options)))
      return false;
    return metadata.outputFingerprint === (await validateOutput(resolve(root)));
  } catch {
    return false;
  }
}

export async function buildProductionOutput(root, build, options = {}) {
  root = resolve(root);
  if (!options.force && (await productionBuildIsFresh(root, options))) return 'reused';
  const provenance = join(root, PROVENANCE);
  await rm(provenance, { force: true });
  const before = await fingerprintBuildInputs(root, options);
  await build();
  const after = await fingerprintBuildInputs(root, options);
  if (before !== after) throw Error('Build inputs changed during build; rerun desktop launch');
  const output = await validateOutput(root);
  const temp = `${provenance}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ format: FORMAT, fingerprint: after, outputFingerprint: output }), {
      flag: 'wx',
    });
    await rename(temp, provenance);
  } finally {
    await rm(temp, { force: true });
  }
  return 'built';
}
