import type { ConversationId, InstanceId, Message, MessageId, RoomId, SceneId } from '@dramatis/core';
import { describe, expect, it } from 'vitest';
import type { PendingBridgeTurn } from '../components/WebBridgePanel';
import {
  bridgeReplyBatch,
  readPendingBridgeProgress,
  recoverPendingBridgeState,
  validateBridgeReplyContent,
  validatePendingBridgeTurn,
} from './bridge-store';

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
    expect(first[0]?.createdAt).toBe(first[1]?.createdAt);
    const second = bridgeReplyBatch(
      { ...pending, nextIndex: 1 },
      message('character', pending.speakerIds[1] ?? null),
      '旅人',
    );
    expect(second.map((item) => item.role)).toEqual(['character']);
  });

  it('刷新时状态还在第一份，但库里已有第一人，按已保存前缀恢复第二份', () => {
    const committed = [message('player', null), message('character', pending.speakerIds[0] ?? null)];
    expect(readPendingBridgeProgress(pending, pending, committed)).toEqual({ committed: 1 });
    expect(validatePendingBridgeTurn(pending, pending, committed)).toContain('进度');
    const complete = [...committed, message('character', pending.speakerIds[1] ?? null)];
    expect(readPendingBridgeProgress(pending, pending, complete)).toEqual({ committed: 2 });
  });

  it('恢复流程准备第二份提示词；末位已保存则转一轮分析', async () => {
    const history = [message('player', null), message('character', pending.speakerIds[0] ?? null)];
    const speakers = [
      { id: pending.speakerIds[0] as InstanceId, displayName: '秦娘' },
      { id: pending.speakerIds[1] as InstanceId, displayName: '陈九' },
    ];
    const next = await recoverPendingBridgeState({
      pending,
      committed: 1,
      history,
      speakers,
      preparePrompt: async (state) => `下一份：${String(state.nextIndex)}`,
      analysisPrompt: () => '一轮分析',
    });
    expect(next).toMatchObject({
      stage: 'reply',
      speakerName: '陈九',
      prompt: '下一份：1',
      pendingTurn: { nextIndex: 1 },
    });
    const done = await recoverPendingBridgeState({
      pending,
      committed: 2,
      history,
      speakers,
      preparePrompt: async () => '不应调用',
      analysisPrompt: () => '一轮分析',
    });
    expect(done).toMatchObject({ stage: 'analysis', prompt: '一轮分析', turnId: pending.turnId });
  });

  it('静默桥接拒绝贴回的台词，允许动作', () => {
    const silent = { ...pending, actionsOnly: true };
    expect(validateBridgeReplyContent(silent, '「我来回答。」')).toContain('只许动作');
    expect(validateBridgeReplyContent(silent, '# 秦娘点头。')).toBeNull();
  });

  it('第二位被导演安排 hold_back 时，桥接仍拒绝贴回台词', () => {
    const planned = {
      ...pending,
      nextIndex: 1,
      speakerPlans: [
        { intent: '先回答', mode: 'reply' as const },
        { intent: '欲言又止', mode: 'hold_back' as const },
      ],
    };
    expect(validateBridgeReplyContent(planned, '「我也同意。」')).toContain('只许动作');
    expect(validateBridgeReplyContent(planned, '# 陈九移开目光。')).toBeNull();
  });
});
