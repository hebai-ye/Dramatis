import { describe, expect, it } from 'vitest';
import { conversationId, eventId, instanceId, newId, roomId } from '../model/ids.js';
import type { MemoryEvent } from '../model/message.js';
import { ALL, countByConversation, filterMemories, groupMemoriesByTurn, OBJECTIVE } from './panel-view.js';

const QIN = instanceId('qin');
const MAN = instanceId('man');

function memory(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: eventId(newId()),
    roomId: roomId('room-1'),
    conversationId: conversationId('conv-main'),
    sceneId: null,
    timeline: { worldTime: '第三日', sequence: 1 },
    location: '',
    participants: [],
    summary: '货栈里点过数',
    observerId: QIN,
    perception: '',
    importance: 0.5,
    pinned: false,
    importanceLocked: false,
    affects: [],
    sourceTurnIds: ['turn-1'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastRecalledAt: null,
    recallCount: 0,
    deletedAt: null,
    ...overrides,
  };
}

describe('filterMemories', () => {
  const memories = [
    memory({ id: eventId('a'), conversationId: conversationId('conv-main'), observerId: null }),
    memory({ id: eventId('b'), conversationId: conversationId('conv-main'), observerId: QIN }),
    memory({ id: eventId('c'), conversationId: conversationId('conv-river'), observerId: MAN }),
    memory({ id: eventId('d'), conversationId: null, observerId: null }),
  ];

  it('默认全都要', () => {
    expect(filterMemories(memories, { conversationId: ALL, observerId: ALL })).toHaveLength(4);
  });

  it('按对话筛：只留下那条线的记忆（这是 T11 缺的那个维度）', () => {
    const filtered = filterMemories(memories, { conversationId: conversationId('conv-main'), observerId: ALL });
    expect(filtered.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('按视角筛：客观与某个角色是两个互斥的取值', () => {
    expect(filterMemories(memories, { conversationId: ALL, observerId: OBJECTIVE }).map((item) => item.id)).toEqual([
      'a',
      'd',
    ]);
    expect(filterMemories(memories, { conversationId: ALL, observerId: QIN }).map((item) => item.id)).toEqual(['b']);
  });

  it('两个维度可以叠起来：主线 × 客观', () => {
    expect(
      filterMemories(memories, { conversationId: conversationId('conv-main'), observerId: OBJECTIVE }).map(
        (item) => item.id,
      ),
    ).toEqual(['a']);
  });

  it('conversationId 为 null 的老记忆不会被算进任何一条线', () => {
    const filtered = filterMemories(memories, { conversationId: conversationId('conv-main'), observerId: ALL });
    expect(filtered.some((item) => item.id === 'd')).toBe(false);
  });
});

describe('countByConversation', () => {
  it('按对话数数，null 归到空串这一档', () => {
    const counts = countByConversation([
      memory({ conversationId: conversationId('conv-main') }),
      memory({ conversationId: conversationId('conv-main') }),
      memory({ conversationId: conversationId('conv-river') }),
      memory({ conversationId: null }),
    ]);
    expect(counts.get('conv-main')).toBe(2);
    expect(counts.get('conv-river')).toBe(1);
    expect(counts.get('')).toBe(1);
  });
});

describe('groupMemoriesByTurn', () => {
  it('把同一轮的客观条目与各角色视角摆进一组', () => {
    const groups = groupMemoriesByTurn([
      memory({
        id: eventId('view-qin'),
        observerId: QIN,
        sourceTurnIds: ['turn-7'],
        createdAt: '2026-01-01T00:02:00.000Z',
      }),
      memory({
        id: eventId('obj'),
        observerId: null,
        sourceTurnIds: ['turn-7'],
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      memory({
        id: eventId('view-man'),
        observerId: MAN,
        sourceTurnIds: ['turn-7'],
        createdAt: '2026-01-01T00:01:00.000Z',
      }),
    ]);

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group?.turnId).toBe('turn-7');
    expect(group?.objective?.id).toBe('obj');
    expect(group?.observations.map((item) => item.id)).toEqual(['view-man', 'view-qin']);
  });

  it('不同轮不会并到一起，且新的在前', () => {
    const groups = groupMemoriesByTurn([
      memory({ sourceTurnIds: ['turn-1'], createdAt: '2026-01-01T00:00:00.000Z' }),
      memory({ sourceTurnIds: ['turn-2'], createdAt: '2026-01-01T00:05:00.000Z' }),
    ]);
    expect(groups.map((group) => group.turnId)).toEqual(['turn-2', 'turn-1']);
  });

  it('没有 turnId 的老记忆各自成组，不会被凑成一组', () => {
    const groups = groupMemoriesByTurn([
      memory({ id: eventId('old-1'), sourceTurnIds: [] }),
      memory({ id: eventId('old-2'), sourceTurnIds: [] }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.turnId === null)).toBe(true);
  });

  it('一轮里出现两条客观条目时不丢数据', () => {
    const groups = groupMemoriesByTurn([
      memory({ id: eventId('obj-old'), observerId: null, createdAt: '2026-01-01T00:00:00.000Z' }),
      memory({ id: eventId('obj-new'), observerId: null, createdAt: '2026-01-01T00:03:00.000Z' }),
    ]);
    const group = groups[0];
    expect(group?.objective?.id).toBe('obj-new');
    expect(group?.observations.map((item) => item.id)).toEqual(['obj-old']);
  });
});
