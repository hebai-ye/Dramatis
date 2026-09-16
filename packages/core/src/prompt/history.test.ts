import { describe, expect, it } from 'vitest';
import { type InstanceId, instanceId } from '../model/ids.js';
import type { Message } from '../model/message.js';
import { isVisibleTo, selectHistoryFor } from './history.js';

const alice = instanceId('alice');
const bob = instanceId('bob');
const carol = instanceId('carol');

function message(content: string, audience: InstanceId[], speaker: InstanceId | null = null): Message {
  return {
    id: content as never,
    roomId: 'room' as never,
    conversationId: null,
    sceneId: null,
    turnId: 'turn',
    seq: 0,
    role: speaker === null ? 'player' : 'character',
    speakerInstanceId: speaker,
    speakerName: speaker === null ? '玩家' : '角色',
    audience,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('isVisibleTo', () => {
  it('旁白与系统消息对所有人可见', () => {
    expect(isVisibleTo(message('旁白', []), alice)).toBe(true);
    expect(isVisibleTo(message('旁白', []), bob)).toBe(true);
  });

  it('只有在场者能看到当时的对话', () => {
    const line = message('在场时的对话', [alice, bob], bob);
    expect(isVisibleTo(line, alice)).toBe(true);
    expect(isVisibleTo(line, carol)).toBe(false);
  });

  it('自己说过的话永远记得，即使不在受众里', () => {
    const line = message('我说的话', [bob], alice);
    expect(isVisibleTo(line, alice)).toBe(true);
  });
});

describe('selectHistoryFor', () => {
  it('按视角过滤出角色能看到的历史', () => {
    const history = [
      message('开场，两人都在', [alice, bob]),
      message('Alice 离开后 Bob 说的话', [bob], bob),
      message('旁白', []),
    ];

    expect(selectHistoryFor(history, alice).map((item) => item.content)).toEqual(['开场，两人都在', '旁白']);
    expect(selectHistoryFor(history, bob)).toHaveLength(3);
  });

  it('全新的角色看不到任何过去', () => {
    const history = [message('旧事', [alice, bob])];
    expect(selectHistoryFor(history, carol)).toHaveLength(0);
  });

  it('不修改原始数组', () => {
    const history = [message('a', [alice]), message('b', [bob])];
    selectHistoryFor(history, alice);
    expect(history).toHaveLength(2);
  });
});
