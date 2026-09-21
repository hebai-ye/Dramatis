/**
 * 新对话的记忆附件（顺序 27b）。
 *
 * 单测盯四件事：三层都在、**超预算从最不重要的开始丢**（并如实记账）、
 * 关键词抓得到专名（引号里的词、参与者名）、挂到卡上读得回来。
 */

import { describe, expect, it } from 'vitest';
import { createBlankCard } from '../model/card.js';
import { conversationId, eventId, instanceId, newId, PLAYER, roomId, sceneId } from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import type { MemoryEvent } from '../model/message.js';
import {
  ATTACHMENT_EXTENSION_KEY,
  buildCardMemoryAttachment,
  buildMemoryAttachment,
  describeRelation,
  extractKeywords,
  readAttachment,
  renderAttachment,
  withAttachment,
} from './attachment.js';
import type { ChapterSummary } from './summary.js';

function impression(text: string, importance: number, at = '2026-09-20T10:00:00.000Z') {
  return {
    id: eventId(newId()),
    summary: text,
    importance,
    participants: ['秦娘'],
    location: '货栈',
    at,
  };
}

function memory(
  observer: CharacterInstance,
  text: string,
  options: { importance?: number; supersedes?: boolean; superseded?: boolean; conversationIdValue?: string } = {},
): MemoryEvent {
  const now = '2026-09-20T10:00:00.000Z';
  return {
    id: eventId(newId()),
    roomId: observer.roomId,
    conversationId: conversationId(options.conversationIdValue ?? 'conv-source'),
    sceneId: sceneId(newId()),
    timeline: { worldTime: '第九日', sequence: 1 },
    location: '货栈',
    participants: [observer.id],
    summary: text,
    observerId: observer.id,
    perception: '这句话我记着。',
    importance: options.importance ?? 0.4,
    pinned: false,
    importanceLocked: false,
    affects: [],
    sourceTurnIds: ['turn-1'],
    createdAt: now,
    updatedAt: now,
    lastRecalledAt: null,
    recallCount: 0,
    deletedAt: null,
    supersededBy: options.superseded === true ? eventId(newId()) : null,
    supersedes: options.supersedes === true ? [eventId(newId())] : [],
    consolidatedAt: options.supersedes === true ? now : null,
  };
}

function cardActor(): { card: ReturnType<typeof createBlankCard>; instance: CharacterInstance } {
  const card = createBlankCard({ name: '秦娘' });
  const now = '2026-09-20T10:00:00.000Z';
  return {
    card,
    instance: {
      id: instanceId(newId()),
      roomId: roomId(newId()),
      cardId: card.id,
      displayName: '秦娘',
      presence: 'onstage',
      traits: { extroversion: 0, aggression: 0, empathy: 0, playfulness: 0, caution: 0 },
      affect: { valence: 0, arousal: 0, updatedAt: now, history: [] },
      relationships: [
        {
          target: PLAYER,
          trust: 0.6,
          affinity: 0.5,
          fear: 0,
          respect: 0.4,
          tension: 0.1,
          updatedAt: now,
          history: [],
        },
      ],
      traitsLocked: false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  };
}

function sourceChapter(conversationIdValue: string, title: string): ChapterSummary {
  const now = '2026-09-20T10:00:00.000Z';
  return {
    id: `chapter-${title}`,
    roomId: roomId(newId()),
    conversationId: conversationId(conversationIdValue),
    title,
    sceneIds: [],
    summary: `${title}发生的事。`,
    keyFacts: ['账房'],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}
describe('记忆附件：关键词（顺序 27b）', () => {
  it('抓得到引号里的专名与调用方给的词，最多 6 个', () => {
    const keywords = extractKeywords('我们在「胡记院」门口等过账房的陈九。账房的门锁着。', ['陈九', '码头']);
    expect(keywords).toContain('陈九');
    expect(keywords).toContain('码头');
    expect(keywords).toContain('胡记院');
    expect(keywords.length).toBeLessThanOrEqual(6);
  });

  it('高频短词会被收进来（中文没有空格，就按窗口数频次）', () => {
    const keywords = extractKeywords('账房的灯亮着。账房的账本也摊着。账房里没人。');
    expect(keywords.some((word) => word.includes('账房'))).toBe(true);
  });
});

describe('记忆附件：三层与预算（顺序 27b）', () => {
  it('三层都在：关系一句话、时间线索引、记忆索引', () => {
    const attachment = buildMemoryAttachment({
      fromConversationId: conversationId(newId()),
      fromConversationTitle: '主线',
      builtAt: '2026-09-22T00:00:00.000Z',
      relationship: { trust: 0.7, affinity: 0.6, fear: 0.1, respect: 0.4, tension: 0.2 },
      chapters: [
        { id: 'c1', title: '雨夜', summary: '那一夜他们在货栈里把账对上了。', at: '2026-09-10T00:00:00.000Z' },
      ],
      impressions: [impression('这半个月我一直在替秦娘瞒着账房的事。', 0.6)],
    });

    expect(attachment.relation).toContain('亲近');
    expect(attachment.timeline).toHaveLength(1);
    expect(attachment.timeline[0]?.keywords.length).toBeGreaterThan(0);
    expect(attachment.memories).toHaveLength(1);
    expect(attachment.stats.chars).toBeLessThanOrEqual(60 + 600 + 1000);
    expect(renderAttachment(attachment)).toContain('你记得的事');
  });

  it('超预算时从**最不重要的**开始丢，并如实记账', () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      impression(`第 ${String(index)} 件事：那天的账房和码头都很安静，我们把货点完了。`, index / 100),
    );
    const attachment = buildMemoryAttachment({
      fromConversationId: conversationId(newId()),
      fromConversationTitle: '主线',
      chapters: [],
      impressions: many,
      budgets: { memories: 200 },
    });

    // 只留得下少数几条，且留下的都是重要度最高的那些
    expect(attachment.memories.length).toBeGreaterThan(0);
    expect(attachment.memories.length).toBeLessThan(many.length);
    expect(attachment.stats.dropped.memories).toBe(many.length - attachment.memories.length);
    const kept = attachment.memories.map((line) => line.importance);
    const droppedHighest = Math.max(...kept);
    const originalHighest = Math.max(...many.map((item) => item.importance));
    expect(droppedHighest).toBe(originalHighest);
  });

  it('时间线超预算时丢最早的章（最近的几章对新对话更有用）', () => {
    const chapters = Array.from({ length: 40 }, (_, index) => ({
      id: `c${String(index)}`,
      title: `第 ${String(index)} 章`,
      summary: '那一阵子他们在货栈和码头之间来回跑，账一直没对上。',
      at: new Date(Date.UTC(2026, 8, 1 + index)).toISOString(),
    }));
    const attachment = buildMemoryAttachment({
      fromConversationId: conversationId(newId()),
      fromConversationTitle: '主线',
      chapters,
      impressions: [],
      budgets: { timeline: 200 },
    });

    expect(attachment.timeline.length).toBeGreaterThan(0);
    expect(attachment.timeline.length).toBeLessThan(chapters.length);
    // 留下的最后一章就是最新的一章
    expect(attachment.timeline.at(-1)?.chapterId).toBe(`c${String(chapters.length - 1)}`);
    expect(attachment.stats.dropped.timeline).toBe(chapters.length - attachment.timeline.length);
  });

  it('没有关系数据时给一句诚实的「还没怎么打过交道」', () => {
    expect(describeRelation(null)).toContain('还没怎么打过交道');
    expect(describeRelation({ trust: 0, affinity: 0, fear: 0, respect: 0, tension: 0 })).toContain('平常');
  });

  it('挂到角色卡上读得回来（附件跟着卡走，同步也就跟着走）', () => {
    const card = createBlankCard({ name: '秦娘' });
    expect(readAttachment(card)).toBeNull();

    const attachment = buildMemoryAttachment({
      fromConversationId: conversationId(newId()),
      fromConversationTitle: '主线',
      chapters: [],
      impressions: [impression('我一直替她瞒着账房的事。', 0.6)],
    });
    const withIt = withAttachment(card, attachment);
    expect(withIt.extensions[ATTACHMENT_EXTENSION_KEY]).toBeDefined();
    const back = readAttachment(withIt);
    expect(back?.relation).toBe(attachment.relation);
    expect(back?.memories).toHaveLength(1);
    // 原来的卡没被改
    expect(card.extensions[ATTACHMENT_EXTENSION_KEY]).toBeUndefined();
  });
});

