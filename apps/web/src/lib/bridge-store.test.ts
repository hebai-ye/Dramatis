import type { ConversationId, InstanceId, Message, MessageId, RoomId, SceneId } from '@dramatis/core';
import { describe, expect, it } from 'vitest';
import type { PendingBridgeTurn } from '../components/WebBridgePanel';
import { bridgeReplyBatch, validatePendingBridgeTurn } from './bridge-store';

const pending: PendingBridgeTurn = {
  roomId: 'room-a' as RoomId,
  conversationId: 'conv-a' as ConversationId,
  sceneId: 'scene-a' as SceneId,
  turnId: 'turn-a',
  playerText: '@秦娘 @陈九，你们怎么看？',
  speakerIds: ['a' as InstanceId, 'b' as InstanceId],
  nextIndex: 0,
};

const message = (role: 'player' | 'character', speakerInstanceId: InstanceId | null): Message => {
  const at = '2026-09-28T00:00:00.000Z';
  return {
    id: `${role}-${speakerInstanceId ?? 'player'}` as MessageId,
    roomId: pending.roomId,
    conversationId: pending.conversationId,
    sceneId: pending.sceneId,
    turnId: pending.turnId,
    localSeq: 1,
    deviceId: 'test-device',
    role,
    speakerInstanceId,
    speakerName: role === 'player' ? '旅人' : '角色',
    audience: [],
    content: '「回应。」',
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
};

describe('网页版桥接恢复校验', () => {
  it('首份尚未贴回时没有已提交半轮；第一人贴回后才能推进第二位', () => {
    expect(validatePendingBridgeTurn(pending, pending, [])).toBeNull();
    const next = { ...pending, nextIndex: 1 };
    expect(
      validatePendingBridgeTurn(next, next, [
        message('player', null),
        message('character', pending.speakerIds[0] ?? null),
      ]),
    ).toBeNull();
    expect(validatePendingBridgeTurn(next, next, [message('player', null)])).toContain('进度');
  });

  it('刷新后换了场景、对话或角色顺序错位时拒绝写入', () => {
    expect(validatePendingBridgeTurn(pending, { ...pending, sceneId: 'new-scene' as SceneId }, [])).toContain('场景');
    const next = { ...pending, nextIndex: 1 };
    expect(
      validatePendingBridgeTurn(next, next, [
        message('player', null),
        message('character', pending.speakerIds[1] ?? null),
      ]),
    ).toContain('进度');
  });

  it('首份贴回批量提交玩家和首人，第二份只追加角色且同轮', () => {
    const first = bridgeReplyBatch(pending, message('character', pending.speakerIds[0] ?? null), '旅人');
    expect(first.map((item) => item.role)).toEqual(['player', 'character']);
    expect(first.map((item) => item.turnId)).toEqual([pending.turnId, pending.turnId]);
    expect(first[0]?.content).toBe(pending.playerText);
    const second = bridgeReplyBatch(
      { ...pending, nextIndex: 1 },
      message('character', pending.speakerIds[1] ?? null),
      '旅人',
    );
    expect(second.map((item) => item.role)).toEqual(['character']);
  });
});
