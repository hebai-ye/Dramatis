import type { Conversation } from '../model/conversation.js';
import type { InstanceId } from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import { localSeqOf, type Message } from '../model/message.js';
import type { Scene } from '../model/room.js';

/**
 * 把一条对话导出成**可读的正文**（T12）。
 *
 * 归档的语义是「这条时间线没有发生过」——情绪、关系、记忆都回滚，对话本身留下
 * 只供回顾。但「只供回顾」如果只能在应用里点着看，用户会一直担心：这条线连同
 * 那几十轮对话到底还在不在？给他一个能带走的文本文件，这份担心才算落地。
 *
 * 与封存（`storage/archive.ts`）的分工很清楚：
 *
 * - **封存**是给机器读的：一个世界、全量数据、id 可重映射，用来搬家和恢复；
 * - **正文**是给人读的：这一条线当时一句句说了什么，Markdown，拿出去就能看。
 *
 * 纯函数，不碰存储也不碰界面——导出什么完全由传进来的数据决定，因此可单测。
 */

export interface TranscriptInput {
  conversation: Conversation;
  scenes: readonly Scene[];
  messages: readonly Message[];
  instances: readonly CharacterInstance[];
  /** 世界名，写进文件抬头；不知道就留空。 */
  worldTitle?: string;
  /** 导出时间，默认不下发（由调用方传，保持纯函数可测）。 */
  exportedAt?: string;
}

function speakerNameOf(message: Message, nameOf: (id: InstanceId) => string | null): string {
  if (message.role === 'player') return message.speakerName === '' ? '玩家' : message.speakerName;
  if (message.role === 'narration') return '旁白';
  if (message.role === 'system') return '系统';
  if (message.role === 'admin') return '世界管理员';
  if (message.speakerInstanceId !== null) return nameOf(message.speakerInstanceId) ?? message.speakerName;
  return message.speakerName === '' ? '未知角色' : message.speakerName;
}

/** 正文里那种「谁：」的前缀，转义掉换行免得把一条消息拆散。 */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ');
}

function sceneHeading(scene: Scene): string {
  const parts = [scene.title.trim() === '' ? '未命名场景' : scene.title.trim()];
  const where = [scene.location.trim(), scene.worldTime.trim()].filter((part) => part !== '');
  if (where.length > 0) parts.push(`（${where.join(' · ')}）`);
  return parts.join('');
}

/**
 * 生成 Markdown 正文。
 *
 * 消息按场景分段（场景就是「这条线里的几场戏」，读起来比一长串更像当时的经过），
 * 落在场景之外的消息（开场前、换场旁白）归到「未分场」里，一条都不丢。
 */
export function buildConversationTranscript(input: TranscriptInput): string {
  const nameById = new Map(input.instances.map((instance) => [instance.id, instance.displayName]));
  const nameOf = (id: InstanceId): string | null => nameById.get(id) ?? null;

  const ordered = [...input.messages].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
    return localSeqOf(left) - localSeqOf(right);
  });

  const lines: string[] = [];
  const title = input.conversation.title.trim() === '' ? '未命名对话' : input.conversation.title;
  const world = input.worldTitle?.trim() ?? '';

  lines.push(`# ${world === '' ? title : `${world} · ${title}`}`);
  lines.push('');
  lines.push(`- 对话类型：${input.conversation.kind === 'side' ? '副对话（世界管理员）' : '主对话（角色扮演）'}`);
  if (input.conversation.archivedAt !== null) lines.push(`- 归档于：${input.conversation.archivedAt}`);
  lines.push(`- 消息条数：${String(ordered.length)}`);
  if (input.exportedAt !== undefined) lines.push(`- 导出时间：${input.exportedAt}`);
  lines.push('');
  lines.push('> 归档的语义是「这条时间线没有发生过」：情绪、关系与记忆都已回滚，这份文件只是当时的正文。');
  lines.push('');

  const scenes = [...input.scenes].sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1));
  const byScene = new Map<string, Message[]>();
  const orphan: Message[] = [];
  for (const message of ordered) {
    if (message.sceneId === null) {
      orphan.push(message);
      continue;
    }
    const bucket = byScene.get(message.sceneId);
    if (bucket === undefined) byScene.set(message.sceneId, [message]);
    else bucket.push(message);
  }

  const emit = (messages: readonly Message[]): void => {
    for (const message of messages) {
      const name = speakerNameOf(message, nameOf);
      lines.push(`**${name}**：${oneLine(message.content)}`);
      lines.push('');
    }
  };

  if (orphan.length > 0) {
    lines.push('## 未分场的消息');
    lines.push('');
    emit(orphan);
  }

  for (const scene of scenes) {
    const bucket = byScene.get(scene.id) ?? [];
    lines.push(`## ${sceneHeading(scene)}`);
    lines.push('');
    if (scene.summary.trim() !== '') {
      lines.push(`> ${oneLine(scene.summary)}`);
      lines.push('');
    }
    if (bucket.length === 0) {
      lines.push('（这一场没有留下消息）');
      lines.push('');
      continue;
    }
    emit(bucket);
  }

  // 场景列表里没有、但消息指过来的场景（数据被删过）：宁可多一段，也不要静默丢消息
  const known = new Set(scenes.map((scene) => scene.id));
  const strays = [...byScene.entries()].filter(([sceneId]) => !known.has(sceneId as Scene['id']));
  for (const [, bucket] of strays) {
    lines.push('## 场景已不存在');
    lines.push('');
    emit(bucket);
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** 文件名：`dramatis-归档-河滩旧道-20260920-2130.md`。 */
export function suggestTranscriptName(conversation: Conversation, at: Date): string {
  const cleaned = conversation.title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 40);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${String(at.getFullYear())}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(
    at.getMinutes(),
  )}`;
  const middle = conversation.archivedAt === null ? '对话' : '归档';
  return `dramatis-${middle}-${cleaned === '' ? 'conversation' : cleaned}-${stamp}.md`;
}
