import type { CharacterInstance } from '../model/instance.js';
import type { Message } from '../model/message.js';
import type { Scene } from '../model/room.js';
import type { ChatMessage } from '../prompt/types.js';
import { type ExtractedMemory, MemoryExtractionError, type RawObservation } from './types.js';

const SYSTEM_PROMPT = [
  '你是一个叙事记录员。阅读刚发生的一段对话，然后只输出一个 JSON 对象。',
  '不要写解释，不要写代码块标记，除了那个 JSON 对象什么都不要输出。',
].join('\n');

const FORMAT_HINT = [
  '输出格式：',
  '{"summary":"客观经过，一到三句","importance":0.6,"location":"","observations":[{"speaker":"角色名","perception":"他的印象"}]}',
].join('\n');

const FIELD_GUIDE = [
  '字段要求：',
  '- summary：客观描述发生了什么，一到三句，不要写角色的内心。',
  '- importance：0 到 1。改变了关系、暴露了秘密、推进了情节的，给高分；寒暄与日常给低分。',
  '- location：只有对话里明确发生了地点变化时才填，否则留空字符串。',
  '- observations：为每个在场角色各写一条，描述他在这个视角下注意到了什么、',
  '  误解了什么、在意什么。同一件事在不同角色眼里应当有差异，允许互相矛盾。',
  '  没有明显反应的角色可以省略。speaker 必须用上面给出的角色名。',
].join('\n');

export interface ExtractionInput {
  scene: Scene | null;
  /** 抽取时的在场角色。 */
  cast: readonly CharacterInstance[];
  playerName: string;
  /** 本回合的消息，按时间正序。 */
  messages: readonly Message[];
}

function renderConversation(input: ExtractionInput): string {
  return input.messages
    .map((message) => `${message.speakerName}：${message.content.replace(/\s*\n\s*/g, ' ')}`)
    .join('\n');
}

export function buildExtractionMessages(input: ExtractionInput): ChatMessage[] {
  const scene = input.scene;
  const context = [
    `地点：${scene?.location.trim() === '' || scene === null ? '未指定' : scene.location.trim()}`,
    `时间：${scene?.worldTime.trim() === '' || scene === null ? '未指定' : scene.worldTime.trim()}`,
    `玩家扮演：${input.playerName}`,
    `在场角色：${input.cast.map((member) => member.displayName).join('、')}`,
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [context, '', '对话：', renderConversation(input), '', FIELD_GUIDE, '', FORMAT_HINT].join('\n'),
    },
  ];
}

/**
 * 从模型输出里抠出第一个完整的 JSON 对象。
 *
 * 模型经常会加一句「好的，这是记录」，或者用 ```json 包起来，
 * 所以不能直接 JSON.parse。这里按花括号配对扫描，并且正确跳过字符串内的括号。
 */
export function extractJsonObject(text: string): unknown {
  const cleaned = text.replace(/```[a-zA-Z]*/g, '');
  const start = cleaned.indexOf('{');
  if (start === -1) {
    throw new MemoryExtractionError('模型输出里没有找到 JSON 对象');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < cleaned.length; index += 1) {
    const char = cleaned[index] ?? '';

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth !== 0) continue;

      const slice = cleaned.slice(start, index + 1);
      try {
        return JSON.parse(slice) as unknown;
      } catch (error) {
        throw new MemoryExtractionError(`JSON 解析失败：${(error as Error).message}`);
      }
    }
  }

  throw new MemoryExtractionError('模型输出里的 JSON 对象没有闭合');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function parseObservations(value: unknown): RawObservation[] {
  if (!Array.isArray(value)) return [];

  const observations: RawObservation[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;

    const speaker = typeof record.speaker === 'string' ? record.speaker.trim() : '';
    const perception = typeof record.perception === 'string' ? record.perception.trim() : '';
    if (speaker === '' || perception === '') continue;

    observations.push({ speaker, perception });
  }
  return observations;
}

/**
 * 解析抽取结果。
 *
 * 对缺字段宽容、对摘要严格：摘要为空说明这次抽取没有产出可用内容，
 * 与其写入一条空洞的记忆，不如让它失败并重试。
 */
export function parseExtraction(raw: string): ExtractedMemory {
  const record = asRecord(extractJsonObject(raw));
  if (!record) {
    throw new MemoryExtractionError('抽取结果不是 JSON 对象');
  }

  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  if (summary === '') {
    throw new MemoryExtractionError('抽取结果里没有 summary');
  }

  const rawImportance = typeof record.importance === 'number' ? record.importance : 0.4;

  return {
    summary,
    importance: clamp01(Number.isFinite(rawImportance) ? rawImportance : 0.4),
    location: typeof record.location === 'string' ? record.location.trim() : '',
    observations: parseObservations(record.observations),
  };
}
