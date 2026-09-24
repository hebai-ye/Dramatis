import type { Card, WorldBook } from '../model/card.js';
import type { Conversation } from '../model/conversation.js';
import type { CharacterInstance } from '../model/instance.js';
import type { Message } from '../model/message.js';
import type { Persona } from '../model/persona.js';
import type { Room, Scene } from '../model/room.js';
import type { ChatMessage } from '../prompt/types.js';
import { ADMIN_TOOLS } from './tools.js';

const SYSTEM_PROMPT = [
  '你是这个世界管理员，负责帮用户把素材搭起来：角色卡、世界书、玩家身份（Persona）与当前场景。',
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
  personas: readonly Persona[];
  /** 副对话自己的历史，不含主对话的任何消息。 */
  history: readonly Message[];
  userInput: string;
  /** 已经起草过、还没被采纳的草稿摘要，避免模型重复劳动。 */
  pendingDrafts?: readonly string[];
}

/** 单条设定/字段的展示上限。给模型的上下文要有用，但不能把预算吃光。 */
const FIELD_PREVIEW = 160;
/** 最多列出几条素材，避免素材库变大后提示词无限膨胀。 */
const MAX_LISTED = 12;

function preview(value: string): string {
  const flat = value.trim().replace(/\s*\n\s*/g, ' ');
  return flat.length <= FIELD_PREVIEW ? flat : `${flat.slice(0, FIELD_PREVIEW)}……`;
}

/**
 * 把素材库摊开给管理员看。
 *
 * 这里必须给出**原有内容**，不能只给「有几条」：修改是整本替换（工具语义如此），
 * 模型看不到旧条目就会把原设定弄丢——这正是真实模型验证里第一次跑出来的问题。
 */
function describeLibrary(
  cards: readonly Card[],
  worldBooks: readonly WorldBook[],
  personas: readonly Persona[],
): string {
  const cardLines =
    cards.length === 0
      ? '（还没有角色卡）'
      : cards
          .slice(0, MAX_LISTED)
          .map((card) => {
            const fields = [
              card.nickname.trim() === '' ? '' : `自称 ${card.nickname.trim()}`,
              preview(card.description),
              card.personality.trim() === '' ? '' : `性格 ${preview(card.personality)}`,
              card.firstMessage.trim() === '' ? '' : `开场白 ${preview(card.firstMessage)}`,
            ].filter((item) => item !== '');
            return `- ${card.name}（id: ${card.id}）：${fields.join('；')}`;
          })
          .join('\n');

  const bookLines =
    worldBooks.length === 0
      ? '（还没有世界书）'
      : worldBooks
          .slice(0, MAX_LISTED)
          .map((book) => {
            const entries =
              book.entries.length === 0
                ? '（空）'
                : book.entries
                    .slice(0, MAX_LISTED)
                    .map((entry) => {
                      const keys = entry.constant ? '常驻' : entry.keys.join('/');
                      return `    · ${entry.title.trim() === '' ? '未命名条目' : entry.title.trim()}（${keys}）：${preview(entry.content)}`;
                    })
                    .join('\n');
            return `- ${book.name}（id: ${book.id}）：${String(book.entries.length)} 条\n${entries}`;
          })
          .join('\n');

  const personaLines =
    personas.length === 0
      ? '（还没有玩家身份）'
      : personas
          .slice(0, MAX_LISTED)
          .map((persona) => `- ${persona.name}（id: ${persona.id}）：${preview(persona.description)}`)
          .join('\n');

  return [`角色卡：\n${cardLines}`, `世界书：\n${bookLines}`, `玩家身份：\n${personaLines}`].join('\n\n');
}

/**
 * 副对话的提示词（LAYOUT「副对话状态」）。
 *
 * 这是**世界管理员与用户的对话**，形态更接近 AI 工作流：没有角色扮演、
 * 没有气泡、不注入角色人设与记忆。它唯一能做的事就是调用那五个工具，
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
    {
      role: 'system',
      content: [
        `当前素材：\n${describeLibrary(input.cards, input.worldBooks, input.personas)}`,
        '',
        '注意：修改角色卡与世界书是**整份替换**——你必须把原有内容一并写回去，',
        '再在此基础上增补，不要只写你新加的那部分，也不要在用户没要求时删掉已有设定。',
        context,
      ].join('\n'),
    },
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
