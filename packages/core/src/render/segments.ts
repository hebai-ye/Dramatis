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
  /**
   * 把**动作段**里的第一人称换成说话人的名字。
   *
   * 模型很爱用「我」写自己的动作（五十回合长跑里几乎每段都是「我把斗笠往上一抬」），
   * 读起来像角色在自己念旁白。界面上的动作是给玩家看的第三方叙述，主语该是名字。
   * 对白里的「我」一个字都不动——那是他在说话。
   *
   * 只改**显示**，不改存储：记忆抽取与语音归属检测读的仍然是模型原本写的东西。
   */
  thirdPersonActions?: boolean;
}

function stripLeadingSpeakerPrefix(content: string, speakerName: string | undefined): string {
  const withoutMarker = stripLeadingMarkers(content);
  if (speakerName === undefined || speakerName.trim() === '') return withoutMarker;

  const name = speakerName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 「秦娘：」这种自报家门同样是格式噪声（说话人已经由头像与名字行给出）
  return withoutMarker.replace(new RegExp(`^\\s*${name}\\s*[:：]\\s*`), '');
}

/**
 * 反复剥掉开头的转写标记 `【名字】`。
 *
 * 转写标记是我们写进提示词的，角色自己不会这么说话；模型照抄一次之后，
 * 这条消息进入历史、又成了下一轮的样板——于是标记会一个、两个、四个地长下去
 * （真实长跑里真的长到了五个）。所以这里必须**循环剥**，而不是剥一层。
 */
export function stripLeadingMarkers(content: string): string {
  let out = content;
  for (;;) {
    const next = out.replace(/^\s*【[^】\n]{1,16}】\s*/, '');
    if (next === out) return out;
    out = next;
  }
}

export const DEFAULT_MAX_BUBBLE_LENGTH = 110;

/** 句末标点，切分时优先在这些位置断开。 */
const SENTENCE_END = /[。！？!?…；;\n]/;

/**
 * 对白的引号。中英文都收：中文用「」『』与弯引号，英文用直引号。
 */
const QUOTE_PAIRS: Record<string, string> = {
  '「': '」',
  '『': '』',
  '“': '”',
  '"': '"',
};

/** 只有真的像一句话时才单独成段，免得把标点或空白切出来。 */
function isMeaningful(text: string): boolean {
  return /[\p{Script=Han}\p{L}\p{N}]/u.test(text);
}

interface QuotedSpan {
  quoted: boolean;
  text: string;
}

/**
 * 按引号把一行切成「对白」与「非对白」的片段。
 *
 * 这是给**不写动作标记的模型**准备的兜底。它们不肯按约定加 `#`，但几乎总把对白
 * 放进引号里——那我们就反过来用：引号内是对白，引号外是动作。
 */
export function splitByQuotes(line: string): QuotedSpan[] {
  const spans: QuotedSpan[] = [];
  let buffer = '';
  let quoted = false;
  let closer = '';

  const flush = (): void => {
    const text = buffer.trim();
    if (text !== '' && (quoted || isMeaningful(text))) spans.push({ quoted, text });
    buffer = '';
  };

  for (const char of line) {
    if (!quoted) {
      const expected = QUOTE_PAIRS[char];
      if (expected !== undefined) {
        flush();
        quoted = true;
        closer = expected;
        buffer += char;
        continue;
      }
      buffer += char;
      continue;
    }

    buffer += char;
    if (char === closer) {
      flush();
      quoted = false;
      closer = '';
    }
  }

  flush();
  return spans;
}

/** 这一行里有没有成对的引号。 */
function hasQuotedSpan(line: string): boolean {
  return splitByQuotes(line).some((span) => span.quoted);
}

/**
 * 只在引号**之外**做替换，引号里的原样保留。
 *
 * 动作段里也可能夹着引号（`# 她朝门口抬了下下巴。「你问这个做什么。」`），
 * 那里的「我」是角色说的话，不能动。
 */
function mapOutsideQuotes(text: string, transform: (chunk: string) => string): string {
  let out = '';
  let buffer = '';
  let quoted = false;
  let closer = '';

  for (const char of text) {
    if (!quoted) {
      const expected = QUOTE_PAIRS[char];
      if (expected !== undefined) {
        out += transform(buffer);
        buffer = '';
        quoted = true;
        closer = expected;
        out += char;
        continue;
      }
      buffer += char;
      continue;
    }

    out += char;
    if (char === closer) {
      quoted = false;
      closer = '';
    }
  }

  return out + transform(buffer);
}

