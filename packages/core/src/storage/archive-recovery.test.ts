import { describe, expect, it, vi } from 'vitest';
import { createBlankCard } from '../model/card.js';
import { newId, roomId } from '../model/ids.js';
import type { Room } from '../model/room.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import {
  buildWorldArchive,
  IMPORT_PENDING_KEY_PREFIX,
  importWorldArchive,
  recoverInterruptedImports,
} from './archive.js';
import { Repository } from './repository.js';

const AT = '2026-09-01T00:00:00.000Z';
const NOW = Date.parse('2026-10-01T00:00:00.000Z');

async function fixture() {
  const repository = new Repository(createMemoryEntityStore());
  const card = createBlankCard({ name: 'Synthetic card' });
  const room: Room = {
    id: roomId(newId()),
    title: 'Synthetic world',
    personaId: null,
    playerName: 'Player',
    playerPersona: '',
    cardIds: [card.id],
    worldBookIds: [],
    instanceIds: [],
    activeConversationId: null,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
  };
  await repository.saveCard(card);
  await repository.saveRoom(room);
  const key = `${IMPORT_PENDING_KEY_PREFIX}${newId()}`;
  const marker = {
    roomId: room.id,
    cardIds: [card.id],
    worldBookIds: [],
    personaId: null,
    startedAt: AT,
  };
  return { repository, card, room, key, marker };
}

