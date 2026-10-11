import { buildAdminMessages } from '../../../../packages/core/src/admin/prompt';
import { ADMIN_TOOLS } from '../../../../packages/core/src/admin/tools';
import { buildAffectMessages } from '../../../../packages/core/src/memory/affect';
import { buildExtractionMessages } from '../../../../packages/core/src/memory/extract';
import type { Card } from '../../../../packages/core/src/model/card';
import type { Conversation } from '../../../../packages/core/src/model/conversation';
import {
  cardId,
  conversationId,
  instanceId,
  messageId,
  PLAYER,
  roomId,
  sceneId,
} from '../../../../packages/core/src/model/ids';
import type { CharacterInstance } from '../../../../packages/core/src/model/instance';
import type { Message } from '../../../../packages/core/src/model/message';
import type { Room, Scene } from '../../../../packages/core/src/model/room';
import { assemblePrompt } from '../../../../packages/core/src/prompt/assemble';

export const FIXED_TIME = '2026-10-03T00:00:00.000Z';
const timestamps = { createdAt: FIXED_TIME, updatedAt: FIXED_TIME, deletedAt: null };
export const PARAMS = {
  model: 'deepseek-flash',
  reasoning_effort: 'low',
  thinking: { type: 'enabled' },
  max_tokens: 1200,
};
export function makeCases(adminBuilder = buildAdminMessages, adminTools = ADMIN_TOOLS) {
  const card: Card = {
    id: cardId('quality-card-alice'),
    name: 'Alice',
    nickname: '',
    description: '在旧城书铺工作，夜里常来酒馆。上个月托商队给姐姐送过一封信。',
    personality: '话少，对熟人实在，不愿主动谈家事。',
    creator: '',
    characterVersion: '1',
    tags: [],
    embeddedWorldBook: null,
    extensions: {},
    source: { kind: 'manual', spec: 'dramatis', specVersion: '1', importedAt: FIXED_TIME },
    ...timestamps,
  };
  const instance: CharacterInstance = {
    id: instanceId('quality-instance-alice'),
    roomId: roomId('quality-room'),
    cardId: card.id,
    displayName: 'Alice',
    presence: 'onstage',
    traits: { extroversion: -0.3, aggression: 0, empathy: 0.3, playfulness: 0, caution: 0.3 },
    affect: { valence: 0.1, arousal: 0.3, updatedAt: FIXED_TIME, history: [] },
    relationships: [
      {
        target: PLAYER,
        trust: 0.4,
        affinity: 0.4,
        fear: 0,
        respect: 0.2,
        tension: 0.1,
        updatedAt: FIXED_TIME,
        history: [],
      },
    ],
    traitsLocked: false,
    ...timestamps,
  };
  const room: Room = {
    id: roomId('quality-room'),
    title: '雨夜酒馆',
    personaId: null,
    playerName: '旅人',
    playerPersona: '独自赶路，背着旧剑。',
    cardIds: [card.id],
    instanceIds: [instance.id],
    worldBookIds: [],
    activeConversationId: null,
    ...timestamps,
  };
  const scene: Scene = {
    id: sceneId('quality-scene'),
    roomId: room.id,
    conversationId: null,
    title: '雨夜',
    location: '旧城酒馆',
    worldTime: '第三日 · 黄昏',
    castPolicy: 'locked',
    cast: [instance.id],
    summary: '雨下了一整天。',
    endedAt: null,
    ...timestamps,
  };
  const conversation = {
    id: conversationId('quality-admin'),
    roomId: room.id,
    title: '世界管理',
    kind: 'side',
    ...timestamps,
  } as Conversation;
  const scenarios = [
    {
      label: '信件与边界',
      player: '商队出事前，有没有把你的信送到？',
      reply: '只知道他们到了北门。# 她把杯子放下。别问信里写了什么。',
      next: '好，不问信。北门是谁看见他们的？',
    },
    {
      label: '缓和与记忆',
      player: '我把你借我的蓝伞带回来了，伞柄也修好了。',
      reply: '……还真修好了。# 她转了转伞柄。搁这儿吧，坐会儿。',
      next: '你上次说伞是谁送你的来着？',
    },
    {
      label: '冲突与地点',
      player: '你把消息瞒了我三天。我们到门外说清楚。',
      reply: '# 她起身走到酒馆门外。不是瞒你，我昨天才知道。',
      next: '那把你确实知道的说给我听。',
    },
  ];
  return scenarios.flatMap((s, i) => {
    const history: Message[] = [
      {
        id: messageId(`quality-message-${i}-player`),
        roomId: room.id,
        conversationId: null,
        sceneId: scene.id,
        turnId: `quality-turn-${i}`,
        localSeq: 1,
        deviceId: 'quality-device',
        role: 'player',
        speakerInstanceId: null,
        speakerName: room.playerName,
        audience: [instance.id],
        content: s.player,
        ...timestamps,
      },
      {
        id: messageId(`quality-message-${i}-alice`),
        roomId: room.id,
        conversationId: null,
        sceneId: scene.id,
        turnId: `quality-turn-${i}`,
        localSeq: 2,
        deviceId: 'quality-device',
        role: 'character',
        speakerInstanceId: instance.id,
        speakerName: 'Alice',
        audience: [instance.id],
        content: s.reply,
        ...timestamps,
      },
    ];
    const base = { room, scene, card, instance, history, playerInput: s.next };
    const roleplayInput = {
      ...base,
      cast: [instance],
      memories: [],
      modes: { playerFirst: false, silent: false },
      budget: { maxTokens: 16384, reserveForReply: 1200 },
    };
    const extractionInput = { scene, cast: [instance], playerName: room.playerName, messages: history };
    const affectInput = { cast: [instance], playerName: room.playerName, messages: history };
    const adminInput = {
      room,
      scene,
      conversation,
      instances: [instance],
      cards: [card],
      worldBooks: [],
      personas: [],
      history: [],
      userInput:
        [
          '给 Alice 的角色卡补一个怕火的小习惯，保留原有经历与性格；不要替我推进剧情。',
          '起草旧城世界书，包含北门、书铺、酒馆三个条目。每条写触发词和具体设定。',
          '把当前场景地点改为旧城北门，时间改为第三日深夜；其他场景信息保持原样。',
        ][i] ?? '',
    };
    const requests = [
      {
        family: 'roleplay' as const,
        input: roleplayInput,
        messages: assemblePrompt(roleplayInput).messages,
        tools: [],
      },
      {
        family: 'extraction' as const,
        input: extractionInput,
        messages: buildExtractionMessages(extractionInput),
        tools: [],
      },
      { family: 'affect' as const, input: affectInput, messages: buildAffectMessages(affectInput), tools: [] },
      { family: 'admin' as const, input: adminInput, messages: adminBuilder(adminInput), tools: adminTools },
    ];
    return requests.map(({ family, input, messages, tools }) => ({
      caseId: `${family}-${i + 1}`,
      family,
      label: s.label,
      input,
      request: { messages, tools, params: PARAMS },
    }));
  });
}
