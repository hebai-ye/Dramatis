import { describe, expect, it } from 'vitest';
import { buildAdminMessages } from '../admin/prompt.js';
import { ADMIN_TOOLS, parseAdminToolCall } from '../admin/tools.js';
import { buildAffectMessages, parseAffectUpdates } from '../memory/affect.js';
import { buildExtractionMessages, parseExtraction } from '../memory/extract.js';
import type { Card } from '../model/card.js';
import { createConversation } from '../model/conversation.js';
import { cardId, instanceId, newId, nowIso, PLAYER, roomId, sceneId } from '../model/ids.js';
import { type CharacterInstance, neutralTraits } from '../model/instance.js';
import type { Room, Scene } from '../model/room.js';
import { assemblePrompt } from '../prompt/assemble.js';
import { renderMessageContent } from '../render/segments.js';
import { createCharacterMessage, createPlayerMessage } from '../session/turn.js';

/**
 * 真实模型验证的取样器（ROADMAP P1-10 的人工部分）。
 *
 * 把**代码真正会发出去**的四条提示词原样打印出来，供人工贴进任意网页版
 * 模型里看一眼输出形态。手写一份「差不多的提示词」去验证是没有意义的——
 * 出问题的地方往往正是装配器加进去的那几行。
 *
 * 跑法：
 *   pnpm --filter @dramatis/core test prompt-samples --silent=false
 */

function card(name: string, overrides: Partial<Card> = {}): Card {
  return {
    id: cardId(newId()),
    name,
    nickname: '',
    description: `${name} 的描述`,
    personality: '',
    scenario: '',
    firstMessage: '',
    alternateGreetings: [],
    exampleMessages: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creator: '',
    creatorNotes: '',
    characterVersion: '',
    tags: [],
    embeddedWorldBook: null,
    extensions: {},
    source: { kind: 'manual', spec: 'dramatis', specVersion: '1', importedAt: nowIso() },
    ...overrides,
    createdAt: overrides.createdAt ?? nowIso(),
    updatedAt: overrides.updatedAt ?? nowIso(),
    deletedAt: overrides.deletedAt ?? null,
  };
}

