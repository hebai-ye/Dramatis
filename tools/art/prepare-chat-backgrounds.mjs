#!/usr/bin/env node
/**
 * Encode approved PNG backgrounds without changing their artwork.
 *
 * Usage (from any directory):
 *   NODE_PATH=/path/to/bundled/node_modules node tools/art/prepare-chat-backgrounds.mjs
 *   node tools/art/prepare-chat-backgrounds.mjs --dry-run
 *   node tools/art/prepare-chat-backgrounds.mjs --manifest /absolute/source-images.json
 *
 * The manifest is an array of { id, label, source, prompt }; source must be an
 * absolute PNG path. Missing sources are reported and skipped, so the same
 * manifest can be rerun as image generation finishes. Source PNGs are never edited.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BUILD = path.join(ROOT, 'build', 'chat-background-presets');
const OUTPUT = path.join(ROOT, 'apps', 'web', 'public', 'backgrounds', 'v1');
const REPORT = path.join(BUILD, 'import-report.json');
const GALLERY = path.join(ROOT, 'docs', 'visual-samples', 'chat-backgrounds.html');
const TARGETS = {
  image: { width: 1600, height: 900, quality: 82, limit: 350_000 },
  thumbnail: { width: 480, height: 270, quality: 70, limit: 45_000 },
};
const SETTINGS = { version: 1, resize: 'cover-centre', effort: 6, targets: TARGETS };
const args = process.argv.slice(2);
let manifestPath = path.join(BUILD, 'source-images.json');
let dryRun = false;
let force = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--manifest' && args[index + 1]) manifestPath = path.resolve(args[++index]);
  else if (arg === '--dry-run') dryRun = true;
  else if (arg === '--force') force = true;
  else if (arg === '--help') {
    console.log('Usage: node tools/art/prepare-chat-backgrounds.mjs [--manifest PATH] [--dry-run] [--force]');
    console.log('Defaults to build/chat-background-presets/source-images.json. Missing PNGs are skipped.');
    process.exit(0);
  } else throw new Error(`Unknown or incomplete option: ${arg}. Use --help for usage.`);
}

function hash(data) {
  return createHash('sha256').update(data).digest('hex');
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );
}

async function readJson(filename, optional = false) {
  try {
    return JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error.code === 'ENOENT') {
      throw new Error(
        `Source manifest not found: ${filename}\nCreate a JSON array of { id, label, source, prompt } with absolute PNG source paths.`,
      );
    }
    throw new Error(`Cannot read JSON ${filename}: ${error.message}`);
  }
}

async function writeAtomic(filename, data) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}`;
  await writeFile(temporary, data);
  await rename(temporary, filename);
}

function validateManifest(manifest) {
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error('Source manifest must be a non-empty array of { id, label, source, prompt }.');
  }
  const ids = new Set();
  for (const [index, entry] of manifest.entries()) {
    if (!entry || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(entry.id ?? '')) {
      throw new Error(`Manifest entry ${index + 1} needs a safe lowercase scene id, e.g. tavern-hearth.`);
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate scene id: ${entry.id}`);
    ids.add(entry.id);
    if (typeof entry.label !== 'string' || !entry.label.trim()) throw new Error(`${entry.id}: label is required.`);
    if (typeof entry.source !== 'string' || !path.isAbsolute(entry.source) || !/\.png$/i.test(entry.source)) {
      throw new Error(`${entry.id}: source must be an absolute PNG path.`);
    }
    if (typeof entry.prompt !== 'string') throw new Error(`${entry.id}: prompt must be a string.`);
  }
}

async function exists(filename) {
  try {
    return (await stat(filename)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function inspect(sharp, filename) {
  if (!(await exists(filename))) return null;
  const data = await readFile(filename);
  let metadata;
  try {
    metadata = await sharp(data).metadata();
  } catch {
    return null;
  }
  return {
    path: path.relative(ROOT, filename).split(path.sep).join('/'),
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    bytes: data.length,
    sha256: hash(data),
  };
}

function validOutput(output, target) {
  return (
    output?.format === 'webp' &&
    output.width === target.width &&
    output.height === target.height &&
    output.bytes < target.limit
  );
}

async function encode(sharp, source, target, filename) {
  // Size reduction only changes WebP encoding quality; resizing always uses
  // a centred cover crop. No overlays, colour changes or compositing are applied.
  let data;
  let quality = target.quality;
  for (; quality >= 40; quality -= 2) {
    data = await sharp(source)
      .resize(target.width, target.height, {
        fit: 'cover',
        position: 'centre',
      })
      .webp({ quality, effort: SETTINGS.effort })
      .toBuffer();
    if (data.length < target.limit) break;
  }
  if (data.length >= target.limit) {
    throw new Error(
      `Cannot fit ${path.basename(filename)} below ${target.limit} bytes; last result ${data.length} bytes.`,
    );
  }
  await writeAtomic(filename, data);
  return { ...(await inspect(sharp, filename)), quality };
}

async function readCatalog() {
  const catalog = await readFile(path.join(ROOT, 'apps', 'web', 'src', 'lib', 'background-presets.ts'), 'utf8');
  const labels = new Map(
    [...catalog.matchAll(/\bgroup\('([^']+)',\s*'([^']+)'/g)].map((match) => [match[1], match[2]]),
  );
  // Scene tuples are literal rows in the catalogue. Keep every generated review
  // artifact in this order, even when the manifest arrives in completion order.
  const ids = [...catalog.matchAll(/^\s*\['([^']+)',\s*'/gm)].map((match) => match[1]);
  if (!labels.size || !ids.length) throw new Error('Cannot read scene order from background-presets.ts.');
  return { labels, order: new Map(ids.map((id, index) => [id, index])) };
}

async function writeContactSheets(sharp, assets, labels) {
  const tileWidth = 480;
  const tileHeight = 312;
  const gap = 12;
  const padding = 20;
  const width = padding * 2 + tileWidth * 3 + gap * 2;
  const perSheet = 18;
  for (let start = 0; start < assets.length; start += perSheet) {
    const batch = assets.slice(start, start + perSheet);
    const height = padding * 2 + Math.ceil(batch.length / 3) * (tileHeight + gap) - gap;
    const layers = [];
    for (const [offset, asset] of batch.entries()) {
      const left = padding + (offset % 3) * (tileWidth + gap);
      const top = padding + Math.floor(offset / 3) * (tileHeight + gap);
      if (asset.thumbnail) {
        layers.push({ input: await readFile(path.join(ROOT, asset.thumbnail.path)), left, top });
      }
      const category = labels.get(asset.id.split('-')[0]) ?? '';
      const text = `${category} · ${asset.label}${asset.thumbnail ? '' : '（待生成）'}`;
      const label = Buffer.from(
        `<svg width="${tileWidth}" height="42"><text x="6" y="28" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="20" fill="#273138">${escapeHtml(text)}</text></svg>`,
      );
      layers.push({ input: label, left, top: top + 270 });
    }
    const sheet = await sharp({ create: { width, height, channels: 3, background: '#e9edf0' } })
      .composite(layers)
      .jpeg({ quality: 90 })
      .toBuffer();
    await writeAtomic(path.join(BUILD, `contact-sheet-${Math.floor(start / perSheet) + 1}.jpg`), sheet);
  }
}

async function writeGallery(assets, labels) {
  const groups = new Map();
  for (const asset of assets) {
    const category = asset.id.split('-')[0];
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(asset);
  }
  const sections = [...groups]
    .map(
      ([category, scenes]) =>
        `<section><h2>${escapeHtml(labels.get(category) ?? category)}</h2><div class="grid">${scenes
          .map((asset) => {
            const url = `/backgrounds/v1/${asset.id}.webp`;
            const content =
              asset.image && asset.thumbnail
                ? `<a href="${url}" target="_blank" rel="noreferrer"><img src="/backgrounds/v1/thumbs/${asset.id}.webp" alt="${escapeHtml(asset.label)}" loading="lazy" width="480" height="270"></a>`
                : '<div class="pending">待生成</div>';
            return `<figure>${content}<figcaption><strong>${escapeHtml(asset.label)}</strong><small>${escapeHtml(asset.id)}</small></figcaption></figure>`;
          })
          .join('')}</div></section>`,
    )
    .join('\n');
  await writeAtomic(
    GALLERY,
    `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>聊天背景审阅</title>
<style>body{margin:0;background:#f2f1ed;color:#272e31;font:16px/1.5 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1480px;margin:auto;padding:32px 24px}h1{font-size:28px;margin:0 0 8px}p{color:#616a70;margin:0 0 30px}h2{font-size:21px;margin:28px 0 12px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}figure{margin:0;background:white;border:1px solid #d9deda;border-radius:10px;overflow:hidden}img,.pending{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:cover}.pending{display:grid;place-items:center;background:#dfe4e7;color:#6b747a}figcaption{padding:12px 14px}small{display:block;color:#788087;font-size:12px;margin-top:3px}@media(max-width:800px){.grid{grid-template-columns:1fr}main{padding:20px 16px}}</style></head>
<body><main><h1>聊天背景审阅 · ${assets.length} 个场景</h1><p>点击缩略图查看 1600 × 900 全图。图片使用同源 /backgrounds/v1 路径；本页仅用于审阅。</p>${sections}</main></body></html>\n`,
  );
}

async function main() {
  const manifest = await readJson(manifestPath);
  validateManifest(manifest);
  const catalog = await readCatalog();
  for (const entry of manifest) {
    if (!catalog.order.has(entry.id)) throw new Error(`Scene id is not in background-presets.ts: ${entry.id}`);
  }
  manifest.sort((left, right) => catalog.order.get(left.id) - catalog.order.get(right.id));
  let sharp;
  try {
    sharp = createRequire(import.meta.url)('sharp');
  } catch {
    throw new Error(
      'sharp is unavailable. Set NODE_PATH to the existing bundled node_modules directory; no package installation is needed.',
    );
  }
  const signature = hash(JSON.stringify({ ...SETTINGS, sharp: sharp.versions.sharp, vips: sharp.versions.vips }));
  const previous = dryRun ? null : await readJson(REPORT, true);
  const cached = new Map((previous?.assets ?? []).map((asset) => [asset.id, asset]));
  const assets = [];
  for (const entry of manifest) {
    const imagePath = path.join(OUTPUT, `${entry.id}.webp`);
    const thumbnailPath = path.join(OUTPUT, 'thumbs', `${entry.id}.webp`);
    const asset = { ...entry, status: 'source-missing', source: { path: entry.source } };
    if (!(await exists(entry.source))) {
      asset.image = await inspect(sharp, imagePath);
      asset.thumbnail = await inspect(sharp, thumbnailPath);
      if (!validOutput(asset.image, TARGETS.image)) asset.image = null;
      if (!validOutput(asset.thumbnail, TARGETS.thumbnail)) asset.thumbnail = null;
      console.log(`PENDING ${entry.id}: source PNG not found: ${entry.source}`);
      assets.push(asset);
      continue;
    }
    const source = await readFile(entry.source);
    const sourceMetadata = await sharp(source).metadata();
    if (sourceMetadata.format !== 'png') throw new Error(`${entry.id}: source file is not a PNG.`);
    asset.source = {
      path: entry.source,
      format: 'png',
      width: sourceMetadata.width,
      height: sourceMetadata.height,
      bytes: source.length,
      sha256: hash(source),
    };
    if (dryRun) {
      asset.status = 'ready';
      console.log(`READY ${entry.id}: ${sourceMetadata.width}x${sourceMetadata.height}, ${source.length} bytes`);
      assets.push(asset);
      continue;
    }
    const old = cached.get(entry.id);
    const currentImage = await inspect(sharp, imagePath);
    const currentThumbnail = await inspect(sharp, thumbnailPath);
    const unchanged =
      !force &&
      previous?.signature === signature &&
      old?.source.sha256 === asset.source.sha256 &&
      validOutput(currentImage, TARGETS.image) &&
      validOutput(currentThumbnail, TARGETS.thumbnail) &&
      old.image?.sha256 === currentImage.sha256 &&
      old.thumbnail?.sha256 === currentThumbnail.sha256;
    asset.image = unchanged
      ? { ...currentImage, quality: old.image.quality }
      : await encode(sharp, source, TARGETS.image, imagePath);
    asset.thumbnail = unchanged
      ? { ...currentThumbnail, quality: old.thumbnail.quality }
      : await encode(sharp, source, TARGETS.thumbnail, thumbnailPath);
    asset.status = unchanged ? 'unchanged' : 'imported';
    console.log(
      `${asset.status.toUpperCase()} ${entry.id}: image ${asset.image.bytes} B (q${asset.image.quality}), thumb ${asset.thumbnail.bytes} B (q${asset.thumbnail.quality})`,
    );
    assets.push(asset);
  }
  const summary = {
    total: assets.length,
    imported: assets.filter((asset) => asset.status === 'imported').length,
    unchanged: assets.filter((asset) => asset.status === 'unchanged').length,
    ready: assets.filter((asset) => asset.status === 'ready').length,
    missingSources: assets.filter((asset) => asset.status === 'source-missing').length,
    imageBytes: assets.reduce((total, asset) => total + (asset.image?.bytes ?? 0), 0),
    thumbnailBytes: assets.reduce((total, asset) => total + (asset.thumbnail?.bytes ?? 0), 0),
  };
  if (!dryRun) {
    const labels = catalog.labels;
    await writeContactSheets(sharp, assets, labels);
    await writeGallery(assets, labels);
    await writeAtomic(
      REPORT,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), manifest: manifestPath, signature, settings: SETTINGS, encoder: sharp.versions, summary, assets }, null, 2)}\n`,
    );
  }
  console.log(`${dryRun ? 'Dry run' : 'Import'} summary: ${JSON.stringify(summary)}`);
  if (!dryRun) console.log(`Metadata and SHA-256 report: ${REPORT}`);
}

main().catch((error) => {
  console.error(`Background import failed: ${error.message}`);
  process.exitCode = 1;
});
