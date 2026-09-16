import type { Card, WorldBook } from '../model/card.js';
import type { Conversation } from '../model/conversation.js';
import type { CharacterInstance } from '../model/instance.js';
import type { Message } from '../model/message.js';
import type { Room, Scene } from '../model/room.js';
import type { ChatMessage } from '../prompt/types.js';
import { ADMIN_TOOLS } from './tools.js';

const SYSTEM_PROMPT = [
  '你是这个世界管理员，负责帮用户把素材搭起来：角色卡、世界书、当前场景。',
  '你不扮演任何角色，也不写剧情台词——那是主对话的事。',
  '需要落成素材时，直接调用工具，不要在正文里贴 JSON 或代码块。',
  '工具只会产出草稿：用户点「采纳」才会进入素材库，所以要一次把内容写完整、写好。',
  '调用工具之前用一两句话说清你打算做什么；调用之后再说清结果与建议。',
  '不确定用户想要什么时先问一句，不要凭空替用户决定世界观。',
].join('\n');

export interface AdminPromptInput {
  room: Room;
  conversation: Conversation;
  scene: Scene | null;
  instances: readonly CharacterInstance[];
  cards: readonly Card[];
  worldBooks: readonly WorldBook[];
  /** 副对话自己的历史，不含主对话的任何消息。 */
  history: readonly Message[];
  userInput: string;
  /** 已经起草过、还没被采纳的草稿摘要，避免模型重复劳动。 */
  pendingDrafts?: readonly string[];
}

function describeLibrary(cards: readonly Card[], worldBooks: readonly WorldBook[]): string {
  const cardLines =
    cards.length === 0
      ? '（还没有角色卡）'
      : cards
          .map((card) => `- ${card.name}（id: ${card.id}）：${card.description.replace(/\s*\n\s*/g, ' ').slice(0, 60)}`)
          .join('\n');

  const bookLines =
    worldBooks.length === 0
      ? '（还没有世界书）'
      : worldBooks.map((book) => `- ${book.name}（id: ${book.id}）：${String(book.entries.length)} 条`).join('\n');

  return [`角色卡：\n${cardLines}`, `世界书：\n${bookLines}`].join('\n\n');
}

/**
 * 副对话的提示词（LAYOUT「副对话状态」）。
 *
 * 这是**世界管理员与用户的对话**，形态更接近 AI 工作流：没有角色扮演、
 * 没有气泡、不注入角色人设与记忆。它唯一能做的事就是调用那三个工具，
 * 所以提示词里也必须把这一点说清楚，而不是让它自由发挥。
 */
export function buildAdminMessages(input: AdminPromptInput): ChatMessage[] {
  const context = [
    `世界：${input.room.title}`,
    `对话：${input.conversation.title}`,
    input.scene === null
      ? '当前没有场景'
      : `当前场景：${input.scene.title}${input.scene.location === '' ? '' : `（${input.scene.location}）`}${
          input.scene.worldTime === '' ? '' : `，世界内时间 ${input.scene.worldTime}`
        }`,
    `世界中已有角色：${
      input.instances.length === 0 ? '（还没有）' : input.instances.map((instance) => instance.displayName).join('、')
    }`,
    `可用工具：${ADMIN_TOOLS.map((tool) => tool.function.name).join('、')}`,
  ].join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: `当前素材：\n${describeLibrary(input.cards, input.worldBooks)}\n\n${context}` },
  ];

  if (input.pendingDrafts !== undefined && input.pendingDrafts.length > 0) {
    messages.push({
      role: 'system',
      content: `这些草稿已经起草好、正在等用户决定去留，不要重复起草：\n${input.pendingDrafts
        .map((item) => `- ${item}`)
        .join('\n')}`,
    });
  }

  for (const message of input.history) {
    messages.push({
      role: message.role === 'admin' ? 'assistant' : 'user',
      content: message.content,
    });
  }

  if (input.userInput.trim() !== '') {
    messages.push({ role: 'user', content: input.userInput.trim() });
  }

  return messages;
}
