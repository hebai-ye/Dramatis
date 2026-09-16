import type { InstanceId } from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import { stripLeadingMarkers } from './segments.js';

/**
 * 语音归属评估（T18）。
 *
 * 问题来自五十回合长跑：约 8% 的回复内容其实属于另一个角色——「秦娘」说出小满的
 * 书角、「陈九」写出小满的台词、「小满」用第三人称说起自己。模型替场上别人发言，
 * 而我们只能事后发现。
 *
 * 这里**只做可解释的规则判断，不调用模型**（单回合额外调用 ≤ 2 的约束不能破）。
 *
 * 判据只有一个，但很硬：**同一个句子里既是第一人称、又用自己的名字称呼自己**。
 * 角色不会说「我看了看小满」（他就是小满）、也不会说「你跟陈九说」（他就是陈九）。
 * 长跑里两条最典型的错位都落在这一条上。
 *
 * 第一版还加了「第一人称句子里出现别人的名字」——**误报太多**：真实台词里
 * 「我认得小满」「你问小满去」都是正常的，21 条警告里大部分是这种。宁可漏，
 * 也不要让用户学会无视警告。
 *
 * 这条规则覆盖不到的错位（比如「秦娘」那条写的其实是小满的书角——靠道具词判断，
 * 不可靠），由界面上**始终可用的「改归属」**兜住。
 *
 * 判断只用来**标记**，不用来改数据：硬改归属比错位更糟。界面上给出「更像是谁说的」
 * 与一键改归属；测不到的漏网之鱼由「任何消息都可以改归属」兜住。
 */
export interface AttributionCandidate {
  instanceId: InstanceId;
  displayName: string;
  reason: string;
}

export interface AttributionAssessment {
  suspicious: boolean;
  reasons: string[];
  /** 更可能是谁说的，按把握排序。为空表示只知道「不对」，不知道「是谁」。 */
  candidates: AttributionCandidate[];
}

export interface AttributionInput {
  content: string;
  speaker: { instanceId: InstanceId; displayName: string };
  /** 当前场景的成员（用于判断「别人的名字」）。 */
  cast: readonly CharacterInstance[];
}

/** 第一人称的痕迹。中文角色扮演里「我」最常用，也捎上「咱」。 */
const FIRST_PERSON = /[我咱]/;
const SENTENCE_SPLIT = /[。！？…\n]/;

/** 名字出现在正文里（不含开头的转写标记——那已经在落库前清掉了）。 */
function containsName(content: string, name: string): boolean {
  const needle = name.trim();
  if (needle === '') return false;
  return content.toLowerCase().includes(needle.toLowerCase());
}

export function assessAttribution(input: AttributionInput): AttributionAssessment {
  const reasons: string[] = [];
  const candidates: AttributionCandidate[] = [];
  const speakerName = input.speaker.displayName.trim();
  // 老数据里还留着转写标记，先剥掉再判断，否则「【秦娘】…」会被当成自报家门
  const content = stripLeadingMarkers(input.content);

  if (speakerName !== '' && containsName(content, speakerName)) {
    for (const sentence of content.split(SENTENCE_SPLIT)) {
      if (!FIRST_PERSON.test(sentence) || !containsName(sentence, speakerName)) continue;

      reasons.push(`句子「${sentence.trim().slice(0, 24)}…」里既用「我」又用「${speakerName}」称呼自己`);

      // 这一句在写谁，只能由人来判断；先把场上其他人列出来供一键改归属
      for (const member of input.cast) {
        if (member.id === input.speaker.instanceId) continue;
        if (candidates.some((item) => item.instanceId === member.id)) continue;
        candidates.push({
          instanceId: member.id,
          displayName: member.displayName,
          reason: '这条写在别人名下更像他的戏',
        });
      }
      break;
    }
  }

  return { suspicious: reasons.length > 0, reasons, candidates };
}
