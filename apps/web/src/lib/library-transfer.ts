import {
  type Card,
  type CardSource,
  newId,
  nowIso,
  type Persona,
  stripRemovedCardFields,
  type WorldBook,
  type WorldBookEntry,
} from '@dramatis/core';

export type LibraryItemKind = 'personas' | 'cards' | 'worldbooks';
export type NativeLibraryItem =
  | { kind: 'personas'; item: Persona }
  | { kind: 'cards'; item: Card }
  | { kind: 'worldbooks'; item: WorldBook };

function invalid(field: string): never {
  throw new Error(`原生素材文件字段无效：${field}`);
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(field);
  return value;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field);
  return value;
}
function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(field);
  return value;
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) invalid(field);
  return value.map((item) => text(item, field));
}
function jsonValue(value: unknown, field: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return number(value, field);
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, field));
  return Object.fromEntries(Object.entries(record(value, field)).map(([key, item]) => [key, jsonValue(item, field)]));
}
function extensions(value: unknown): Record<string, unknown> {
  return jsonValue(record(value, 'extensions'), 'extensions') as Record<string, unknown>;
}
function entry(value: unknown): WorldBookEntry {
  const item = record(value, 'entries');
  text(item.id, 'entries.id');
  const position = text(item.position, 'position');
  if (!['before_char', 'after_char', 'before_an', 'after_an', 'at_depth', 'unknown'].includes(position))
    invalid('position');
  const selectiveLogic = number(item.selectiveLogic, 'selectiveLogic');
  if (![0, 1, 2, 3].includes(selectiveLogic)) invalid('selectiveLogic');
  const probability = number(item.probability, 'probability');
  if (probability < 0 || probability > 100) invalid('probability');
  return {
    id: newId(),
    title: text(item.title, 'title'),
    keys: strings(item.keys, 'keys'),
    secondaryKeys: strings(item.secondaryKeys, 'secondaryKeys'),
    content: text(item.content, 'content'),
    constant: boolean(item.constant, 'constant'),
    selective: boolean(item.selective, 'selective'),
    selectiveLogic: selectiveLogic as WorldBookEntry['selectiveLogic'],
    order: number(item.order, 'order'),
    position: position as WorldBookEntry['position'],
    depth: number(item.depth, 'depth'),
    probability,
    useProbability: boolean(item.useProbability, 'useProbability'),
    disabled: boolean(item.disabled, 'disabled'),
    caseSensitive: boolean(item.caseSensitive, 'caseSensitive'),
    matchWholeWords: boolean(item.matchWholeWords, 'matchWholeWords'),
    scanDepth: item.scanDepth === null ? null : number(item.scanDepth, 'scanDepth'),
    preventRecursion: boolean(item.preventRecursion, 'preventRecursion'),
    excludeRecursion: boolean(item.excludeRecursion, 'excludeRecursion'),
    group: text(item.group, 'group'),
    extensions: extensions(item.extensions),
  };
}
function material(kind: LibraryItemKind, value: unknown): NativeLibraryItem {
  const raw = record(value, 'data');
  const data = stripRemovedCardFields(raw) ?? raw;
  text(data.id, 'id');
  text(data.createdAt, 'createdAt');
  text(data.updatedAt, 'updatedAt');
  if (data.deletedAt !== null) text(data.deletedAt, 'deletedAt');
  const now = nowIso();
  const base = { id: newId(), name: text(data.name, 'name'), createdAt: now, updatedAt: now, deletedAt: null };
  if (kind === 'personas') return { kind, item: { ...base, description: text(data.description, 'description') } };
  if (kind === 'worldbooks') {
    if (!Array.isArray(data.entries)) invalid('entries');
    return {
      kind,
      item: {
        ...base,
        id: base.id as WorldBook['id'],
        entries: data.entries.map(entry),
        extensions: extensions(data.extensions),
      },
    };
  }
  const source = record(data.source, 'source');
  const sourceKind = text(source.kind, 'source.kind');
  text(source.importedAt, 'source.importedAt');
  if (!['png', 'json', 'manual'].includes(sourceKind)) invalid('source.kind');
  const embeddedWorldBook =
    data.embeddedWorldBook === null
      ? null
      : jsonValue(record(data.embeddedWorldBook, 'embeddedWorldBook'), 'embeddedWorldBook');
  return {
    kind,
    item: {
      ...base,
      id: base.id as Card['id'],
      nickname: text(data.nickname, 'nickname'),
      description: text(data.description, 'description'),
      personality: text(data.personality, 'personality'),
      creator: text(data.creator, 'creator'),
      characterVersion: text(data.characterVersion, 'characterVersion'),
      tags: strings(data.tags, 'tags'),
      extensions: extensions(data.extensions),
      embeddedWorldBook,
      source: {
        kind: sourceKind as CardSource['kind'],
        ...(source.fileName === undefined ? {} : { fileName: text(source.fileName, 'source.fileName') }),
        spec: text(source.spec, 'source.spec'),
        specVersion: text(source.specVersion, 'source.specVersion'),
        importedAt: now,
      },
    },
  };
}

/** Copies only the library entity's fields, never a session or account envelope. */
export function serializeLibraryItem(kind: LibraryItemKind, item: Persona | Card | WorldBook): string {
  const cleaned = material(kind, item).item;
  const data = {
    ...cleaned,
    id: item.id,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    deletedAt: item.deletedAt,
  };
  if (kind === 'worldbooks' && 'entries' in data && 'entries' in item)
    data.entries = data.entries.map((entry, index) => ({ ...entry, id: item.entries[index]?.id ?? entry.id }));
  if (kind === 'cards' && 'source' in data && 'source' in item)
    data.source = { ...data.source, importedAt: item.source.importedAt };
  return JSON.stringify({ format: 'dramatis-library', version: 1, kind, data }, null, 2);
}

export function parseNativeLibraryFile(value: unknown): NativeLibraryItem | null {
  if (typeof value !== 'object' || value === null || !('format' in value) || value.format !== 'dramatis-library')
    return null;
  const envelope = record(value, 'file');
  if (envelope.version !== 1) throw new Error('不支持的原生素材文件版本');
  if (envelope.kind !== 'personas' && envelope.kind !== 'cards' && envelope.kind !== 'worldbooks') invalid('kind');
  return material(envelope.kind, envelope.data);
}
