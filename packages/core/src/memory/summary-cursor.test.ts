/**
 * 审计 C4：场记游标那条消息被删之后，不能整场重摘。
 */
import { describe, expect, it } from 'vitest';
import { messageId, roomId, sceneId } from '../model/ids.js';
import type { Message } from '../model/message.js';
import type { Scene } from '../model/room.js';
import { coveredBySummary, pendingSummary } from './summary.js';

const SCENE = sceneId('s1');
const AT = '2026-09-01T00:00:00.000Z';

function message(index: number, deleted = false): Message {
  return {
    id: messageId(`m${String(index)}`),
    roomId: roomId('r'),
    conversationId: null,
    sceneId: SCENE,
    turnId: `t${String(index)}`,
    // 模拟多设备合并：序号全撞成 1，序号口径分不出先后
    localSeq: 1,
    deviceId: `d${String(index)}`,
    role: 'player',
    speakerInstanceId: null,
    speakerName: '旅人',
    audience: [],
    content: `第${String(index)}句`,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: deleted ? AT : null,
  };
}

const scene = {
  id: SCENE,
  recap: '前两句的场记',
  recapUpToSeq: 1,
  recapUpToMessageId: messageId('m2'),
} as unknown as Scene;

describe('场记游标被删（审计 C4）', () => {
  it('带着墓碑传进来：从游标之后算起，墓碑不出现在结果里', () => {
    const messages = [message(1), message(2, true), message(3), message(4)];
    expect(pendingSummary(scene, messages).messages.map((item) => item.id)).toEqual(['m3', 'm4']);
    expect([...coveredBySummary(scene, messages)]).toEqual(['m1']);
  });

  it('游标没被删时行为不变', () => {
    const messages = [message(1), message(2), message(3)];
    expect(pendingSummary(scene, messages).messages.map((item) => item.id)).toEqual(['m3']);
    expect([...coveredBySummary(scene, messages)]).toEqual(['m1', 'm2']);
  });
});
