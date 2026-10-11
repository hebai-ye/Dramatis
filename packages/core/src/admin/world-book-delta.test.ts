import { describe, expect, it } from 'vitest';
import { createBlankWorldBook, createWorldBookEntry } from '../model/card.js';
import { parseAdminToolCall } from './tools.js';

const base = {
  ...createBlankWorldBook('城'),
  entries: [
    { ...createWorldBookEntry({ title: '同名', content: '旧一', constant: true }), id: 'e1' },
    {
      ...createWorldBookEntry({ title: '同名', content: '旧二', constant: true }),
      id: 'e2',
      probability: 37,
      extensions: { custom: 'keep' },
    },
    { ...createWorldBookEntry({ title: '三', content: '旧三', constant: true }), id: 'e3' },
  ],
};
const parse = (args: object, books = [base]) =>
  parseAdminToolCall(
    { id: 'call', type: 'function', function: { name: 'upsert_world_book', arguments: JSON.stringify(args) } },
    { worldBooks: books },
  );

describe('world book entry deltas', () => {
  it('merges by entry ID and retains omitted entries and advanced fields', () => {
    const result = parse({ bookId: base.id, entries: [{ entryId: 'e2', title: '改名' }] });
    expect(result.ok).toBe(true);
    if (!result.ok || result.draft.kind !== 'world-book') throw Error('draft');
    expect(result.draft.book.entries.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    expect(result.draft.book.entries[1]).toMatchObject({
      title: '改名',
      content: '旧二',
      probability: 37,
      extensions: { custom: 'keep' },
    });
    expect(result.draft).toMatchObject({ previous: base, baseUpdatedAt: base.updatedAt });
  });
  it('deletes only explicit IDs', () => {
    const result = parse({ bookId: base.id, entries: [], deleteEntryIds: ['e3'] });
    expect(result.ok).toBe(true);
    if (!result.ok || result.draft.kind !== 'world-book') throw Error('draft');
    expect(result.draft.book.entries.map((e) => e.id)).toEqual(['e1', 'e2']);
  });
  it.each([
    {
      entries: [
        { entryId: 'e2', content: 'a', constant: true },
        { entryId: 'e2', content: 'b', constant: true },
      ],
    },
    { entries: [{ entryId: 'missing', content: 'a', constant: true }] },
    { entries: [], deleteEntryIds: ['e3', 'e3'] },
    { entries: [], deleteEntryIds: ['missing'] },
    { entries: [{ entryId: 'e2', content: 'a', constant: true }], deleteEntryIds: ['e2'] },
  ])('rejects ambiguous or unknown operations: %j', (args) => {
    expect(parse({ name: '城', bookId: base.id, ...args }).ok).toBe(false);
  });
  it('requires a full base even when IDs are known', () => {
    expect(parse({ name: '城', bookId: base.id, entries: [] }, []).ok).toBe(false);
  });
  it('rejects an incomplete advanced-field baseline and malformed IDs', () => {
    const incomplete = structuredClone(base);
    delete (incomplete.entries[0] as Partial<(typeof incomplete.entries)[0]>).disabled;
    expect(parse({ bookId: base.id, entries: [] }, [incomplete]).ok).toBe(false);
    expect(parse({ bookId: base.id, entries: [{ entryId: 7, content: '不应新增', constant: true }] }).ok).toBe(false);
  });
});
