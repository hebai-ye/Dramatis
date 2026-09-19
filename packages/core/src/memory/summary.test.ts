import { describe, expect, it } from 'vitest';
import { conversationId, messageId, newId, roomId, sceneId } from '../model/ids.js';
import type { Message } from '../model/message.js';
import type { Scene } from '../model/room.js';
import {
  buildChapterSummaryMessages,
  buildSceneSummaryMessages,
  CHAPTER_SCENE_THRESHOLD,
  chapterCandidates,
  parseSummary,
  pendingSummary,
  SUMMARY_TURN_THRESHOLD,
  shouldSummarizeScene,
} from './summary.js';

function scene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: sceneId('scene-1'),
    roomId: roomId('room-1'),
    conversationId: conversationId('conv-1'),
    title: '雨夜',
    location: '旧城酒馆',
    worldTime: '第三日 · 夜',
    castPolicy: 'open',
    cast: [],
    summary: '酒馆的设定',
    createdAt: '2026-09-19T00:00:00.000Z',
    endedAt: null,
    ...overrides,
    updatedAt: overrides.updatedAt ?? '2026-09-19T00:00:00.000Z',
    deletedAt: null,
  };
}

function line(input: {
  seq: number;
  turnId: string;
  content: string;
  sceneIdValue?: string;
  speaker?: string;
}): Message {
  return {
    id: messageId(newId()),
    roomId: roomId('room-1'),
    conversationId: conversationId('conv-1'),
    sceneId: sceneId(input.sceneIdValue ?? 'scene-1'),
    turnId: input.turnId,
    seq: input.seq,
    role: 'character',
    speakerInstanceId: null,
    speakerName: input.speaker ?? '秦娘',
    audience: [],
    content: input.content,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    deletedAt: null,
  };
}

describe('场景摘要提示词', () => {
  it('带上地点、时间、在场的人与新增的部分', () => {
    const messages = buildSceneSummaryMessages({
      scene: scene(),
      cast: [{ id: 'inst-1', displayName: '秦娘' }],
      playerName: '旅人',
      messages: [line({ seq: 1, turnId: 't1', content: '「三十箱货是谁的？」' })],
      previousSummary: '',
    });

    const body = messages.map((message) => message.content).join('\n');
    expect(body).toContain('旧城酒馆');
    expect(body).toContain('第三日 · 夜');
    expect(body).toContain('秦娘');
    expect(body).toContain('旅人');
    expect(body).toContain('三十箱货是谁的');
    // 客观记述的边界要写死，否则摘要会变成文艺评论
    expect(body).toContain('不写谁的内心');
    expect(body).toContain('不要编造');
  });

  it('有旧摘要时要求「合并」而不是重写，且不丢掉里面的事实', () => {
    const messages = buildSceneSummaryMessages({
      scene: scene(),
      cast: [],
      playerName: '旅人',
      messages: [line({ seq: 9, turnId: 't9', content: '「船明早开。」' })],
      previousSummary: '玩家问起三十箱货，秦娘没有正面回答。',
    });

    const body = messages.map((message) => message.content).join('\n');
    expect(body).toContain('合并成一段');
    expect(body).toContain('玩家问起三十箱货，秦娘没有正面回答。');
  });

  it('玩家的话标出「玩家」，免得摘要把他写成角色', () => {
    const playerLine: Message = {
      ...line({ seq: 1, turnId: 't1', content: '「船明早开？」' }),
      role: 'player',
      speakerName: '旅人',
    };
    const messages = buildSceneSummaryMessages({
      scene: scene(),
      cast: [],
      playerName: '旅人',
      messages: [playerLine],
      previousSummary: '',
    });

    expect(messages.map((message) => message.content).join('\n')).toContain('旅人（玩家）');
  });
});

describe('摘要解析', () => {
  it('认 JSON 对象与要点清单', () => {
    const parsed = parseSummary('{"summary":"秦娘没接话。","keyFacts":["三十箱货在夹层"," "] }');
    expect(parsed.summary).toBe('秦娘没接话。');
    expect(parsed.keyFacts).toEqual(['三十箱货在夹层']);
  });

  it('模型直接写散文也收下——把整段当摘要，比丢掉整轮强', () => {
    const parsed = parseSummary('秦娘没有正面回答，只把杯子擦了擦。');
    expect(parsed.summary).toBe('秦娘没有正面回答，只把杯子擦了擦。');
    expect(parsed.keyFacts).toEqual([]);
  });

  it('剥掉代码块围栏', () => {
    expect(parseSummary('```json\n{"summary":"只有一句话。"}\n```').summary).toBe('只有一句话。');
    expect(parseSummary('```\n秦娘没接话。\n```').summary).toBe('秦娘没接话。');
  });

  it('空回答得到空摘要，而不是一句假的概述', () => {
    expect(parseSummary('   ').summary).toBe('');
  });
});

