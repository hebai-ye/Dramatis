import { describe, expect, it } from 'vitest';
import { instanceId, messageId, newId, roomId, sceneId } from '../model/ids.js';
import type { Message } from '../model/message.js';
import type { Scene } from '../model/room.js';
import { expandHistoryOnMention, partitionHistory, selectHistoryFor } from './history.js';

const ROOM = roomId('room-1');
const ME = instanceId('me');

function scene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: sceneId(newId()),
    roomId: ROOM,
    conversationId: null,
    title: '一场戏',
    location: '码头',
    worldTime: '',
    castPolicy: 'open',
    cast: [ME],
    summary: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

/** 造一场戏里的 N 条消息：玩家与角色交替，序号从 startSeq 起连续。 */
function lines(sceneValue: Scene, count: number, startSeq: number, prefix = '第'): Message[] {
  return Array.from({ length: count }, (_, index) => {
    const player = index % 2 === 0;
    return {
      id: messageId(`${sceneValue.id}-${String(index)}`),
      roomId: ROOM,
      conversationId: null,
      sceneId: sceneValue.id,
      turnId: `turn-${String(Math.floor(index / 2))}`,
      localSeq: startSeq + index,
      deviceId: 'dev',
      role: player ? 'player' : 'character',
      speakerInstanceId: player ? null : ME,
      speakerName: player ? '旅人' : '阿箬',
      audience: [ME],
      content: `${prefix} ${String(startSeq + index)} 句`,
      createdAt: `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z`,
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
    } as Message;
  });
}

describe('partitionHistory（顺序 58：按场记覆盖收起）', () => {
  it('full 模式原文全带，一条不收', () => {
    const ended = scene({ recap: '前一场的经过。', recapUpToSeq: 20, endedAt: '2026-01-01T01:00:00.000Z' });
    const history = lines(ended, 20, 1);
    const result = partitionHistory(history, {
      messages: history,
      scenes: [ended],
      policy: { mode: 'full', nearWindow: 4 },
    });
    expect(result.kept).toHaveLength(20);
    expect(result.collapsed).toHaveLength(0);
  });

  it('已被场记覆盖、又在近窗之外的才收起；近窗内的照带', () => {
    const current = scene({ recap: '本场到目前为止。', recapUpToSeq: 12 });
    const history = lines(current, 20, 1);
    const result = partitionHistory(history, {
      messages: history,
      scenes: [current],
      policy: { mode: 'recap-aware', nearWindow: 4 },
    });

    // 序号 1–12 被覆盖；近窗是最后 4 条（序号 17–20）；13–16 没被覆盖，也要带
    expect(result.collapsed.map((message) => message.localSeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(result.kept.map((message) => message.localSeq)).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it('没有场记文字的场景一条都不收，哪怕游标写了数', () => {
    const current = scene({ recap: '', recapUpToSeq: 12 });
    const history = lines(current, 20, 1);
    const result = partitionHistory(history, {
      messages: history,
      scenes: [current],
      policy: { mode: 'recap-aware', nearWindow: 4 },
    });
    expect(result.collapsed).toHaveLength(0);
  });

  it('场记的消息 id 游标优先于序号；多场戏各按各的场记算', () => {
    const first = scene({ id: sceneId('s1'), endedAt: '2026-01-01T01:00:00.000Z', recap: '第一场。' });
    const firstLines = lines(first, 10, 1, '甲');
    // 消息 id 游标停在第 6 条：前 6 条覆盖，后 4 条（这一场的尾巴）没覆盖
    const firstWithCursor: Scene = { ...first, recapUpToMessageId: firstLines[5]?.id ?? null, recapUpToSeq: 0 };
    const second = scene({ id: sceneId('s2'), recap: '第二场。', recapUpToSeq: 14 });
    const secondLines = lines(second, 10, 11, '乙');
    const history = [...firstLines, ...secondLines];

    const result = partitionHistory(history, {
      messages: history,
      scenes: [firstWithCursor, second],
      policy: { mode: 'recap-aware', nearWindow: 2 },
    });

    expect(result.collapsed.map((message) => message.localSeq)).toEqual([1, 2, 3, 4, 5, 6, 11, 12, 13, 14]);
    expect(result.kept.map((message) => message.localSeq)).toEqual([7, 8, 9, 10, 15, 16, 17, 18, 19, 20]);
  });

  it('近窗按这个角色看得见的历史计数，游标仍在全量消息里找', () => {
    const current = scene({ recap: '本场。', recapUpToSeq: 8 });
    const all = lines(current, 10, 1);
    // 第 5 条只有别人看得见：它不在可见历史里，但序号照样存在
    const hidden = { ...(all[4] as Message), audience: [instanceId('someone-else')] };
    const history = all.map((message) => (message.localSeq === 5 ? hidden : message));
    const visible = selectHistoryFor(history, ME);
    expect(visible).toHaveLength(9);

    const result = partitionHistory(visible, {
      messages: history,
      scenes: [current],
      policy: { mode: 'recap-aware', nearWindow: 3 },
    });
    // 可见 9 条里最后 3 条（序号 8、9、10）是近窗；序号 9、10 本来就没被覆盖
    expect(result.collapsed.map((message) => message.localSeq)).toEqual([1, 2, 3, 4, 6, 7]);
    expect(result.kept.map((message) => message.localSeq)).toEqual([8, 9, 10]);
  });
});

describe('expandHistoryOnMention（顺序 58：提到才取回）', () => {
  const current = scene({ recap: '本场。', recapUpToSeq: 40 });
  const collapsed = lines(current, 40, 1).map((message, index) => ({
    ...message,
    content:
      index === 4
        ? '那把断了的铜钥匙还在你那儿吗？'
        : index === 5
          ? '「铜钥匙在柜子第三层。」阿箬把手里的东西放下。'
          : index === 30
            ? '铜钥匙的事别再提了。'
            : index === 31
              ? '铜钥匙、铜钥匙，你就惦记这个。'
              : `第 ${String(index + 1)} 句闲话`,
  }));

  it('只认玩家这一句的关键词：命中多的优先、其次更近的，最多三条，按时间顺序给', () => {
    const picked = expandHistoryOnMention(collapsed, '铜钥匙呢？');
    expect(picked).toHaveLength(3);
    // 四条都命中「铜钥」「钥匙」：先按命中数（第 32 句命中两遍算的是词种类，仍是 2），再按更近的
    expect(picked.map((message) => message.localSeq)).toEqual([6, 31, 32]);
  });

  it('一个词都没命中就什么都不取', () => {
    expect(expandHistoryOnMention(collapsed, '今晚喝点酒？')).toEqual([]);
    expect(expandHistoryOnMention(collapsed, '')).toEqual([]);
  });

  it('上限可调', () => {
    expect(expandHistoryOnMention(collapsed, '铜钥匙呢？', 1).map((message) => message.localSeq)).toEqual([32]);
  });
});