function fixture() {
  const now = nowIso();
  const roomIdValue = roomId(newId());
  const sceneIdValue = sceneId(newId());

  const aliceCard = card('Alice', {
    description: '酒馆的常客，二十五六岁，白天在旧城的书铺里做活。',
    personality: '安静、警惕，话少但对熟人很实在',
    exampleMessages: '「……」\n# 她把手里的杯子转了半圈，没有看他。\n「你要是非问不可，那我告诉你。」',
  });
  const bobCard = card('Bob', {
    description: '走南闯北的行商，四十岁上下，嗓门大，爱打听也爱说。',
    personality: '热情、话多、藏不住事',
  });

  const room: Room = {
    id: roomIdValue,
    title: '雨夜酒馆',
    personaId: null,
    playerName: '旅人',
    playerPersona: '独自赶路的旅人，背着一把旧剑。',
    cardIds: [aliceCard.id, bobCard.id],
    instanceIds: [],
    worldBookIds: [],
    activeConversationId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  const makeInstance = (source: Card, displayName: string): CharacterInstance => ({
    id: instanceId(newId()),
    roomId: roomIdValue,
    cardId: source.id,
    displayName,
    presence: 'onstage',
    traits: { ...neutralTraits(), extroversion: displayName === 'Bob' ? 0.6 : -0.3 },
    affect: { valence: 0.1, arousal: 0.3, updatedAt: now, history: [] },
    relationships: [
      {
        target: PLAYER,
        trust: displayName === 'Bob' ? 0.2 : 0.4,
        affinity: 0.1,
        fear: 0,
        respect: 0.3,
        tension: displayName === 'Alice' ? 0.5 : 0.1,
        updatedAt: now,
        history: [],
      },
    ],
    traitsLocked: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });

  const alice = makeInstance(aliceCard, 'Alice');
  const bob = makeInstance(bobCard, 'Bob');
  room.instanceIds = [alice.id, bob.id];

  const scene: Scene = {
    id: sceneIdValue,
    roomId: roomIdValue,
    conversationId: null,
    title: '雨夜',
    location: '旧城东侧的夜间酒馆',
    worldTime: '第三日 · 黄昏',
    castPolicy: 'locked',
    cast: [alice.id, bob.id],
    summary: '雨下了一整天，酒馆里只剩下几个躲雨的人。',
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    deletedAt: null,
  };

  const turnId = newId();
  const history = [
    createPlayerMessage({
      roomId: roomIdValue,
      sceneId: scene.id,
      turnId,
      speakerName: room.playerName,
      content: '听说北边那支商队失踪了，你们知道些什么？',
      audience: scene.cast,
    }),
    createCharacterMessage({
      roomId: roomIdValue,
      sceneId: scene.id,
      turnId,
      speakerInstanceId: alice.id,
      speakerName: 'Alice',
      content: '……我不太想聊这个。\n# 她把杯子往桌上放，手指在杯沿上停了一会儿。',
      audience: scene.cast,
    }),
    createCharacterMessage({
      roomId: roomIdValue,
      sceneId: scene.id,
      turnId,
      speakerInstanceId: bob.id,
      speakerName: 'Bob',
      content: '她上个月还托那支商队捎过一封信，你问她。',
      audience: scene.cast,
    }),
  ];

  return { room, scene, alice, bob, aliceCard, bobCard, history, now };
}

function printBlock(title: string, lines: readonly string[]): void {
  const rule = '='.repeat(72);
  console.log(`\n${rule}\n${title}\n${rule}\n${lines.join('\n')}\n`);
}

describe('真实模型验证取样器', () => {
  it('打印四条提示词，供贴进网页版模型人工看输出', () => {
    const { room, scene, alice, bob, aliceCard, bobCard, history } = fixture();

    // ---- 1. 主对话：角色扮演回合 ----
    const playerInput = '那你呢，Bob？你那封信写给谁的？';
    // 注意：历史里**不含**这一轮的玩家输入。装配器会把它单独作为最后一条
    // user 消息放进去，这里多塞一条就会让同一句话说两遍——真实流程不是这样。
    const roleplay = assemblePrompt({
      card: bobCard,
      instance: bob,
      room,
      scene,
      cast: [alice, bob],
      history,
      playerInput,
      memories: [
        {
          id: 'memory-1',
          summary: '玩家在酒馆里打听一支失踪的商队。',
          perception: 'Bob 觉得这事有意思，而且他正好知道一点内情。',
          score: 0.82,
          worldTime: '第三日 · 黄昏',
        },
      ],
      modes: { playerFirst: false, silent: false },
      budget: { maxTokens: 16384, reserveForReply: 1024 },
    });

    printBlock(
      '① 主对话 · 角色扮演（发给模型的消息，按顺序）',
      roleplay.messages.map((message) => `--- role: ${message.role} ---\n${message.content}`),
    );

    // ---- 2. 记忆抽取 ----
    const extractionMessages = buildExtractionMessages({
      scene,
      cast: [alice, bob],
      playerName: room.playerName,
      messages: history,
    });
    printBlock(
      '② 记忆抽取（后台任务）',
      extractionMessages.map((message) => `--- role: ${message.role} ---\n${message.content}`),
    );

    // ---- 3. 情绪与关系推演 ----
    const affectMessages = buildAffectMessages({
      cast: [alice, bob],
      playerName: room.playerName,
      messages: history,
    });
    printBlock(
      '③ 情绪与关系推演（后台任务）',
      affectMessages.map((message) => `--- role: ${message.role} ---\n${message.content}`),
    );

    // ---- 4. 副对话：世界管理员 ----
    const conversation = createConversation({ roomId: room.id, title: '世界管理', kind: 'side' });
    const adminMessages = buildAdminMessages({
      room,
      conversation,
      scene,
      instances: [alice, bob],
      cards: [aliceCard, bobCard],
      worldBooks: [
        {
          id: newId() as never,
          name: '旧城设定',
          entries: [
            {
              id: newId(),
              title: '旧城',
              keys: ['旧城'],
              secondaryKeys: [],
              content: '旧城分东西两半，中间隔着一条河。',
              constant: false,
              selective: true,
              selectiveLogic: 0,
              order: 100,
              position: 'before_char',
              depth: 4,
              probability: 100,
              useProbability: true,
              disabled: false,
              caseSensitive: false,
              matchWholeWords: false,
              scanDepth: null,
              preventRecursion: true,
              excludeRecursion: false,
              group: '',
              extensions: {},
            },
          ],
          extensions: {},
          createdAt: nowIso(),
          updatedAt: nowIso(),
          deletedAt: null,
        },
      ],
      personas: [],
      history: [
        {
          id: newId() as never,
          roomId: room.id,
          conversationId: conversation.id,
          sceneId: null,
          turnId: newId(),
          localSeq: 1,
          deviceId: '',
          role: 'player',
          speakerInstanceId: null,
          speakerName: room.playerName,
          audience: [],
          content: '帮我给这个旧城补一点设定，再起草一个能在酒馆里遇到的角色。',
          createdAt: nowIso(),
          updatedAt: nowIso(),
          deletedAt: null,
        },
      ],
      userInput: '顺便把当前场景的地点改成「旧城东侧的夜间酒馆」，时间是第三日 · 黄昏。',
    });

    printBlock('④ 副对话 · 世界管理员（含工具声明）', [
      ...adminMessages.map((message) => `--- role: ${message.role} ---\n${message.content}`),
      '--- 可用工具（tools 字段）---',
      JSON.stringify(ADMIN_TOOLS, null, 2),
    ]);

    // 取样器不判定质量，只保证这几条真的装得出来
    expect(roleplay.report.fits).toBe(true);
    expect(roleplay.messages.length).toBeGreaterThan(3);
    expect(extractionMessages).toHaveLength(2);
    expect(affectMessages).toHaveLength(2);
    expect(adminMessages.length).toBeGreaterThan(2);
  });

  /**
   * 把真实模型的回答贴回这里，确认解析器吃得下。
   *
   * 回答记录在 `real-model-responses.ts`（同一目录）。这一步把「模型的输出
   * 能不能被解析」变成可重跑的断言：改了提示词就重跑一次、贴回新的输出。
   */
  it('真实回答能被解析器吃下（回答为空时跳过）', () => {
    const responses = REAL_MODEL_RESPONSES;
    if (responses.extraction === '') {
      console.log('\n（还没有记录真实模型的回答，跳过解析校验）\n');
      return;
    }

    const extraction = parseExtraction(responses.extraction);
    expect(extraction.summary.length).toBeGreaterThan(0);
    expect(extraction.observations.length).toBeGreaterThan(0);

    const updates = parseAffectUpdates(responses.affect);
    expect(updates.length).toBeGreaterThan(0);
    // 只该出现被触动的角色，且变化量都在抗漂移的上限之内
    for (const update of updates) {
      expect(Math.abs(update.deltaValence)).toBeLessThanOrEqual(0.3);
      expect(Math.abs(update.deltaArousal)).toBeLessThanOrEqual(0.3);
      for (const edge of update.relationship) {
        expect(Math.abs(edge.delta)).toBeLessThanOrEqual(0.3);
      }
    }

    for (const [index, toolCall] of responses.toolCalls.entries()) {
      const parsed = parseAdminToolCall({
        id: `manual-check-${String(index)}`,
        type: 'function',
        // 接口里 arguments 是序列化后的字符串，这里照同样的形状喂进去
        function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
      });
      if (!parsed.ok) throw new Error(`${toolCall.name} 没被接受：${parsed.error}`);
      expect(parsed.ok).toBe(true);
    }

    const segments = renderMessageContent(responses.roleplay);
    // 动作必须与对白分开：全挤进气泡就说明 `#` 约定没被遵守
    expect(segments.filter((segment) => segment.kind === 'action').length).toBeGreaterThan(0);
    expect(segments.filter((segment) => segment.kind === 'speech').length).toBeGreaterThan(0);
    // 不许替别人发言：输出里不该出现别名开头的一行
    expect(responses.roleplay).not.toMatch(/^(Alice|旅人)[:：]/m);
  });
});

import { REAL_MODEL_RESPONSES } from './real-model-responses.js';
