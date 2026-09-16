import { describe, expect, it } from 'vitest';
import { instanceId, newId, nowIso, PLAYER, roomId, sceneId } from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import type { Scene } from '../model/room.js';
import { buildSceneTransitionNarration, joinNames, selectSceneMembers } from './narration.js';

function actor(name: string): CharacterInstance {
  const now = nowIso();
  return {
    id: instanceId(newId()),
    roomId: roomId(newId()),
    cardId: newId() as never,
    displayName: name,
    presence: 'onstage',
    traits: { extroversion: 0, aggression: 0, empathy: 0, playfulness: 0, caution: 0 },
    affect: { valence: 0, arousal: 0, updatedAt: now, history: [] },
    relationships: [
      { target: PLAYER, trust: 0, affinity: 0, fear: 0, respect: 0, tension: 0, updatedAt: now, history: [] },
    ],
    traitsLocked: false,
    createdAt: now,
    updatedAt: now,
  };
}

function scene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: sceneId(newId()),
    roomId: roomId(newId()),
    conversationId: null,
    title: '旧城东侧的夜间酒馆',
    location: '',
    worldTime: '',
    castPolicy: 'locked',
    cast: [],
    summary: '',
    createdAt: nowIso(),
    endedAt: null,
    ...overrides,
  };
}

describe('joinNames', () => {
  it('按 1 / 2 / 3 人给出不同连接方式', () => {
    expect(joinNames(['Alice'])).toBe('Alice');
    expect(joinNames(['Alice', 'Bob'])).toBe('Alice 与 Bob');
    expect(joinNames(['Alice', 'Bob', 'Carol'])).toBe('Alice、Bob 与 Carol');
    expect(joinNames([])).toBe('');
  });
});

describe('buildSceneTransitionNarration', () => {
  it('记录「谁跟谁去了哪里」', () => {
    const narration = buildSceneTransitionNarration({
      next: scene({ title: '酒馆', location: '旧城东侧' }),
      members: [actor('Alice'), actor('Bob')],
    });

    expect(narration).toBe('Alice 与 Bob 进入了 酒馆（旧城东侧）');
  });

  it('地点与场景名相同时不写两遍', () => {
    const narration = buildSceneTransitionNarration({
      next: scene({ title: '旧城东侧的夜间酒馆', location: '旧城东侧的夜间酒馆' }),
      members: [actor('Alice')],
    });

    expect(narration).toBe('Alice 进入了 旧城东侧的夜间酒馆');
  });

  it('一个人都没有时退化成地点描述，而不是写「 进入了」', () => {
    const narration = buildSceneTransitionNarration({
      next: scene({ title: '', location: '' }),
      members: [],
    });

    expect(narration).toBe('场景切换到 新的场景');
  });
});

describe('selectSceneMembers', () => {
  it('只挑在新场景名单里的人', () => {
    const alice = actor('Alice');
    const bob = actor('Bob');
    const next = scene({ cast: [alice.id] });

    expect(selectSceneMembers([alice, bob], next).map((member) => member.displayName)).toEqual(['Alice']);
  });
});
