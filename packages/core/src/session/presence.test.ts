import { describe, expect, it } from 'vitest';
import { instanceId, newId, nowIso, roomId, sceneId } from '../model/ids.js';
import type { CharacterInstance, Presence } from '../model/instance.js';
import type { Scene } from '../model/room.js';
import { defaultTravelCast, syncPresenceForScene } from './presence.js';

function actor(name: string, presence: Presence): CharacterInstance {
  const now = nowIso();
  return {
    id: instanceId(newId()),
    roomId: roomId(newId()),
    cardId: newId() as never,
    displayName: name,
    presence,
    traits: { extroversion: 0, aggression: 0, empathy: 0, playfulness: 0, caution: 0 },
    affect: { valence: 0, arousal: 0, updatedAt: now, history: [] },
    relationships: [],
    traitsLocked: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function sceneWith(cast: readonly CharacterInstance[]): Scene {
  return {
    id: sceneId(newId()),
    roomId: roomId(newId()),
    conversationId: null,
    title: '胡记栅门外',
    location: '',
    worldTime: '',
    castPolicy: 'locked',
    cast: cast.map((member) => member.id),
    summary: '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    endedAt: null,
    deletedAt: null,
  };
}

describe('syncPresenceForScene', () => {
  it('被留下的人转幕后——长跑里秦娘被换场带走就是这个问题的反面', () => {
    const qinniang = actor('秦娘', 'onstage');
    const chenjiu = actor('陈九', 'onstage');
    const kept = sceneWith([chenjiu]);

    const changed = syncPresenceForScene([qinniang, chenjiu], kept);

    expect(changed.map((item) => item.displayName)).toEqual(['秦娘']);
    expect(changed[0]?.presence).toBe('offscreen');
  });

  it('进了名单的幕后角色转为在场', () => {
    const xiaoman = actor('小满', 'offscreen');
    const changed = syncPresenceForScene([xiaoman], sceneWith([xiaoman]));

    expect(changed[0]?.presence).toBe('onstage');
  });

  it('沉默的人进名单仍是沉默，不该被自动叫醒', () => {
    const muted = actor('小满', 'muted');
    const changed = syncPresenceForScene([muted], sceneWith([muted]));

    expect(changed).toHaveLength(0);
  });

  it('明确离场过的人不会被名单复活', () => {
    const gone = actor('老周', 'absent');
    const changed = syncPresenceForScene([gone], sceneWith([gone]));

    expect(changed).toHaveLength(0);
  });

  it('已经一致时不做任何改动（避免无意义的写库）', () => {
    const a = actor('秦娘', 'onstage');
    const b = actor('陈九', 'offscreen');
    expect(syncPresenceForScene([a, b], sceneWith([a]))).toHaveLength(0);
  });
});

describe('defaultTravelCast', () => {
  it('默认带走此刻在场上的人', () => {
    const qinniang = actor('秦娘', 'onstage');
    const xiaoman = actor('小满', 'muted');
    const chenjiu = actor('陈九', 'offscreen');
    const scene = sceneWith([qinniang, xiaoman, chenjiu]);

    expect(defaultTravelCast(scene, [qinniang, xiaoman, chenjiu])).toEqual([qinniang.id, xiaoman.id]);
  });

  it('还没有场景时退化为世界里的全部在场者', () => {
    const a = actor('甲', 'onstage');
    const b = actor('乙', 'offscreen');

    expect(defaultTravelCast(null, [a, b])).toEqual([a.id]);
  });
});