/**
 * 动作段的第一人称 → 说话人的名字。
 *
 * 三种「我」不动：
 * - **我们**：「陈九们」不是人话，复数留给以后专门处理
 * - **自我**：构词的一部分（自我怀疑），不是代词
 * - **你我**：对举（你我之间），换成名字反而别扭
 */
export function thirdPersonAction(text: string, speakerName: string): string {
  const name = speakerName.trim();
  if (name === '') return text;
  return mapOutsideQuotes(text, (chunk) => rewriteFirstPerson(chunk, name));
}

/** 句末：到这里就是新的一句话，主语该重新给出名字。 */
const SENTENCE_BREAK = /[。！？…\n\s]/;
/** 句内停顿：第二次以主语出现时，中文习惯是省略而不是重念名字。 */
const CLAUSE_BREAK = /[，、；：]/;

function rewriteFirstPerson(chunk: string, name: string): string {
  let out = '';
  let named = false;

  for (let index = 0; index < chunk.length; index += 1) {
    const char = chunk[index];
    if (char !== '我') {
      out += char;
      continue;
    }

    const previous = index === 0 ? '' : (chunk[index - 1] ?? '');
    const next = chunk[index + 1] ?? '';
    // 我们（复数）、自我（构词）、你我（对举）都不动
    if (next === '们' || previous === '自' || previous === '你') {
      out += char;
      continue;
    }

    const atSentenceStart = index === 0 || SENTENCE_BREAK.test(previous);
    const atClauseStart = atSentenceStart || CLAUSE_BREAK.test(previous);
    // 同一句里第二次以主语出现：名字已经给过了，中文习惯是省略。
    // 换了句子就重新给名字——「他比陈九还高。陈九记下了。」比省略清楚。
    if (named && atClauseStart && !atSentenceStart) continue;

    out += name;
    named = true;
  }

  return out;
}

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
 * 导入卡的开场白偶尔把换行写成字面 `\\n` 或 `/n`。只在生成自动开场消息时
 * 兼容这种写法，卡片原文、历史消息和普通回复一律不改。
 * `/n` 仅当两侧像正文时才处理，避免改动 URL、路径或 `1/n` 之类的文本。
 */