describe('触发条件', () => {
  it('只算这一场里、游标之后的消息', () => {
    const pending = pendingSummary(scene({ recapUpToSeq: 2 }), [
      line({ seq: 1, turnId: 't1', content: '旧的一轮' }),
      line({ seq: 2, turnId: 't1', content: '旧的一轮' }),
      line({ seq: 3, turnId: 't2', content: '新的一轮' }),
      line({ seq: 4, turnId: 't2', content: '新的一轮' }),
      line({ seq: 5, turnId: 't3', content: '别的场景', sceneIdValue: 'scene-2' }),
    ]);

    expect(pending.messages.map((message) => message.seq)).toEqual([3, 4]);
    expect(pending.turns).toBe(1);
  });

  it('攒够轮数就压一次', () => {
    const messages = Array.from({ length: SUMMARY_TURN_THRESHOLD }, (_value, index) =>
      line({ seq: index + 1, turnId: `t${String(index + 1)}`, content: '一句话。' }),
    );

    expect(shouldSummarizeScene(scene(), messages)).toBe(true);
    expect(shouldSummarizeScene(scene(), messages.slice(0, SUMMARY_TURN_THRESHOLD - 1))).toBe(false);
  });

  it('轮数不够但 token 超了也压一次（长回合不能等）', () => {
    // 全角字符按 1 字符 ≈ 1 token 估，下面这条约 3200 token，超过默认阈值
    const chunk = '很长的一段叙述。'.repeat(400);
    const messages = [line({ seq: 1, turnId: 't1', content: chunk })];
    expect(shouldSummarizeScene(scene(), messages)).toBe(true);
    expect(shouldSummarizeScene(scene(), messages, { tokenThreshold: 100_000 })).toBe(false);
  });

  it('没有新内容就不压（幂等：重跑不会把同一段压两遍）', () => {
    const messages = [line({ seq: 1, turnId: 't1', content: '一句话。' })];
    expect(shouldSummarizeScene(scene({ recapUpToSeq: 1 }), messages)).toBe(false);
    expect(shouldSummarizeScene(scene(), [])).toBe(false);
  });
});

describe('章节候选', () => {
  it('只收已经有场记的场景，且要攒够阈值', () => {
    const scenes = [
      scene({ id: sceneId('s1'), recap: '第一场', createdAt: '2026-09-19T00:00:00.000Z' }),
      scene({ id: sceneId('s2'), recap: '第二场', createdAt: '2026-09-19T01:00:00.000Z' }),
      scene({ id: sceneId('s3'), recap: '', createdAt: '2026-09-19T02:00:00.000Z' }),
    ];

    expect(chapterCandidates({ scenes, coveredSceneIds: [] }).scenes).toEqual([]);

    scenes[2] = scene({ id: sceneId('s3'), recap: '第三场', createdAt: '2026-09-19T02:00:00.000Z' });
    const ready = chapterCandidates({ scenes, coveredSceneIds: [] });
    expect(ready.scenes.map((item) => item.id)).toEqual(['s1', 's2', 's3']);
    expect(CHAPTER_SCENE_THRESHOLD).toBe(3);
  });

  it('已经滚过的场景不再收，按时间正序排', () => {
    const scenes = [
      scene({ id: sceneId('s2'), recap: '第二场', createdAt: '2026-09-19T01:00:00.000Z' }),
      scene({ id: sceneId('s1'), recap: '第一场', createdAt: '2026-09-19T00:00:00.000Z' }),
      scene({ id: sceneId('s3'), recap: '第三场', createdAt: '2026-09-19T02:00:00.000Z' }),
      scene({ id: sceneId('s4'), recap: '第四场', createdAt: '2026-09-19T03:00:00.000Z' }),
    ];

    // 阈值降到 2：这一批只剩两场没滚过，正好够开新的一章
    const ready = chapterCandidates({
      scenes,
      coveredSceneIds: [sceneId('s1'), sceneId('s2')],
      threshold: 2,
    });
    expect(ready.scenes.map((item) => item.id)).toEqual(['s3', 's4']);
    expect(ready.lastChapterSceneId).toBe('s2');
  });
});

describe('章节摘要提示词', () => {
  it('把每场戏的标题、地点与摘要都带上', () => {
    const messages = buildChapterSummaryMessages({
      title: '旧城的第一夜',
      playerName: '旅人',
      scenes: [
        { title: '雨夜', location: '旧城酒馆', summary: '玩家问起三十箱货。' },
        { title: '栅门外', location: '胡记栅门', summary: '两人在门外等到天亮。' },
      ],
    });

    const body = messages.map((message) => message.content).join('\n');
    expect(body).toContain('旧城的第一夜');
    expect(body).toContain('雨夜（旧城酒馆）');
    expect(body).toContain('玩家问起三十箱货。');
    expect(body).toContain('两人在门外等到天亮。');
    expect(body).toContain('谁和谁的关系变了');
  });
});
