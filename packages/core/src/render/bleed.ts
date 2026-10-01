import type { InstanceId } from '../model/ids.js';

/**
 * 跨角色内容串线检测（顺序 79）。
 *
 * 问题来自 178 轮真实模型长跑（`docs/EVAL.md` 第六十八节）：**46/178 条**非掌柜角色
 * 用起了掌柜的道具（抹布 / 柜台 / 账本）；秦娘还整段复用了陈九的专属身世
 * 「我八岁那年雷砸了船，船板掀起来，攥缆绳攥出来的」。角色说起了别人的东西——
 * 观众一眼能看出来，模型自己看不出来。
 *
 * T18 的语音归属检查（`render/attribution.ts`）管的是「同一个句子里既用『我』又用
 * 自己的名字称呼自己」，它在注释里已经把这条留成坑：**靠道具词判断不可靠**，所以
 * 当时只做标记、把漏网的交给人。这一模块换一个**不来猜**的口径：
 *
 * > 谁的东西，以**他自己的角色卡**为准。
 *
 * 判据只有一条，但它有出处：一句话里出现了**另一个角色卡里写过、而说话人自己卡里
 * 没写过、场上别人卡里也没有**的片段（长度 ≥ 4 字，且片段里不含那个角色的名字）。
 *
 * 为什么这样就准（这是这一版敢开口的底气）：
 * - 素材是用户自己写的角色卡，不是我们猜的道具词表；
 * - 片段必须「只有他有」——两个人卡里都有的说法（同一条街、同一家客栈）自动排除；
 * - 片段里不含他的名字——别人正常提到「陈九」不会被误报；
 * - 4 字下限挡掉碎片，**宁可漏、不要滥**：T18 第一版 21 条警告里大部分是误报，
 *   用户学会无视警告比漏报更糟。
 *
 * 只用来**提示**，不用来改数据：界面上给出命中的原话片段（证据）与一键改归属，
 * 到底是不是串了，由用户判断。
 *
 * **这一版只做「同一段身世／同一句独有说法」，不做「同一件道具」**（那半见顺序 98）：
 * 道具是两个字的名词（抹布／账本／柜台），判据从「他句子里包含了我写过的整句」降级成
 * 「他句子里出现了一个词」，阈值只能靠真实语料调；而 T18 的第一版正是栽在这里——
 * 21 条警告大部分是误报，用户学会无视警告比漏报更糟。178 轮里「46/178 条非掌柜角色
 * 用了掌柜道具」首先是**风格漂移**的度量（布景词人人都在用），不是身份串用；
 * 拿它当准绳会把「客栈里谁都能擦桌子」判成串线。等有真实长跑语料能标出误报率再上。
 */
export interface SignatureMember {
  instanceId: InstanceId;
  displayName: string;
  /** 属于他自己的文本：角色卡的描述、性格、标签…… */
  material: readonly string[];
  /** 他自己的名字与昵称。片段里含这些名字就不算「独有说法」。 */
  aliases?: readonly string[];
}

export interface SignatureOwner {
  instanceId: InstanceId;
  displayName: string;
  /** 只有他说过、别人卡里没有的片段。 */
  spans: readonly string[];
}

export interface BleedHit {
  ownerInstanceId: InstanceId;
  ownerName: string;
  /** 属于那个角色的原文片段（给用户看的证据）。 */
  span: string;
  /** 说话人这句话里的原话（截断）。 */
  quote: string;
}

export interface BleedAssessment {
  bleeding: boolean;
  hits: BleedHit[];
  /** 给界面用的一句话；没命中时为 null。 */
  reason: string | null;
}

export interface BleedInput {
  content: string;
  speakerInstanceId: InstanceId;
  signatures: readonly SignatureOwner[];
}

