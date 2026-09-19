import { describe, expect, it } from 'vitest';
import { instanceId, newId, nowIso, roomId, sceneId } from '../model/ids.js';
import { type CharacterInstance, neutralTraits } from '../model/instance.js';
import type { Scene } from '../model/room.js';
import { createPlayerMessage } from '../session/turn.js';
import { parseAffectUpdates } from './affect.js';
import { parseExtraction } from './extract.js';
import { buildTurnAnalysisMessages, parseTurnAnalysis } from './turn-analysis.js';

function actor(name: string): CharacterInstance {
  const now = nowIso();
  return {
    id: instanceId(newId()),
    roomId: roomId(newId()),
    cardId: newId() as never,
    displayName: name,
    presence: 'onstage',
    traits: neutralTraits(),
    affect: { valence: 0, arousal: 0, updatedAt: now, history: [] },
    relationships: [],
    traitsLocked: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

const scene: Scene = {
  id: sceneId(newId()),
  roomId: roomId(newId()),
  conversationId: null,
  title: '雨夜',
  location: '旧城东侧的夜间酒馆',
  worldTime: '第三日 · 黄昏',
  castPolicy: 'locked',
  cast: [],
  summary: '',
  createdAt: nowIso(),
  updatedAt: nowIso(),
  endedAt: null,
  deletedAt: null,
};

const roomIdValue = scene.roomId;
const messages = [
  createPlayerMessage({
    roomId: roomIdValue,
    sceneId: scene.id,
    turnId: newId(),
    speakerName: '旅人',
    content: '那三十箱货是谁点过数的？',
    audience: [],
  }),
];

describe('buildTurnAnalysisMessages', () => {
  it('一份提示词里同时要记忆与状态变化', () => {
    const built = buildTurnAnalysisMessages({
      scene,
      cast: [actor('秦娘'), actor('陈九')],
      playerName: '旅人',
      messages,
    });

    const body = built.map((message) => message.content).join('\n');
    expect(body).toContain('在场角色：秦娘、陈九');
    expect(body).toContain('summary');
    expect(body).toContain('observations');
    expect(body).toContain('updates');
    expect(body).toContain('deltaValence');
  });
});

describe('parseTurnAnalysis', () => {
  const merged =
    '{"summary":"玩家追问三十箱货的来历，陈九承认他点过数。","importance":0.7,"location":"",' +
    '"observations":[{"speaker":"陈九","perception":"被问到时心里一紧。"},' +
    '{"speaker":"秦娘","perception":"注意到陈九答得太快。"}],' +
    '"updates":[{"observer":"陈九","deltaValence":-0.1,"deltaArousal":0.2,"reason":"被追问到痛处",' +
    '"relationship":[{"field":"trust","delta":-0.05}]}]}';

  it('合并形状：一份 JSON 拆成记忆与状态变化', () => {
    const result = parseTurnAnalysis(merged);

    expect(result.extraction.summary).toContain('三十箱');
    expect(result.extraction.observations).toHaveLength(2);
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]?.observer).toBe('陈九');
    expect(result.updates[0]?.relationship[0]?.field).toBe('trust');
  });

  it('嵌套形状（memory / affect 分开）也吃得下', () => {
    const nested = `{"memory":${merged},"affect":{"updates":[{"observer":"陈九","deltaValence":-0.1}]}}`;
    const result = parseTurnAnalysis(nested);

    expect(result.extraction.summary).toContain('三十箱');
    expect(result.updates[0]?.observer).toBe('陈九');
  });

  it('模型只写了记忆、没写状态变化时，状态变化为空而不是整轮作废', () => {
    const onlyMemory = '{"summary":"玩家问了个问题。","importance":0.3,"observations":[]}';
    const result = parseTurnAnalysis(onlyMemory);

    expect(result.extraction.summary).toBe('玩家问了个问题。');
    expect(result.updates).toEqual([]);
  });

  it('带代码块与前后废话时的容错与单件解析器一致', () => {
    const wrapped = `好的，这是记录：\n\`\`\`json\n${merged}\n\`\`\`\n希望有用。`;
    const result = parseTurnAnalysis(wrapped);

    expect(result.extraction.summary).toBe(parseExtraction(wrapped).summary);
    expect(result.updates).toHaveLength(parseAffectUpdates(wrapped).length);
  });
});
