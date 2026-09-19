import { describe, it } from 'vitest';
import { buildExtractionMessages } from '../memory/extract.js';
import type { Card } from '../model/card.js';
import { cardId, instanceId, newId, nowIso, roomId, sceneId } from '../model/ids.js';
import { type CharacterInstance, neutralTraits } from '../model/instance.js';
import type { Room, Scene } from '../model/room.js';
import { createCharacterMessage, createPlayerMessage } from '../session/turn.js';

/**
 * 打印真实的抽取提示词。
 *
 * 存在的理由：真实模型的输出质量没法用单元测试覆盖，只能人工验证。
 * 这个用例把提示词原样打出来，直接复制到任意模型里跑一次，就能知道
 * 它能不能稳定吐出合法 JSON。提示词一改，这里输出就跟着变，
 * docs/EVAL.md 里的副本也据此更新。
 */
function card(name: string): Card {
  return {
    id: cardId(newId()),
    name,
    nickname: '',
    description: '',
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
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
  };
}

function instance(source: Card, room: Room, name: string): CharacterInstance {
  const now = nowIso();
  return {
    id: instanceId(newId()),
    roomId: room.id,
    cardId: source.id,
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

describe('抽取提示词参考', () => {
  it('打印一段样例对话对应的完整提示词', () => {
    const roomIdValue = roomId(newId());
    const sceneIdValue = sceneId(newId());
    const now = nowIso();

    const aliceCard = card('Alice');
    const bobCard = card('Bob');

    const room: Room = {
      id: roomIdValue,
      title: '样例',
      personaId: null,
      playerName: '旅人',
      playerPersona: '',
      cardIds: [aliceCard.id, bobCard.id],
      instanceIds: [],
      worldBookIds: [],
      activeConversationId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    const alice = instance(aliceCard, room, 'Alice');
    const bob = instance(bobCard, room, 'Bob');

    const scene: Scene = {
      id: sceneIdValue,
      roomId: roomIdValue,
      conversationId: null,
      title: '雨夜',
      location: '旧城东侧的酒馆',
      worldTime: '第三日 · 黄昏',
      castPolicy: 'locked',
      cast: [alice.id, bob.id],
      summary: '',
      createdAt: now,
      updatedAt: now,
      endedAt: null,
      deletedAt: null,
    };

    const turnId = newId();
    const messages = [
      createPlayerMessage({
        roomId: roomIdValue,
        sceneId: scene.id,
        turnId,
        speakerName: '旅人',
        content: '听说北边那支商队失踪了，你们知道些什么？',
        audience: scene.cast,
      }),
      createCharacterMessage({
        roomId: roomIdValue,
        sceneId: scene.id,
        turnId,
        speakerInstanceId: alice.id,
        speakerName: 'Alice',
        content: '……我不太想聊这个。',
        audience: scene.cast,
      }),
      createCharacterMessage({
        roomId: roomIdValue,
        sceneId: scene.id,
        turnId,
        speakerInstanceId: bob.id,
        speakerName: 'Bob',
        content: '她上个月还托那支商队捎过一封信。',
        audience: scene.cast,
      }),
    ];

    const prompt = buildExtractionMessages({
      scene,
      cast: [alice, bob],
      playerName: room.playerName,
      messages,
    });

    console.log(
      [
        '===== 复制以下内容到模型 =====',
        `【system】\n${prompt[0]?.content ?? ''}`,
        `【user】\n${prompt[1]?.content ?? ''}`,
        '===== 复制结束 =====',
      ].join('\n\n'),
    );
  });
});
