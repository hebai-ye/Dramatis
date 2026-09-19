import type { CharacterInstance } from '../model/instance.js';
import type { Message } from '../model/message.js';
import type { Scene } from '../model/room.js';
import type { ChatMessage } from '../prompt/types.js';
import { type AffectUpdate, parseAffectUpdates } from './affect.js';
import { extractJsonObject, parseExtraction } from './extract.js';
import type { ExtractedMemory } from './types.js';

/**
 * 一次调用做完两件事：记录这一段对话，并推演在场角色的状态变化（P1-9 的批量合并）。
 *
 * 为什么现在做：P1-6 需要一次「生成前的意图」调用，而预算被这条硬约束卡着——
 * 单回合额外调用 ≤ 2。原来后台固定两次（抽取 + 推演），合并成一次之后就空出一格，
 * 正好给意图调用，总账不变。
 *
 * 为什么可以合：两件事吃的是**同一批消息、同一批在场角色**，只是输出不同字段。
 * 合成一次调用不会少给模型信息，只是让它一次把 JSON 写全。
 *
 * 风险：两份提示词都经过真模型验证（EVAL 第一、二轮），合并动了已验证的部分，
 * 所以要按 EVAL 的流程重跑一轮。解析层刻意做得**宽容**：合并形状、嵌套形状、
 * 以及原来的单件形状都能吃下，模型偶尔退回旧格式时功能不至于整个坏掉。
 */
export interface TurnAnalysisInput {
  scene: Scene | null;
  cast: readonly CharacterInstance[];
  playerName: string;
  messages: readonly Message[];
}

export interface TurnAnalysis {
  extraction: ExtractedMemory;
  updates: AffectUpdate[];
}

const SYSTEM_PROMPT = [
  '你在做两件事：把刚发生的一段对话记录成一条记忆，并推演在场角色的状态变化。',
  '只输出一个 JSON 对象，不要写解释，不要写代码块标记。',
].join('\n');

const FIELD_GUIDE = [
  '字段要求：',
  '- summary：客观描述发生了什么，一到三句，不要写角色的内心。',
  '- importance：0 到 1。改变关系、暴露秘密、推进情节的给高分；寒暄与日常给低分。',
  '- location：只有对话里明确发生地点变化时才填，否则留空字符串。',
  '- observations：为每个在场角色各写一条，写他在自己的视角下注意到了什么、误解了什么、',
  '  在意什么。同一件事在不同角色眼里应当有差异，允许互相矛盾。speaker 必须用给出的角色名。',
  '- updates：只为真的被触动的角色写一条；没有变化的角色不要出现。',
  '  deltaValence 与 deltaArousal 在 -0.3 到 0.3 之间；relationship 只写变化的维度，',
  '  field 取 trust / affinity / fear / respect / tension，delta 同样在 -0.3 到 0.3。',
  '  reason 用一句话说明变化的原因，会被记进角色状态史。',
].join('\n');

const FORMAT_HINT = [
  '输出格式（一个对象，两件事都在里面）：',
  '{"summary":"客观经过","importance":0.6,"location":"",',
  '"observations":[{"speaker":"角色名","perception":"他的印象"}],',
  '"updates":[{"observer":"角色名","deltaValence":0.1,"deltaArousal":0.05,"reason":"为什么",',
  '"relationship":[{"field":"affinity","delta":0.1}]}]}',
].join('\n');

export function buildTurnAnalysisMessages(input: TurnAnalysisInput): ChatMessage[] {
  const scene = input.scene;
  const context = [
    `地点：${scene === null || scene.location.trim() === '' ? '未指定' : scene.location.trim()}`,
    `时间：${scene === null || scene.worldTime.trim() === '' ? '未指定' : scene.worldTime.trim()}`,
    `玩家扮演：${input.playerName}`,
    `在场角色：${input.cast.map((member) => member.displayName).join('、')}`,
  ].join('\n');

  const conversation = input.messages
    .map((message) => `${message.speakerName}：${message.content.replace(/\s*\n\s*/g, ' ')}`)
    .join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [context, '', '对话：', conversation, '', FIELD_GUIDE, '', FORMAT_HINT].join('\n'),
    },
  ];
}

/**
 * 把合并输出拆回两份结构化结果。
 *
 * 复用两个单件解析器（它们各自做过容错），只在这里补一层形状归一：
 * 模型有时会把答案嵌套成 `{"memory":{…},"affect":{…}}`——两种都给过示例，
 * 哪种出现都不该让整轮分析作废。
 */
export function parseTurnAnalysis(raw: string): TurnAnalysis {
  const root = extractJsonObject(raw);
  const record = typeof root === 'object' && root !== null ? (root as Record<string, unknown>) : {};

  const memoryCandidate = record.memory ?? record.extraction ?? record;
  const affectCandidate = record.affect ?? record.state ?? record;

  const extraction = parseExtraction(JSON.stringify(memoryCandidate));
  const updates = parseAffectUpdates(JSON.stringify(affectCandidate));

  return { extraction, updates };
}
