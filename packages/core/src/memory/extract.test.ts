import { describe, expect, it } from 'vitest';
import { cardId, instanceId, newId, nowIso, roomId, sceneId } from '../model/ids.js';
import { type CharacterInstance, neutralTraits } from '../model/instance.js';
import type { Scene } from '../model/room.js';
import { createPlayerMessage } from '../session/turn.js';
import { buildExtractionMessages, extractJsonObject, parseExtraction } from './extract.js';
import { MemoryExtractionError } from './types.js';

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

const scene: Scene = {
  id: sceneId(newId()),
  roomId: roomId(newId()),
  conversationId: null,
  title: '开场',
  location: '旧城酒馆',
  worldTime: '第三日 · 黄昏',
  castPolicy: 'locked',
  cast: [],
  summary: '',
  createdAt: nowIso(),
  endedAt: null,
};

describe('extractJsonObject', () => {
  it('直接解析纯 JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('跳过代码块标记与前后废话', () => {
    const raw = '好的，这是记录：\n```json\n{"summary":"x"}\n```\n希望有帮助。';
    expect(extractJsonObject(raw)).toEqual({ summary: 'x' });
  });

  it('正确跳过字符串里的花括号', () => {
    expect(extractJsonObject('{"summary":"他比了个 { 手势 }"}')).toEqual({ summary: '他比了个 { 手势 }' });
  });

  it('正确跳过转义引号', () => {
    expect(extractJsonObject('{"summary":"他说：\\"别过来\\""}')).toEqual({ summary: '他说："别过来"' });
  });

  it('忽略后面的第二个对象', () => {
    expect(extractJsonObject('{"a":1} {"b":2}')).toEqual({ a: 1 });
  });

  it('没有 JSON 时抛错', () => {
    expect(() => extractJsonObject('抱歉，我无法完成。')).toThrow(MemoryExtractionError);
  });

  it('对象没闭合时抛错', () => {
    expect(() => extractJsonObject('{"a":1')).toThrow(MemoryExtractionError);
  });
});

describe('parseExtraction', () => {
  it('解析完整结果', () => {
    const raw = JSON.stringify({
      summary: '两人在酒馆里谈起了旧事。',
      importance: 0.75,
      location: '旧城酒馆',
      observations: [
        { speaker: 'Alice', perception: '她注意到对方在回避某个名字。' },
        { speaker: 'Bob', perception: '他觉得对方只是随口一问。' },
      ],
    });

    const result = parseExtraction(raw);
    expect(result.summary).toBe('两人在酒馆里谈起了旧事。');
    expect(result.importance).toBe(0.75);
    expect(result.observations).toHaveLength(2);
  });

  it('重要度越界时夹到 0~1', () => {
    expect(parseExtraction('{"summary":"x","importance":3}').importance).toBe(1);
    expect(parseExtraction('{"summary":"x","importance":-2}').importance).toBe(0);
  });

  it('缺字段时用默认值', () => {
    const result = parseExtraction('{"summary":"只有摘要"}');
    expect(result.importance).toBe(0.4);
    expect(result.location).toBe('');
    expect(result.observations).toEqual([]);
  });

  it('丢掉不完整的视角条目', () => {
    const raw =
      '{"summary":"x","observations":[{"speaker":"A"},{"perception":"没有名字"},{"speaker":"B","perception":"ok"}]}';
    expect(parseExtraction(raw).observations).toEqual([{ speaker: 'B', perception: 'ok' }]);
  });

  it('摘要为空时抛错，避免写入空洞记忆', () => {
    expect(() => parseExtraction('{"summary":"   "}')).toThrow(MemoryExtractionError);
    expect(() => parseExtraction('{"importance":0.5}')).toThrow(MemoryExtractionError);
  });
});

describe('buildExtractionMessages', () => {
  it('带上场景、玩家与在场角色，并把对话渲染成文本', () => {
    const alice = actor('Alice');
    const bob = actor('Bob');
    const message = createPlayerMessage({
      roomId: scene.roomId,
      sceneId: scene.id,
      turnId: 'turn-1',
      speakerName: '旅人',
      content: '你们认识很久了？',
    });

    const messages = buildExtractionMessages({
      scene,
      cast: [alice, bob],
      playerName: '旅人',
      messages: [message],
    });

    expect(messages[0]?.role).toBe('system');
    const body = messages[1]?.content ?? '';
    expect(body).toContain('旧城酒馆');
    expect(body).toContain('Alice、Bob');
    expect(body).toContain('旅人：你们认识很久了？');
    expect(body).toContain('observations');
  });

  it('场景为空时用未指定占位', () => {
    const body = buildExtractionMessages({ scene: null, cast: [], playerName: '玩家', messages: [] })[1]?.content ?? '';
    expect(body).toContain('地点：未指定');
  });
});