describe('记忆附件：从原对话生成到卡上（顺序 27b 第二步）', () => {
  it('只带原对话的章节与本实例的印象，并挂到卡上', () => {
    const { card, instance } = cardActor();
    const other = { ...instance, id: instanceId(newId()), cardId: card.id };
    const result = buildCardMemoryAttachment({
      card,
      sourceConversation: { id: conversationId('conv-source'), title: '主线' },
      instance,
      chapters: [sourceChapter('conv-source', '雨夜'), sourceChapter('conv-other', '另一条线')],
      memories: [
        memory(instance, '我把账房的事替你瞒下来了。', { importance: 0.5, supersedes: true }),
        memory(instance, '这是一条还没合并的日常。', { importance: 0.9 }),
        memory(other, '另一个实例的印象，不该串进来。', { importance: 1, supersedes: true }),
      ],
      extraKeywords: ['陈九'],
    });

    expect(result).not.toBeNull();
    expect(readAttachment(result?.card ?? card)?.memories).toHaveLength(1);
    expect(readAttachment(result?.card ?? card)?.timeline.map((item) => item.label)).toEqual(['雨夜']);
    expect(result?.source).toEqual({ impressions: 1, chapters: 1 });
    expect(readAttachment(card)).toBeNull();
  });

  it('还没有合并印象时，退回高重要度且未被取代的条目', () => {
    const { card, instance } = cardActor();
    const result = buildCardMemoryAttachment({
      card,
      sourceConversation: { id: conversationId('conv-source'), title: '主线' },
      instance,
      chapters: [],
      memories: [
        memory(instance, '低重要度。', { importance: 0.2 }),
        memory(instance, '高重要度。', { importance: 0.8 }),
        memory(instance, '已经被合并掉。', { importance: 1, superseded: true }),
      ],
    });

    expect(result?.attachment.memories).toHaveLength(2);
    expect(result?.attachment.memories[0]?.line).toContain('高重要度');
    expect(result?.attachment.memories.some((item) => item.line.includes('已经被合并掉'))).toBe(false);
  });

  it('没有章节也没有可带记忆时不造空附件', () => {
    const { card, instance } = cardActor();
    expect(
      buildCardMemoryAttachment({
        card,
        sourceConversation: { id: conversationId('conv-source'), title: '主线' },
        instance,
        chapters: [],
        memories: [],
      }),
    ).toBeNull();
  });
});
