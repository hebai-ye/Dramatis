/**
 * 意图先行（ROADMAP P1-6 的零额外调用版）。
 *
 * P1-6 原本的设想是「生成对白之前先用便宜模型产出一份意图」，再拿它决定谁接话、
 * 以什么方式接。但那会变成每回合第 3 次额外调用，直接撞上项目的硬约束
 * （单回合额外调用 ≤ 2，不含正式回复本身）。
 *
 * 所以改成让模型**在回复开头自己声明一行**：
 *
 *     意图：把那批货的来路问清楚
 *     「你说的三十箱，是谁点过数的？」
 *
 * 好处有三：
 * 1. 零额外调用，只多几十个输出 token
 * 2. 模型先声明再落笔，注意力先落在「我这一轮要做什么」上，而不是替别人写戏
 * 3. 这句意图可以给用户看（他为什么这么回），也能被调度器当作下一轮的信号
 *
 * 解析出来的意图**单独存**，正文里不留——否则它会进历史、被下一轮学成正文的一部分。
 */
export type IntentKind = 'ask' | 'wait' | 'initiate' | 'other';

export interface SplitIntent {
  /** 声明里的一句话；没声明时为 null。 */
  intent: string | null;
  /** 去掉意图行之后的正文。 */
  body: string;
}

/** 行首的意图声明。中英文冒号都收。 */
const INTENT_LINE = /^\s*(?:意图|intent)\s*[:：]\s*(.*)$/i;

export function splitIntent(content: string): SplitIntent {
  const lines = content.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const match = INTENT_LINE.exec(line);
    if (!match) {
      // 只认开头：前面先出现别的正文，就不再当它是意图声明
      if (line.trim() !== '') return { intent: null, body: content };
      continue;
    }

    const intent = (match[1] ?? '').trim();
    if (intent === '') continue;

    const rest = lines
      .slice(index + 1)
      .join('\n')
      .replace(/^\s*\n+/, '');
    return { intent, body: rest };
  }

  return { intent: null, body: content };
}

/**
 * 把一句自由文本的意图归成四类。
 *
 * 关键词判断很粗，但用途只有两个：界面上标一下、调度器给一点点权重，
 * 判错也只是一次加减分。**不做语义理解**，因为没有多余调用可用。
 */
const KIND_RULES: Array<{ kind: IntentKind; pattern: RegExp }> = [
  // 先看「按兵不动」：这类常常同时出现「等」与「看」，包含关系会盖住后面的判断
  { kind: 'wait', pattern: /观察|静观|沉默|不表态|按兵不动|旁观|先听|只听|看情况|等他/ },
  { kind: 'ask', pattern: /问|追问|打听|试探|确认|质问|套话/ },
  { kind: 'initiate', pattern: /提醒|警告|劝阻|劝|建议|提出|点破|拦住|阻止|挑明/ },
];

export function intentKind(intent: string | null | undefined): IntentKind {
  if (intent === null || intent === undefined) return 'other';
  for (const rule of KIND_RULES) {
    if (rule.pattern.test(intent)) return rule.kind;
  }
  return 'other';
}

/** 写进 prompt 的格式要求。短，放在每轮指令的最后一段。 */
export const INTENT_FORMAT_RULE =
  '先写一行 `意图：<这一轮你想做什么，一句话>`，然后空一行再写对白与动作。意图只写你自己的打算，不要写别人。';
