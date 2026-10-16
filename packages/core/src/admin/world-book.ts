import type { WorldBook } from '../model/card.js';
import type { AdminArtifact } from '../model/message.js';
import type { WorldBookDraft } from './tools.js';

/** Require the persisted entity, including advanced entry fields, before merging. */
export function isCompleteWorldBook(value: unknown): value is WorldBook {
  if (value === null || typeof value !== 'object') return false;
  const book = value as WorldBook;
  if (
    typeof book.id !== 'string' ||
    !book.id ||
    typeof book.name !== 'string' ||
    !book.updatedAt ||
    typeof book.updatedAt !== 'string' ||
    typeof book.createdAt !== 'string' ||
    book.deletedAt !== null ||
    book.extensions === null ||
    typeof book.extensions !== 'object' ||
    !Array.isArray(book.entries)
  )
    return false;
  const ids = new Set<string>();
  return book.entries.every((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id))
      return false;
    ids.add(entry.id);
    return (
      ['title', 'content', 'position', 'group'].every((key) => typeof entry[key as keyof typeof entry] === 'string') &&
      [
        'constant',
        'selective',
        'useProbability',
        'disabled',
        'caseSensitive',
        'matchWholeWords',
        'preventRecursion',
        'excludeRecursion',
      ].every((key) => typeof entry[key as keyof typeof entry] === 'boolean') &&
      ['order', 'depth', 'probability', 'selectiveLogic'].every(
        (key) =>
          typeof entry[key as keyof typeof entry] === 'number' && Number.isFinite(entry[key as keyof typeof entry]),
      ) &&
      (entry.scanDepth === null || (typeof entry.scanDepth === 'number' && Number.isFinite(entry.scanDepth))) &&
      Array.isArray(entry.keys) &&
      entry.keys.every((key) => typeof key === 'string') &&
      Array.isArray(entry.secondaryKeys) &&
      entry.secondaryKeys.every((key) => typeof key === 'string') &&
      entry.extensions !== null &&
      typeof entry.extensions === 'object'
    );
  });
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equal(value, right[index]))
    );
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

export interface WorldBookChange {
  kind: 'add' | 'delete' | 'field';
  entryId?: string;
  field?: string;
  before: unknown;
  after: unknown;
}

export function diffWorldBook(before: WorldBook | null, after: WorldBook): WorldBookChange[] {
  const changes: WorldBookChange[] = [];
  if (before?.name !== after.name)
    changes.push({ kind: 'field', field: 'name', before: before?.name ?? null, after: after.name });
  const originals = new Map((before?.entries ?? []).map((entry) => [entry.id, entry]));
  for (const entry of after.entries) {
    const old = originals.get(entry.id);
    if (!old) changes.push({ kind: 'add', entryId: entry.id, before: null, after: entry });
    else
      for (const field of new Set([...Object.keys(old), ...Object.keys(entry)])) {
        const key = field as keyof typeof entry;
        if (!equal(old[key], entry[key]))
          changes.push({ kind: 'field', entryId: entry.id, field, before: old[key], after: entry[key] });
      }
  }
  for (const old of before?.entries ?? [])
    if (!after.entries.some((entry) => entry.id === old.id))
      changes.push({ kind: 'delete', entryId: old.id, before: old, after: null });
  return changes;
}

/** Explicit null marks new drafts. Legacy creation summaries identify pre-before new drafts. */
export function isModifiedWorldBookArtifact(artifact: AdminArtifact): boolean {
  return (
    artifact.kind === 'world-book' &&
    !(
      artifact.previousPayload == null &&
      artifact.baseUpdatedAt == null &&
      ((artifact.previousPayload === null && artifact.baseUpdatedAt === null) ||
        artifact.summary.startsWith('新建世界书'))
    )
  );
}

export function worldBookArtifactConflict(artifact: AdminArtifact, current: WorldBook | null): string | null {
  if (artifact.kind !== 'world-book') return null;
  if (!isCompleteWorldBook(artifact.payload)) return '世界书草稿不完整，请重新起草';
  const previous = artifact.previousPayload;
  if (previous == null && artifact.baseUpdatedAt == null && !isModifiedWorldBookArtifact(artifact))
    return current === null ? null : '原本新建的世界书已存在，请重新起草';
  if (
    !isCompleteWorldBook(previous) ||
    !artifact.baseUpdatedAt ||
    previous.updatedAt !== artifact.baseUpdatedAt ||
    previous.id !== artifact.payload.id
  )
    return '缺少可信原书和基版本，请重新起草';
  if (current === null || current.deletedAt !== null) return '原世界书已不存在，请重新起草';
  return current.updatedAt !== artifact.baseUpdatedAt ? '世界书版本已变化，请重新起草' : null;
}

/** Invert only this adoption's delta. Current unrelated fields and ordering stay intact. */
export function reverseWorldBookDraft(artifact: AdminArtifact, current: WorldBook): WorldBookDraft {
  const before = artifact.previousPayload;
  const after = artifact.payload;
  if (
    artifact.kind !== 'world-book' ||
    artifact.status !== 'adopted' ||
    !isCompleteWorldBook(before) ||
    !isCompleteWorldBook(after) ||
    !isCompleteWorldBook(current) ||
    current.deletedAt !== null ||
    before.id !== after.id ||
    after.id !== current.id ||
    artifact.targetId !== current.id ||
    artifact.baseUpdatedAt !== before.updatedAt
  )
    throw Error('缺少可信 before/after，请重新起草');
  // Our merge never reorders surviving entries. Reject legacy replacements that did.
  const commonBefore = before.entries.filter((e) => after.entries.some((a) => a.id === e.id)).map((e) => e.id);
  const commonAfter = after.entries.filter((e) => before.entries.some((a) => a.id === e.id)).map((e) => e.id);
  if (!equal(commonBefore, commonAfter)) throw Error('原草稿调整过条目顺序，请重新起草');
  const changes = diffWorldBook(before, after);
  const book = structuredClone(current);
  for (const change of changes) {
    const entry = book.entries.find((e) => e.id === change.entryId);
    if (change.kind === 'add') {
      if (!equal(entry, change.after)) throw Error('原新增条目已被修改，不能反向修改');
      book.entries = book.entries.filter((e) => e.id !== change.entryId);
    } else if (change.kind === 'delete') {
      if (entry) throw Error('原删除条目已被重建，不能反向修改');
    } else if (change.entryId === undefined) {
      if (!equal(book.name, change.after)) throw Error('书名已被修改，不能反向修改');
      book.name = before.name;
    } else {
      if (!entry || !change.field || !equal(entry[change.field as keyof typeof entry], change.after))
        throw Error('原变更字段已被修改，不能反向修改');
      const record = entry as unknown as Record<string, unknown>;
      if (change.before === undefined) delete record[change.field];
      else record[change.field] = structuredClone(change.before);
    }
  }
  // Restore deletions beside their next surviving original neighbor, without reordering current entries.
  for (let index = before.entries.length - 1; index >= 0; index--) {
    const entry = before.entries[index];
    if (!entry || !changes.some((change) => change.kind === 'delete' && change.entryId === entry.id)) continue;
    const nextId = before.entries.slice(index + 1).find((next) => book.entries.some((e) => e.id === next.id))?.id;
    const position = nextId === undefined ? book.entries.length : book.entries.findIndex((e) => e.id === nextId);
    book.entries.splice(position, 0, structuredClone(entry));
  }
  return {
    kind: 'world-book',
    bookId: current.id,
    book,
    previous: structuredClone(current),
    baseUpdatedAt: current.updatedAt,
    summary: `反向修改世界书「${current.name}」`,
  };
}
