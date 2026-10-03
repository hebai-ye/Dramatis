import { createBlankCard, createBlankWorldBook, createPersona, createWorldBookEntry } from '@dramatis/core';
import { describe, expect, it } from 'vitest';
import { countAttachedIds, filterCards, filterPersonas, filterWorldBooks } from './library-query';

describe('library queries', () => {
  it('normalizes query, sorts a copy stably, and returns empty for no match', () => {
    const a = { ...createPersona({ name: 'Beta', description: 'Scholar' }), updatedAt: '2026-01-01' };
    const b = { ...createPersona({ name: 'Alpha' }), updatedAt: '2026-02-01' };
    const c = { ...createPersona({ name: 'Alpha' }), updatedAt: '2026-03-01' };
    const items = [a, b, c];
    expect(filterPersonas(items, '', 'name')).toEqual([b, c, a]);
    expect(filterPersonas(items, '  SCHOLAR ', 'updated')).toEqual([a]);
    expect(filterPersonas(items, '', 'updated')).toEqual([c, b, a]);
    expect(filterPersonas(items, 'missing', 'name')).toEqual([]);
    expect(items).toEqual([a, b, c]);
  });
  it.each(['name', 'nickname', 'creator', 'description', 'personality', 'tags'] as const)(
    'searches card %s',
    (field) => {
      const card = createBlankCard({ [field]: field === 'tags' ? ['needle'] : 'needle' });
      expect(filterCards([card], ' NEEDLE ', 'name')).toEqual([card]);
    },
  );
  it.each(['title', 'keys', 'content'] as const)('searches book entry %s', (field) => {
    const book = {
      ...createBlankWorldBook('Book'),
      entries: [{ ...createWorldBookEntry(), [field]: field === 'keys' ? ['needle'] : 'needle' }],
    };
    expect(filterWorldBooks([book], ' NEEDLE ', 'updated')).toEqual([book]);
    expect(filterWorldBooks([book], 'book', 'name')).toEqual([book]);
  });
  it('counts only unique live attachment IDs', () => {
    expect(countAttachedIds(['a', 'a', 'missing', 'b'], [{ id: 'a' }, { id: 'c' }])).toBe(1);
    expect(countAttachedIds([], [{ id: 'a' }])).toBe(0);
  });
});
