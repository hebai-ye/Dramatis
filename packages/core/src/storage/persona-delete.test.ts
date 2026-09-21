import { describe, expect, it } from 'vitest';
import { createConversation } from '../model/conversation.js';
import { newId, nowIso, roomId } from '../model/ids.js';
import { createPersona } from '../model/persona.js';
import type { Room } from '../model/room.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { COLLECTIONS, Repository } from './repository.js';

describe('Persona 彻底删除（账户重构 A8）', () => {
  it('清掉实体正文，只留同步墓碑，并保留对话身份快照', async () => {
    const store = createMemoryEntityStore();
    const repo = new Repository(store);
    const persona = createPersona({ name: '沈砚', description: '旧信的主人' });
    const roomIdValue = roomId(newId());
    const room: Room = {
      id: roomIdValue,
      title: '旧城',
      personaId: persona.id,
      playerName: persona.name,
      playerPersona: persona.description,
      cardIds: [],
      instanceIds: [],
      worldBookIds: [],
      activeConversationId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deletedAt: null,
    };
    const conversation = createConversation({
      roomId: roomIdValue,
      title: '主线',
      persona: { personaId: persona.id, name: persona.name, description: persona.description },
    });

    await repo.savePersona(persona);
    await repo.saveRoom(room);
    await repo.saveConversation(conversation);
    await repo.deletePersona(persona.id);

    const raw = await store.get<Record<string, unknown>>(COLLECTIONS.personas, persona.id);
    expect(raw?.name).toBeUndefined();
    expect(raw?.description).toBeUndefined();
    expect(typeof raw?.deletedAt).toBe('string');
    expect(await repo.listPersonas()).toHaveLength(0);

    const loadedConversation = await repo.getConversation(conversation.id);
    expect(loadedConversation?.personaId).toBeNull();
    expect(loadedConversation?.playerName).toBe('沈砚');
    expect(loadedConversation?.playerPersona).toBe('旧信的主人');
    expect((await repo.getRoom(roomIdValue))?.personaId).toBeNull();
  });
});
