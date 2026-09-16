import { describe, expect, it } from 'vitest';
import { cardId, instanceId, newId, nowIso, roomId } from '../model/ids.js';
import { type CharacterInstance, neutralTraits } from '../model/instance.js';
import { buildMemoryEvents } from './ingest.js';
import type { ExtractedMemory } from './types.js';

function actor(name: string): CharacterInstance {
  const now = nowIso();
  return {
    id: instanceId(newId()),
    roomId: roomId(newId()),
    cardId: cardId(newId()),
    displayName: name,
    presence: 'onstage',
    traits: neutralTraits(),
    affect: { valence: 0, arousal: 0, updatedAt: now, history: [] },
    relationships: [],
    traitsLocked: false,
    createdAt: now,
    updatedAt: now,
  };
}

const extraction: ExtractedMemory = {
  summary: '两人在雨夜谈起了失踪的商队。',
  importance: 0.7,
  location: '旧城酒馆',
  observations: [
    { speaker: 'Alice', perception: '她确信对方隐瞒了什么。' },
    { speaker: 'Bob', perception: '他觉得这只是一桩寻常买卖。' },
  ],
};

function ingest(participants: CharacterInstance[], value: ExtractedMemory = extraction) {
  return buildMemoryEvents({
    roomId: roomId('room-1'),
    sceneId: null,
    worldTime: '第三日 · 夜',
    sequence: 1,
    participants,
    extraction: value,
    turnId: 'turn-1',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('buildMemoryEvents', () => {
  it('产出一条客观条目加每个视角各一条', () => {
    const alice = actor('Alice');
    const bob = actor('Bob');

    const { events } = ingest([alice, bob]);

    expect(events).toHaveLength(3);
    const objective = events.find((event) => event.observerId === null);
    expect(objective?.summary).toBe(extraction.summary);
    expect(objective?.perception).toBe('');

    const aliceMemory = events.find((event) => event.observerId === alice.id);
    expect(aliceMemory?.perception).toBe('她确信对方隐瞒了什么。');
  });

  it('同一件事在不同角色眼里是不同条目', () => {
    const alice = actor('Alice');
    const bob = actor('Bob');

    const { events } = ingest([alice, bob]);
    const perceptions = events.filter((event) => event.observerId !== null).map((event) => event.perception);

    expect(new Set(perceptions).size).toBe(2);
  });

  it('角色名匹配忽略大小写与首尾空格', () => {
    const alice = actor('Alice');
    const result = ingest([alice], {
      ...extraction,
      observations: [{ speaker: '  alice ', perception: '她觉得不对劲。' }],
    });

    expect(result.events.some((event) => event.observerId === alice.id)).toBe(true);
    expect(result.unmatchedSpeakers).toEqual([]);
  });

  it('匹配不到的名字被记录下来，而不是静默丢弃', () => {
    const alice = actor('Alice');
    const result = ingest([alice]);

    expect(result.unmatchedSpeakers).toEqual(['Bob']);
  });

  it('在场但没有视角条目的角色被标为沉默', () => {
    const alice = actor('Alice');
    const carol = actor('Carol');

    const result = ingest([alice, carol]);

    expect(result.silentParticipants).toEqual(['Carol']);
  });

  it('同一角色被重复提到时只保留第一条', () => {
    const alice = actor('Alice');
    const result = ingest([alice], {
      ...extraction,
      observations: [
        { speaker: 'Alice', perception: '第一条' },
        { speaker: 'Alice', perception: '第二条' },
      ],
    });

    const aliceEvents = result.events.filter((event) => event.observerId === alice.id);
    expect(aliceEvents).toHaveLength(1);
    expect(aliceEvents[0]?.perception).toBe('第一条');
  });

  it('每条记忆都带上来源回合，供重抽时回滚', () => {
    const { events } = ingest([actor('Alice')]);
    expect(events.every((event) => event.sourceTurnIds.includes('turn-1'))).toBe(true);
  });

  it('新记忆默认未置顶、未锁定重要度', () => {
    const { events } = ingest([actor('Alice')]);
    expect(events.every((event) => !event.pinned && !event.importanceLocked)).toBe(true);
  });
});
