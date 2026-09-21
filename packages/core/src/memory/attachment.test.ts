/**
 * 新对话的记忆附件（顺序 27b）。
 *
 * 单测盯四件事：三层都在、**超预算从最不重要的开始丢**（并如实记账）、
 * 关键词抓得到专名（引号里的词、参与者名）、挂到卡上读得回来。
 */

import { describe, expect, it } from 'vitest';
import { createBlankCard } from '../model/card.js';
import { conversationId, eventId, newId } from '../model/ids.js';
import {
  ATTACHMENT_EXTENSION_KEY,
  buildMemoryAttachment,
  describeRelation,
  extractKeywords,
  readAttachment,
  renderAttachment,
  withAttachment,
} from './attachment.js';

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
