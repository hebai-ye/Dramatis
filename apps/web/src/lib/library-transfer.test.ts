import { createBlankCard, createBlankWorldBook, createPersona, createWorldBookEntry } from '@dramatis/core';
import { describe, expect, it } from 'vitest';
import { parseNativeLibraryFile, serializeLibraryItem } from './library-transfer';

const oldTime = '2000-01-01T00:00:00.000Z';
function data() {
  const persona = {
    ...createPersona({ name: 'Same', description: 'Identity' }),
    createdAt: oldTime,
    updatedAt: oldTime,
    deletedAt: oldTime,
  };
  const card = createBlankCard({
    name: 'Same',
    nickname: 'Nick',
    description: 'Desc',
    personality: 'Bold',
    creator: 'Author',
    characterVersion: '2',
    tags: ['tag'],
    extensions: { avatar: 'data:image/png;base64,abc', nested: { enabled: true } },
    embeddedWorldBook: { entries: [{ keys: ['key'], content: 'lore' }] },
    createdAt: oldTime,
    updatedAt: oldTime,
    deletedAt: oldTime,
  });
  const book = {
    ...createBlankWorldBook('Same'),
    createdAt: oldTime,
    updatedAt: oldTime,
    deletedAt: oldTime,
    extensions: { custom: 1 },
    entries: [
      {
        ...createWorldBookEntry(),
        title: 'Entry',
        keys: ['A'],
        secondaryKeys: ['B'],
        content: 'Lore',
        constant: true,
        selective: false,
        selectiveLogic: 3 as const,
        order: 9,
        position: 'at_depth' as const,
        depth: 7,
        probability: 42,
        useProbability: false,
        disabled: true,
        caseSensitive: true,
        matchWholeWords: true,
        scanDepth: 12,
        preventRecursion: false,
        excludeRecursion: true,
        group: 'g',
        extensions: { custom: ['x'] },
      },
    ],
  };
  return { personas: persona, cards: card, worldbooks: book };
}

describe('native library exchange', () => {
  it.each(['personas', 'cards', 'worldbooks'] as const)(
    'round trips %s fields with new identity, timestamps and no tombstone',
    (kind) => {
      const source = data()[kind];
      const withPrivateFields = { ...source, messages: ['private'], account: { secret: 'private' } };
      const serialized = JSON.parse(serializeLibraryItem(kind, withPrivateFields));
      expect(serialized).toMatchObject({ format: 'dramatis-library', version: 1, kind });
      expect(serialized.data).not.toHaveProperty('messages');
      expect(serialized.data).not.toHaveProperty('account');
      const first = parseNativeLibraryFile(serialized);
      const second = parseNativeLibraryFile(serialized);
      expect(first?.kind).toBe(kind);
      expect(first?.item.name).toBe('Same');
      expect(first?.item.id).not.toBe(source.id);
      expect(second?.item.id).not.toBe(first?.item.id);
      expect(first?.item.createdAt).not.toBe(oldTime);
      expect(first?.item.updatedAt).not.toBe(oldTime);
      expect(first?.item.deletedAt).toBeNull();
      if (first?.kind === 'cards')
        expect(first.item).toMatchObject({
          nickname: 'Nick',
          characterVersion: '2',
          extensions: data().cards.extensions,
          embeddedWorldBook: data().cards.embeddedWorldBook,
        });
      if (first?.kind === 'worldbooks') {
        expect({ ...first.item.entries[0], id: serialized.data.entries[0].id }).toEqual(serialized.data.entries[0]);
        expect(first.item.entries[0]?.id).not.toBe(serialized.data.entries[0].id);
        expect(first.item.entries[0]).toMatchObject({
          title: 'Entry',
          secondaryKeys: ['B'],
          selectiveLogic: 3,
          probability: 42,
          position: 'at_depth',
          scanDepth: 12,
          group: 'g',
          extensions: { custom: ['x'] },
        });
      }
    },
  );
  it('returns null only for non-native data', () => {
    expect(parseNativeLibraryFile({ name: 'ST' })).toBeNull();
    expect(parseNativeLibraryFile(null)).toBeNull();
    for (const patch of [{ version: 2 }, { kind: 'session' }, { data: null }]) {
      expect(() =>
        parseNativeLibraryFile({
          format: 'dramatis-library',
          version: 1,
          kind: 'personas',
          data: data().personas,
          ...patch,
        }),
      ).toThrow();
    }
  });
  it.each([
    { order: Infinity },
    { probability: NaN },
    { depth: '4' },
    { scanDepth: false },
    { position: 'wrong' },
    { selectiveLogic: 8 },
    { constant: 1 },
    { keys: ['a', 1] },
    { extensions: [] },
  ])('rejects malformed entry %j', (patch) => {
    const book = data().worldbooks;
    expect(() =>
      parseNativeLibraryFile({
        format: 'dramatis-library',
        version: 1,
        kind: 'worldbooks',
        data: { ...book, entries: [{ ...book.entries[0], ...patch }] },
      }),
    ).toThrow();
  });
  it('validates card fields and strips removed legacy fields', () => {
    const card = data().cards;
    const result = parseNativeLibraryFile({
      format: 'dramatis-library',
      version: 1,
      kind: 'cards',
      data: { ...card, scenario: 'old', systemPrompt: 'old' },
    });
    expect(result?.item).not.toHaveProperty('scenario');
    expect(result?.item).not.toHaveProperty('systemPrompt');
    expect(() =>
      parseNativeLibraryFile({
        format: 'dramatis-library',
        version: 1,
        kind: 'cards',
        data: { ...card, nickname: false },
      }),
    ).toThrow();
  });
  it.each([{ id: 3 }, { createdAt: false }, { updatedAt: null }, { deletedAt: 1 }])(
    'rejects malformed native metadata %j',
    (patch) => {
      expect(() =>
        parseNativeLibraryFile({
          format: 'dramatis-library',
          version: 1,
          kind: 'personas',
          data: { ...data().personas, ...patch },
        }),
      ).toThrow();
    },
  );
  it('rejects malformed source metadata', () => {
    const card = data().cards;
    expect(() =>
      parseNativeLibraryFile({
        format: 'dramatis-library',
        version: 1,
        kind: 'cards',
        data: { ...card, source: { ...card.source, importedAt: 3 } },
      }),
    ).toThrow();
  });
});
