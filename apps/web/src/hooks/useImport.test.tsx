import {
  type Card,
  createBlankCard,
  createBlankWorldBook,
  createMemoryEntityStore,
  createPersona,
  Repository,
  type WorldBook,
} from '@dramatis/core';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { crc32 } from '../../../../packages/core/src/compat/sillytavern/png';
import { serializeLibraryItem } from '../lib/library-transfer';
import type { SessionApi } from '../lib/session';
import { useImport } from './useImport';

function setup(world: SessionApi['world'] = null) {
  const repository = new Repository(createMemoryEntityStore());
  const navigation: string[] = [];
  const attached: WorldBook[] = [];
  let error: string | null = null;
  let warnings: unknown[] = [];
  const session = {
    world,
    saveCard: (card: Card) => repository.saveCard(card),
    saveWorldBook: (book: WorldBook) => repository.saveWorldBook(book),
    savePersona: (persona: ReturnType<typeof createPersona>) => repository.savePersona(persona),
    createWorld: async () => {
      navigation.push('world');
    },
    attachWorldBook: async (book: WorldBook) => {
      attached.push(book);
    },
  } as unknown as SessionApi;
  let api: ReturnType<typeof useImport> | undefined;
  function Harness() {
    api = useImport({
      session,
      activePersona: null,
      setError: (value) => {
        error = value;
      },
      setWarnings: (value) => {
        warnings = value;
      },
      onImported: () => {
        navigation.push('imported');
      },
    });
    return null;
  }
  renderToString(createElement(Harness));
  if (!api) throw new Error('hook missing');
  return { api, repository, navigation, attached, error: () => error, warnings: () => warnings };
}
function json(value: unknown) {
  return new File([typeof value === 'string' ? value : JSON.stringify(value)], 'material.json');
}
const st = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'ST Character',
    description: 'desc',
    personality: 'bold',
    custom_unknown: true,
    character_book: { entries: [{ keys: ['key'], content: 'lore', enabled: true }] },
  },
};
function pngFile() {
  function chunk(type: string, payload: Uint8Array) {
    const bytes = new Uint8Array(payload.length + 12);
    new DataView(bytes.buffer).setUint32(0, payload.length);
    bytes.set(new TextEncoder().encode(type), 4);
    bytes.set(payload, 8);
    new DataView(bytes.buffer).setUint32(bytes.length - 4, crc32(bytes.subarray(4, bytes.length - 4)));
    return bytes;
  }
  const text = chunk('tEXt', new TextEncoder().encode(`chara\0${btoa(JSON.stringify(st))}`));
  const end = chunk('IEND', new Uint8Array());
  return new File(
    [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), new Uint8Array(text), new Uint8Array(end)],
    'card.png',
  );
}

describe('library import mode', () => {
  it.each(['personas', 'cards', 'worldbooks'] as const)(
    'saves native %s without a world or navigation',
    async (kind) => {
      const h = setup();
      const item = {
        personas: createPersona({ name: 'Native' }),
        cards: createBlankCard({ name: 'Native' }),
        worldbooks: createBlankWorldBook('Native'),
      }[kind];
      const result = await h.api.handleImport(json(serializeLibraryItem(kind, item)), 'library');
      expect(result).toMatchObject({ ok: true, kind });
      const list =
        kind === 'personas'
          ? await h.repository.listPersonas()
          : kind === 'cards'
            ? await h.repository.listCards()
            : await h.repository.listWorldBooks();
      expect(list).toHaveLength(1);
      expect(list[0]?.id).not.toBe(item.id);
      expect(h.navigation).toEqual([]);
      expect(h.attached).toEqual([]);
    },
  );
  it.each([null, { id: 'side-world' } as SessionApi['world']])(
    'imports ST cards and embedded books without touching active conversation %j',
    async (world) => {
      const h = setup(world);
      expect(await h.api.handleImport(json(st), 'library')).toMatchObject({ ok: true, kind: 'cards' });
      expect(await h.repository.listCards()).toHaveLength(1);
      expect(await h.repository.listWorldBooks()).toHaveLength(1);
      expect(h.navigation).toEqual([]);
      expect(h.attached).toEqual([]);
      expect(h.warnings().length).toBeGreaterThan(0);
    },
  );
  it('keeps PNG compatibility and conversation default auto-creation/attachment', async () => {
    const h = setup();
    expect(await h.api.handleImport(pngFile())).toMatchObject({ ok: true, kind: 'cards' });
    expect(h.navigation).toEqual(['world', 'imported']);
    expect(h.attached).toHaveLength(1);
    expect((await h.repository.listCards())[0]?.source.kind).toBe('png');
  });
  it('keeps ST worldbook compatibility and returns a result', async () => {
    const h = setup();
    expect(
      await h.api.handleImport(json({ entries: [{ keys: ['key'], content: 'lore', enabled: true }] })),
    ).toMatchObject({ ok: true, kind: 'worldbooks' });
    expect(h.navigation).toEqual([]);
    expect(await h.repository.listWorldBooks()).toHaveLength(1);
  });
  it('returns observable failure for malformed recognized native files', async () => {
    const h = setup();
    expect(
      await h.api.handleImport(json({ format: 'dramatis-library', version: 9, kind: 'cards', data: st }), 'library'),
    ).toMatchObject({ ok: false, error: expect.any(String) });
    expect(await h.repository.listCards()).toEqual([]);
    expect(h.error()).not.toBeNull();
  });
  it('keeps same-name native items as separate library entries', async () => {
    const h = setup();
    const file = json(serializeLibraryItem('personas', createPersona({ name: 'Same' })));
    const first = await h.api.handleImport(file, 'library');
    const second = await h.api.handleImport(file, 'library');
    expect(first).toMatchObject({ ok: true, kind: 'personas' });
    expect(second).toMatchObject({ ok: true, kind: 'personas' });
    expect(await h.repository.listPersonas()).toHaveLength(2);
  });
  it('imports PNG into the library without navigation or automatic attachment', async () => {
    const h = setup();
    expect(await h.api.handleImport(pngFile(), 'library')).toMatchObject({ ok: true, kind: 'cards' });
    expect(await h.repository.listCards()).toHaveLength(1);
    expect(await h.repository.listWorldBooks()).toHaveLength(1);
    expect(h.navigation).toEqual([]);
    expect(h.attached).toEqual([]);
  });
  it('returns failure when persistence rejects', async () => {
    const h = setup();
    vi.spyOn(h.repository, 'saveCard').mockRejectedValue(new Error('Storage unavailable'));
    expect(await h.api.handleImport(json(st), 'library')).toEqual({ ok: false, error: 'Storage unavailable' });
    expect(h.navigation).toEqual([]);
    expect(h.error()).toBe('Storage unavailable');
  });
});