/** 句子切分：强标点断句，逗号顿号当内部分隔。 */
const STRONG_SPLIT = /[。！？…!?；;\n\r]+/;
const WEAK_SPLIT = /[，、：:（）()「」『』“”"'《》〈〉[\]{}【】]+/;
/** 行首的引擎标记（`# 动作`、`- 项`）与引号类装饰，抽片段前先剥掉。 */
const LEAD_MARKER = /^[#\-*\s]+/;
/** 只有数字与符号的片段没有信息量（「三十」「1.5」都不该当独有说法）。 */
const HAS_WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z]/u;
/** 片段长度下限：4 字。低于它的片段（「他」「好的」）误报远多于真话。 */
export const MIN_SIGNATURE_LENGTH = 4;

function cleanClause(raw: string): string {
  return raw.replace(LEAD_MARKER, '').replace(/\s+/g, '').trim();
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

/**
 * 从一段文本里抽出「可以当签名用」的片段。
 *
 * 两个粒度都要：整句（强标点之间）与分句（逗号顿号之间）。
 * 整句留着是为了长身世能整段对上（「八岁那年雷砸了船，船板掀起来」），
 * 分句是为了模型换个说法、只抄走其中一截时还能认出来。
 */
export function extractSignatureSpans(text: string): string[] {
  const spans: string[] = [];
  for (const strong of text.split(STRONG_SPLIT)) {
    const sentence = cleanClause(strong);
    if (sentence.length >= MIN_SIGNATURE_LENGTH && HAS_WORD.test(sentence)) pushUnique(spans, sentence);
    for (const weak of strong.split(WEAK_SPLIT)) {
      const clause = cleanClause(weak);
      if (clause.length >= MIN_SIGNATURE_LENGTH && HAS_WORD.test(clause)) pushUnique(spans, clause);
    }
  }
  return spans;
}

/** 片段里是不是提到场上任何人的名字（别人叫他名字、他自己自报家门都是正常的）。 */
function mentionsAnyName(span: string, names: readonly string[]): boolean {
  return names.some((name) => {
    const needle = name.trim();
    return needle !== '' && span.includes(needle);
  });
}

/**
 * 把每个角色的素材整理成「独有说法」。
 *
 * `shared` 是场上大家共有的文本（世界书、场景描述）：那里出现过的说法不算谁独有——
 * 这是防止把「客栈」「柜台」这类布景词算到某个人头上的关键一步。
 */
export function buildSignatures(
  members: readonly SignatureMember[],
  options: { shared?: readonly string[] } = {},
): SignatureOwner[] {
  const extracted = members.map((member) => ({
    member,
    spans: extractSignatureSpans(member.material.filter((item) => item !== '').join('\n')),
  }));
  const sharedSpans = extractSignatureSpans((options.shared ?? []).join('\n'));
  // 片段里出现任何人的名字都不算「独有说法」：叫名字、提起别人都是正常说话
  const allNames = members.flatMap((member) => [member.displayName, ...(member.aliases ?? [])]);

  return extracted.map(({ member, spans }) => ({
    instanceId: member.instanceId,
    displayName: member.displayName,
    spans: spans.filter((span) => {
      if (mentionsAnyName(span, allNames)) return false;
      for (const other of extracted) {
        if (other.member.instanceId === member.instanceId) continue;
        if (other.spans.includes(span)) return false;
      }
      // 布景词：他这句本来就是从世界书/场景里来的说法
      return !sharedSpans.some((shared) => shared.includes(span));
    }),
  }));
}

function quoteOf(clause: string): string {
  return clause.length <= 24 ? clause : `${clause.slice(0, 24)}…`;
}

/** 一条消息的命中上限：证据摆太多，用户反而不会看。 */
const MAX_HITS = 3;

/**
 * 判断这条回复里有没有别人的东西。
 *
 * 纯规则、不调模型（和 T18 一样：单回合额外调用 ≤ 2 的约束不能破）。
 */
export function assessBleed(input: BleedInput): BleedAssessment {
  const hits: BleedHit[] = [];
  const speaker = input.speakerInstanceId;
  const clauses = extractSignatureSpans(input.content);

  for (const owner of input.signatures) {
    if (owner.instanceId === speaker) continue;
    // 长的片段优先：证据越具体，用户越好判断
    const spans = [...owner.spans].sort((left, right) => right.length - left.length);
    for (const clause of clauses) {
      const span = spans.find((item) => clause.includes(item));
      if (span === undefined) continue;
      hits.push({
        ownerInstanceId: owner.instanceId,
        ownerName: owner.displayName,
        span,
        quote: quoteOf(clause),
      });
      break;
    }
    if (hits.length >= MAX_HITS) break;
  }

  const first = hits[0];
  return {
    bleeding: hits.length > 0,
    hits,
    reason: first === undefined ? null : `出现了「${first.ownerName}」独有的说法「${first.span}」（他的角色卡里写着）`,
  };
}
