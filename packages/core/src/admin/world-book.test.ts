import { describe, expect, it } from 'vitest';
import { createBlankWorldBook, createWorldBookEntry } from '../model/card.js';
import type { AdminArtifact } from '../model/message.js';
import {
  diffWorldBook,
  isModifiedWorldBookArtifact,
  reverseWorldBookDraft,
  worldBookArtifactConflict,
} from './world-book.js';

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Fixture value missing');
  return value;
}

const before = {
  ...createBlankWorldBook('旧名'),
  entries: [
    { ...createWorldBookEntry({ content: '一', constant: true }), id: 'e1' },
    { ...createWorldBookEntry({ content: '二', constant: true }), id: 'e2' },
    { ...createWorldBookEntry({ content: '三', constant: true }), id: 'e3' },
  ],
};
const after = {
  ...before,
  name: '新名',
  entries: [
    required(before.entries[0]),
    { ...required(before.entries[1]), content: '改二' },
    { ...createWorldBookEntry({ constant: true, content: '四' }), id: 'e4' },
  ],
};
const artifact: AdminArtifact = {
  id: 'a',
  kind: 'world-book',
  title: '新名',
  summary: '修改',
  status: 'adopted',
  targetId: before.id,
  payload: after,
  previousPayload: before,
  baseUpdatedAt: before.updatedAt,
  createdAt: before.createdAt,
};

describe('world book review and reverse draft', () => {
  it('shows concrete name, field, added and deleted values', () => {
    expect(diffWorldBook(before, after)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'field', field: 'name', before: '旧名', after: '新名' }),
        expect.objectContaining({ kind: 'field', entryId: 'e2', field: 'content', before: '二', after: '改二' }),
        expect.objectContaining({ kind: 'add', entryId: 'e4' }),
        expect.objectContaining({ kind: 'delete', entryId: 'e3' }),
      ]),
    );
  });
  it('reverses only affected fields and entries on a fresh base', () => {
    const current = {
      ...after,
      updatedAt: 'later',
      entries: [
        { ...required(after.entries[0]), content: '用户一' },
        { ...required(after.entries[1]), title: '用户标题' },
        required(after.entries[2]),
      ],
    };
    const draft = reverseWorldBookDraft(artifact, current);
    expect(draft.book.name).toBe('旧名');
    expect(draft.book.entries.map((e) => [e.id, e.content, e.title])).toEqual([
      ['e1', '用户一', '新条目'],
      ['e2', '二', '用户标题'],
      ['e3', '三', '新条目'],
    ]);
    expect(draft.previous).toEqual(current);
    expect(draft.baseUpdatedAt).toBe('later');
  });
  it.each(['field', 'added', 'deleted', 'name'])('rejects later edits touching %s', (kind) => {
    const current = structuredClone(after);
    if (kind === 'field') required(current.entries[1]).content = '用户二';
    if (kind === 'added') required(current.entries[2]).content = '用户四';
    if (kind === 'deleted') current.entries.push(required(before.entries[2]));
    if (kind === 'name') current.name = '用户书名';
    expect(() => reverseWorldBookDraft(artifact, current)).toThrow();
  });
  it('blocks legacy modifications and stale versions without blocking new drafts', () => {
    expect(
      worldBookArtifactConflict({ ...artifact, previousPayload: undefined } as unknown as AdminArtifact, before),
    ).toContain('重新起草');
    expect(worldBookArtifactConflict(artifact, { ...before, updatedAt: 'later' })).toBeTruthy();
    expect(
      worldBookArtifactConflict(
        { ...artifact, previousPayload: null, baseUpdatedAt: null, targetId: null, status: 'pending' },
        null,
      ),
    ).toBeNull();
    expect(isModifiedWorldBookArtifact(artifact)).toBe(true);
    expect(isModifiedWorldBookArtifact({ ...artifact, previousPayload: null, baseUpdatedAt: null })).toBe(false);
  });
  it('does not resurrect a legacy modification lacking before and baseline as a new book', () => {
    const { previousPayload: _previous, ...legacy } = artifact;
    const incomplete = { ...legacy, baseUpdatedAt: null, summary: '修改世界书「旧名」' };
    expect(worldBookArtifactConflict(incomplete, null)).toContain('重新起草');
    expect(isModifiedWorldBookArtifact(incomplete)).toBe(true);
    const creation = { ...incomplete, summary: '新建世界书「旧名」' };
    expect(worldBookArtifactConflict(creation, null)).toBeNull();
    expect(isModifiedWorldBookArtifact(creation)).toBe(false);
  });
  it.each(['pending', 'adopted'] as const)('recognizes early creation without markers (%s)', (status) => {
    // f5065ba^ generated this shape: both previousPayload and baseUpdatedAt were absent.
    const legacy: AdminArtifact = {
      id: 'legacy-create',
      kind: 'world-book',
      title: '旧名',
      summary: '新建世界书「旧名」（3 条）',
      status,
      targetId: status === 'adopted' ? before.id : null,
      payload: before,
      createdAt: before.createdAt,
    };
    expect(isModifiedWorldBookArtifact(legacy)).toBe(false);
    expect(worldBookArtifactConflict(legacy, null)).toBeNull();
    expect(worldBookArtifactConflict(legacy, before)).toContain('已存在');
  });
  it.each(['pending', 'adopted'] as const)('still blocks early modifications and unknown provenance (%s)', (status) => {
    const legacy: AdminArtifact = {
      id: 'legacy-modify',
      kind: 'world-book',
      title: '旧名',
      summary: '修改世界书「旧名」（3 条）',
      status,
      targetId: status === 'adopted' ? before.id : null,
      payload: before,
      createdAt: before.createdAt,
    };
    for (const draft of [legacy, { ...legacy, summary: '来源不明的世界书' }]) {
      expect(isModifiedWorldBookArtifact(draft)).toBe(true);
      expect(worldBookArtifactConflict(draft, null)).toContain('重新起草');
      expect(worldBookArtifactConflict(draft, before)).toContain('重新起草');
    }
  });
});
