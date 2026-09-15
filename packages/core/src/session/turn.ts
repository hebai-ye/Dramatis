import type { Card } from '../model/card.js';
import { messageId, newId, nowIso, type InstanceId, type RoomId, type SceneId } from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import type { Message } from '../model/message.js';
import type { Room, Scene } from '../model/room.js';
import { assemblePrompt, type AssembleInput, type AssembledPrompt } from '../prompt/assemble.js';
import type { ModelParams, ModelProvider } from '../provider/openai-compatible.js';

export type TurnEvent =
  | { type: 'prompt'; prompt: AssembledPrompt }
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'done'; text: string };

export interface RunTurnOptions {
  params?: ModelParams;
  signal?: AbortSignal;
  /** 装配完成后立刻回调，便于 UI 展示本次用了多少 token、丢掉了什么。 */
  onPrompt?: (prompt: AssembledPrompt) => void;
}

export function createTurnId(): string {
  return newId();
}

export function createPlayerMessage(input: {
  roomId: RoomId;
  sceneId: SceneId | null;
  turnId: string;
  speakerName: string;
  content: string;
}): Message {
  return {
    id: messageId(newId()),
    roomId: input.roomId,
    sceneId: input.sceneId,
    turnId: input.turnId,
    role: 'player',
    speakerInstanceId: null,
    speakerName: input.speakerName,
    content: input.content,
    createdAt: nowIso(),
  };
}

export function createCharacterMessage(input: {
  roomId: RoomId;
  sceneId: SceneId | null;
  turnId: string;
  speakerInstanceId: InstanceId;
  speakerName: string;
  content: string;
}): Message {
  return {
    id: messageId(newId()),
    roomId: input.roomId,
    sceneId: input.sceneId,
    turnId: input.turnId,
    role: 'character',
    speakerInstanceId: input.speakerInstanceId,
    speakerName: input.speakerName,
    content: input.content,
    createdAt: nowIso(),
  };
}

/** 用角色卡的开场白生成第一条消息，进入房间时立即可见。 */
export function createGreetingMessage(input: {
  card: Card;
  instance: CharacterInstance;
  room: Room;
  scene: Scene | null;
  /** 选择第几条开场白，0 为主开场白。 */
  greetingIndex?: number;
}): Message | null {
  const greetings = [input.card.firstMessage, ...input.card.alternateGreetings];
  const greeting = greetings[input.greetingIndex ?? 0] ?? input.card.firstMessage;
  if (greeting.trim() === '') return null;

  return createCharacterMessage({
    roomId: input.room.id,
    sceneId: input.scene?.id ?? null,
    turnId: createTurnId(),
    speakerInstanceId: input.instance.id,
    speakerName: input.instance.displayName,
    content: greeting.trim(),
  });
}

/**
 * 跑一个回合：装配 prompt → 调用模型 → 流式产出。
 *
 * M0 是单人对话，发言调度（设计文档 §3）在 M1 接入；
 * 这里保留多发言者也能复用的流式事件结构。
 */
export async function* runTurn(
  input: AssembleInput,
  provider: ModelProvider,
  options: RunTurnOptions = {},
): AsyncIterable<TurnEvent> {
  const prompt = assemblePrompt(input);
  options.onPrompt?.(prompt);
  yield { type: 'prompt', prompt };

  let full = '';
  let done = false;

  for await (const event of provider.chat(prompt.messages, options.params ?? {}, options.signal)) {
    switch (event.type) {
      case 'reasoning':
        yield { type: 'reasoning', text: event.text };
        break;
      case 'text':
        full += event.text;
        yield { type: 'text', text: event.text };
        break;
      case 'done':
        done = true;
        yield { type: 'done', text: full };
        break;
    }
  }

  if (!done) {
    yield { type: 'done', text: full };
  }
}
