/**
 * 消息内容的渲染切分（LAYOUT「主对话状态」）。
 *
 * 手绘规格里写得很明确：
 * - 角色动作用 `#` 另起一段，**且不在气泡内**
 * - 一段话里掺杂动作时切分成多段：对白 → 动作 → 对白
 * - 长对白可以拆成多个短气泡，以显出真人感
 *
 * 这是纯粹的表现层规则，但放在 `core` 里：它决定「一条消息到底说了什么」，
 * 换端时不该重写一遍，也不该只在浏览器里能被测试。
 */
export type MessageSegmentKind = 'speech' | 'action';

export interface MessageSegment {
  kind: MessageSegmentKind;
  /** 动作段已剥掉 `#`；对白段保持原样（只去掉首尾空白）。 */
  text: string;
}

export interface RenderOptions {
  /**
   * 单个气泡的软上限（字符数）。
   *
   * 超过就按句子边界切开——模型很爱一次说一大段，而真人聊天是一句一句发的。
   */
  maxBubbleLength?: number;
  /**
   * 说话者的名字。
   *
   * 真实模型经常在回复开头自报家门（`秦娘：# 她拎起酒壶……`）——它是在模仿
   * 历史记录里「名字：台词」的格式。说话者自己的名字在界面上已经由头像与
   * 名字行给出了，正文里再写一遍纯属噪声，而且会把紧随其后的 `#` 动作标记
   * 顶掉。所以这里把它剥掉：只剥**与说话者同名**的前缀，写成别人的名字属于
   * 冒充，要留在正文里让人看见。
   */
  speakerName?: string;
}

function stripLeadingSpeakerPrefix(content: string, speakerName: string | undefined): string {
  // 转写标记 `【名字】` 是我们写进提示词的，角色自己不会这么说话：只要它出现在
  // 开头就是模型照抄历史留下的噪声，**不论写的是谁的名字**都剥掉。
  // （写成别人的名字属于冒充，那是另一个问题，正文内容仍然保留给用户看。）
  const withoutMarker = content.replace(/^\s*【[^】\n]{1,16}】\s*/, '');
  if (speakerName === undefined || speakerName.trim() === '') return withoutMarker;

  const name = speakerName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 「秦娘：」这种自报家门同样是格式噪声（说话人已经由头像与名字行给出）
  return withoutMarker.replace(new RegExp(`^\\s*${name}\\s*[:：]\\s*`), '');
}

export const DEFAULT_MAX_BUBBLE_LENGTH = 110;

/** 句末标点，切分时优先在这些位置断开。 */
const SENTENCE_END = /[。！？!?…；;\n]/;

function isActionLine(line: string): boolean {
  return /^\s*#/.test(line);
}

function stripActionMarkers(line: string): string {
  return line.replace(/^\s*#+\s?/, '').trim();
}

/**
 * `#` 不一定出现在行首。
 *
 * 真实模型（DeepSeek 网页版端到端测试）会写成
 * `「上个月的事，六个人，车马一起没的。」# 她朝陈九那边抬了下下巴。`——
 * 动作标记跟在句号后面，与对白挤在同一行。只认行首的话，这个 `#` 会原样
 * 漏进气泡里，看起来像乱码。所以先在**句末标点之后的 `#`** 前面断行，
 * 再走同一套逐行规则。
 *
 * 只在这个位置断：句中偶然出现的 `#`（比如话题标签）不该被动。
 */
const INLINE_ACTION_BREAK = /([。！？…；」』)】])\s*#/g;

export function normalizeActionBreaks(content: string): string {
  return content.replace(INLINE_ACTION_BREAK, '$1\n#');
}

/**
 * 按 `#` 把一段正文切成「对白段」与「动作段」。
 *
 * 规则是逐行的：空行断开一个段落，遇到 `#` 开头的行就换成动作段，
 * 之后再遇到普通行又切回对白段。这样「对白 → 动作 → 对白」天然成立，
 * 而不需要模型严格遵守某种固定格式。
 */
export function splitMessageContent(content: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let current: { kind: MessageSegmentKind; lines: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    if (text !== '') segments.push({ kind: current.kind, text });
    current = null;
  };

  for (const rawLine of normalizeActionBreaks(content).split(/\r?\n/)) {
    if (rawLine.trim() === '') {
      flush();
      continue;
    }

    const kind: MessageSegmentKind = isActionLine(rawLine) ? 'action' : 'speech';
    const line = kind === 'action' ? stripActionMarkers(rawLine) : rawLine.trim();

    if (!current || current.kind !== kind) {
      flush();
      current = { kind, lines: [] };
    }
    if (line !== '') current.lines.push(line);
  }

  flush();
  return segments;
}

/**
 * 把过长的对白切成多个短气泡。
 *
 * 只在句子边界上断开：切在句子中间会让角色看起来像话说一半被人抢了麦。
 * 单句本身超过上限时不再细切——宁可留一个长气泡，也不要切碎一句完整的话。
 */
export function splitLongSpeech(text: string, maxLength = DEFAULT_MAX_BUBBLE_LENGTH): string[] {
  if (maxLength <= 0 || text.length <= maxLength) return [text];

  const pieces: string[] = [];
  let buffer = '';

  for (const char of text) {
    buffer += char;
    const atBoundary = SENTENCE_END.test(char);
    if (atBoundary && buffer.trim().length >= maxLength / 2) {
      pieces.push(buffer.trim());
      buffer = '';
    }
  }

  if (buffer.trim() !== '') pieces.push(buffer.trim());
  return pieces.length === 0 ? [text] : pieces;
}

/**
 * 渲染一条消息所需的全部片段。
 *
 * 对白段已按气泡上限拆开，动作段保持整段——动作是一段连贯的描写，
 * 拆成多个「气泡」毫无意义（它本来就不在气泡里）。
 */
export function renderMessageContent(content: string, options: RenderOptions = {}): MessageSegment[] {
  const maxLength = options.maxBubbleLength ?? DEFAULT_MAX_BUBBLE_LENGTH;
  const pieces: MessageSegment[] = [];
  const cleaned = stripLeadingSpeakerPrefix(content, options.speakerName);

  for (const segment of splitMessageContent(cleaned)) {
    if (segment.kind === 'action') {
      pieces.push(segment);
      continue;
    }
    for (const part of splitLongSpeech(segment.text, maxLength)) {
      pieces.push({ kind: 'speech', text: part });
    }
  }

  return pieces;
}

/** 写进 prompt 的动作约定。角色不照做时，气泡会变得又长又平。 */
export const ACTION_FORMAT_RULE =
  '动作与神态请用 `#` 另起一段描写（例如：`# 她把杯子往桌上一放`），' +
  '`#` 必须写在**一行的开头**，动作与对白不要挤在同一行；' +
  '对白请分段，不要一口气写成一大段。';