describe('PendingImport recovery validates before deletion (A13)', () => {
  const malformed: Array<[string, (marker: Record<string, unknown>) => unknown]> = [
    ['broken JSON text', () => '{"roomId":'],
    ['array instead of object', () => []],
    ['missing cards', ({ cardIds: _cards, ...marker }) => marker],
    ['non-array books', (marker) => ({ ...marker, worldBookIds: 'book' })],
    ['invalid card id after valid id', (marker) => ({ ...marker, cardIds: [...(marker.cardIds as string[]), 42] })],
    ['empty card id', (marker) => ({ ...marker, cardIds: [''] })],
    [
      'duplicate card id',
      (marker) => ({ ...marker, cardIds: [...(marker.cardIds as string[]), ...(marker.cardIds as string[])] }),
    ],
    ['invalid persona', (marker) => ({ ...marker, personaId: {} })],
    ['missing persona', ({ personaId: _persona, ...marker }) => marker],
    ['empty room', (marker) => ({ ...marker, roomId: ' ' })],
    ['invalid date', (marker) => ({ ...marker, startedAt: 'not-a-date' })],
    ['missing date', ({ startedAt: _at, ...marker }) => marker],
    ['non-string date', (marker) => ({ ...marker, startedAt: 0 })],
    ['unsupported version', (marker) => ({ ...marker, version: 999 })],
  ];

  it.each(malformed)('%s is cleared without touching world or assets', async (_label, corrupt) => {
    const { repository, card, room, key, marker } = await fixture();
    const before = await repository.loadRoom(room.id);
    await repository.setMeta(key, corrupt(marker));
    const deleteRoom = vi.spyOn(repository, 'deleteRoom');
    const deleteCard = vi.spyOn(repository, 'deleteCard');
    const deleteBook = vi.spyOn(repository, 'deleteWorldBook');
    const deletePersona = vi.spyOn(repository, 'deletePersona');

    const result = await recoverInterruptedImports(repository, { now: NOW });

    expect(result.rooms).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(deleteRoom).not.toHaveBeenCalled();
    expect(deleteCard).not.toHaveBeenCalled();
    expect(deleteBook).not.toHaveBeenCalled();
    expect(deletePersona).not.toHaveBeenCalled();
    expect(await repository.getMeta(key)).toBeNull();
    expect(await repository.loadRoom(room.id)).toEqual(before);
    expect(await repository.getCard(card.id)).not.toBeNull();
  });

  it('checks the entire marker even when it is fresh', async () => {
    const { repository, room, key, marker } = await fixture();
    await repository.setMeta(key, { ...marker, startedAt: new Date(NOW).toISOString(), worldBookIds: null });
    const result = await recoverInterruptedImports(repository, { now: NOW });
    expect(result.stillPending).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(await repository.getMeta(key)).toBeNull();
    expect(await repository.getRoom(room.id)).not.toBeNull();
  });

  it('keeps a world when a valid-looking marker points to another room', async () => {
    const { repository, room, key, marker } = await fixture();
    const other = { ...room, id: roomId(newId()), cardIds: [] };
    await repository.saveRoom(other);
    await repository.setMeta(key, { ...marker, roomId: other.id });
    const before = await repository.loadRoom(other.id);
    const deleteRoom = vi.spyOn(repository, 'deleteRoom');

    const result = await recoverInterruptedImports(repository, { now: NOW });
    expect(result.rooms).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(deleteRoom).not.toHaveBeenCalled();
    expect(await repository.loadRoom(other.id)).toEqual(before);
    expect(await repository.getRoom(room.id)).not.toBeNull();
  });

  it('does not delete assets without a room snapshot', async () => {
    const { repository, card, key, marker } = await fixture();
    await repository.setMeta(key, { ...marker, roomId: roomId(newId()) });
    const deleteRoom = vi.spyOn(repository, 'deleteRoom');
    const deleteCard = vi.spyOn(repository, 'deleteCard');
    const result = await recoverInterruptedImports(repository, { now: NOW });
    expect(result.rooms).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(deleteRoom).not.toHaveBeenCalled();
    expect(deleteCard).not.toHaveBeenCalled();
    expect(await repository.getCard(card.id)).not.toBeNull();
  });

  it('a failed preflight retains the marker and continues reading other markers', async () => {
    const { repository, room, key, marker } = await fixture();
    await repository.setMeta(key, marker);
    const brokenKey = `${IMPORT_PENDING_KEY_PREFIX}${newId()}`;
    await repository.setMeta(brokenKey, '{');
    vi.spyOn(repository, 'loadRoom').mockRejectedValue(new Error('Synthetic read failure'));
    const deleteRoom = vi.spyOn(repository, 'deleteRoom');
    const result = await recoverInterruptedImports(repository, { now: NOW });
    expect(result.rooms).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(deleteRoom).not.toHaveBeenCalled();
    expect(await repository.getMeta(key)).toEqual(marker);
    expect(await repository.getMeta(brokenKey)).toBeNull();
    expect(await repository.getRoom(room.id)).not.toBeNull();
  });

  it('does not delete assets that another world now shares', async () => {
    const { repository, room, key, marker } = await fixture();
    await repository.saveRoom({ ...room, id: roomId(newId()) });
    await repository.setMeta(key, marker);
    const deleteRoom = vi.spyOn(repository, 'deleteRoom');
    const result = await recoverInterruptedImports(repository, { now: NOW });
    expect(result.rooms).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(deleteRoom).not.toHaveBeenCalled();
    expect(await repository.getRoom(room.id)).not.toBeNull();
  });

  it('round trips a valid world and safely recovers a complete stale marker', async () => {
    const { repository, room } = await fixture();
    const source = await repository.loadRoom(room.id);
    if (source === null) throw new Error('Synthetic fixture missing');
    const target = new Repository(createMemoryEntityStore());
    const imported = await importWorldArchive(buildWorldArchive(source), target);
    const loaded = await target.loadRoom(imported.roomId);
    if (loaded === null) throw new Error('Imported fixture missing');
    expect(loaded.cards).toHaveLength(1);
    const key = `${IMPORT_PENDING_KEY_PREFIX}${newId()}`;
    await target.setMeta(key, {
      version: 1,
      roomId: imported.roomId,
      cardIds: loaded.cards.map((card) => card.id),
      worldBookIds: [],
      personaId: null,
      startedAt: AT,
    });
    expect(await recoverInterruptedImports(target, { now: NOW })).toEqual({
      rooms: [imported.roomId],
      stillPending: 0,
      warnings: [],
    });
    expect(await target.listRooms()).toEqual([]);
    expect(await target.listCards()).toEqual([]);
    expect(await target.getMeta(key)).toBeNull();
    expect(await repository.getRoom(room.id)).not.toBeNull();
  });
});