export function normalizeGreetingBreaks(content: string): string {
  return content.replace(/\\r\\n|\\n|\/n/g, (marker, offset: number, source: string) => {
    const before = source[offset - 1] ?? '';
    const after = source.slice(offset + marker.length).trimStart()[0] ?? '';
    const textBoundary = /[\p{Script=Han}。！？；：」』”）.!?;:'"*)\s]/u.test(before);
    const nextLineStart = /[\p{Script=Han}#*（【「『“"\s]/u.test(after);
    if (marker === '/n') return textBoundary && nextLineStart ? '\n' : marker;
    // `C:\new` 这类路径不该变成换行；正常的中文开场文本则仍可转换。
    return (textBoundary || before === '') && nextLineStart ? '\n' : marker;
  });
}

/** 说话人标签：`名字：` 或 `名字:`，出现在行首，最长 12 个字符。 */
const SPEAKER_LABEL = /^\s*([^：:\n]{1,12})\s*[：:]\s*(.*)$/;

/**
 * 把角色卡自带的「对话风格示例」整理成我们自己的写法。
 *
 * 卡里的示例通常长这样（SillyTavern 的老习惯）：
 *
 *     玩家：听说北边的商队没了。
 *     陈九：听说？# 他压低声音敲了两下桌子。「我的货找谁要去。」
 *
 * 它是**最强的一份示范**——模型模仿它，远胜于服从我们的规则。可它的写法与约定正好
 * 相反：动作挤在对白后面、回复开头挂着「名字：」。所以注入之前先归一化：
 * 行内动作断到行首，说话人标签换成 `【名字】`，与历史记录用同一套形状。
 *
 * 只改格式、不动内容——卡里每一句话都还在。
 */
export function normalizeCardExample(content: string, speakerNames: readonly string[] = []): string {
  const names = new Set(speakerNames.map((name) => name.trim()).filter((name) => name !== ''));

  return normalizeActionBreaks(content)
    .split(/\r?\n/)
    .map((line) => {
      const match = SPEAKER_LABEL.exec(line);
      if (!match) return line;
      const label = (match[1] ?? '').trim();
      const rest = match[2] ?? '';
      const isSpeaker = names.has(label) || /^(玩家|用户|user|you)$/i.test(label);
      return isSpeaker ? `【${label}】${rest}` : line;
    })
    .join('\n');
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

  const lines = normalizeActionBreaks(content).split(/\r?\n/);

  /**
   * 这条消息有没有用引号写对白。
   *
   * 有的话就启用「引号内是对白、引号外是动作」的兜底规则——模型不肯写 `#` 时，
   * 这是唯一可靠的分段依据。没有引号就不启用，免得把整段独白误判成动作。
   */
  const usesQuotes = lines.some((line) => hasQuotedSpan(line));

  for (const rawLine of lines) {
    if (rawLine.trim() === '') {
      flush();
      continue;
    }

    const push = (kind: MessageSegmentKind, text: string): void => {
      if (text === '') return;
      if (!current || current.kind !== kind) {
        flush();
        current = { kind, lines: [] };
      }
      current.lines.push(text);
    };

    if (isActionLine(rawLine)) {
      push('action', stripActionMarkers(rawLine));
      continue;
    }

    const trimmed = rawLine.trim();
    if (!usesQuotes) {
      push('speech', trimmed);
      continue;
    }

    // 引号外的部分当动作，引号内当对白。整行都是动作时（比如纯描写），
    // 它会自然落进 action 段。
    for (const span of splitByQuotes(trimmed)) {
      push(span.quoted ? 'speech' : 'action', span.text);
    }
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
      pieces.push(
        options.thirdPersonActions === true && options.speakerName !== undefined
          ? { kind: 'action', text: thirdPersonAction(segment.text, options.speakerName) }
          : segment,
      );
      continue;
    }
    for (const part of splitLongSpeech(segment.text, maxLength)) {
      pieces.push({ kind: 'speech', text: part });
    }
  }

  return pieces;
}

/**
 * 这条消息里有没有「说话」。
 *
 * 用途只有一个但很重要：**只做动作、一个字没说的那一轮不该算发言**。
 * 否则一个全程沉默、只是摇头的角色会被冷却惩罚压住，而公平性又把他往前推，
 * 调度结果会变得没有道理。旁白与系统消息不算发言。
 */
export function hasSpeech(content: string): boolean {
  // 判据是**有没有引号**，而不是「按渲染规则算不算对白」：渲染规则为了兼容
  // 把没有引号的行也当对白显示，那样任何纯动作的一轮都会被误判成「说了话」。
  // 这里的用途是调度（沉默的一轮不该吃冷却），宁可只认最可靠的信号。
  return content.split(/\r?\n/).some((line) => splitByQuotes(line).some((span) => span.quoted));
}

/**
 * 写进 prompt 的动作约定。
 *
 * 这是踩了一整轮才定下来的写法。起初只要求「动作用 `#` 独占一行」：加规则、
 * 加正反例、加现场示范、把角色卡自带的示例也归一化，DeepSeek 的默认模型**全都
 * 不照做**（12 回合里只有约 2 条）。但它有一点很稳定：**对白永远带「」引号**。
 *
 * 于是约定反过来说明——引号内是对白，引号外是动作——用一个模型已经在遵守的写法
 * 来推它该守的那部分。`#` 仍然支持（也仍然优先），只是不再指望它。
 */
export const ACTION_FORMAT_RULE = [
  '写法：对白一定要用「」包起来；没被引号包住的句子会被当成动作，显示在气泡之外。',
  '动作也可以显式写成 `# 动作`（独占一行开头）。',
].join('\n');

/**
 * 规则的具体例子。
 *
 * 与规则分开：规则要短、要留在不可丢弃的系统块里，例子长得多，放进可丢弃的
 * 格式块——预算紧张时先让位给记忆与关系，而不是把整条 prompt 顶出预算。
 */
export const ACTION_FORMAT_EXAMPLES = [
  '正确：',
  '# 她把杯子往桌上一放。',
  '「你问这个做什么。」',
  '# 她抬眼看了看门口。',
  '也正确（动作不加 `#`，但也没有放进引号里）：',
  '她把杯子往桌上一放。',
  '「你问这个做什么。」',
  '错误（把动作也写进引号，读起来像她在念旁白）：',
  '「她把杯子往桌上一放。」',
].join('\n');
