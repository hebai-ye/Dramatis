import { eventId, newId, nowIso, type RoomId, type SceneId } from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import type { MemoryEvent } from '../model/message.js';
import type { ExtractedMemory } from './types.js';

export interface IngestInput {
  roomId: RoomId;
  sceneId: SceneId | null;
  worldTime: string;
  /** 房间内单调递增的序号，用于排序与时效计算。 */
  sequence: number;
  /** 抽取时在场的角色。 */
  participants: readonly CharacterInstance[];
  extraction: ExtractedMemory;
  turnId: string;
  /** 会话内时间，默认当前时刻。 */
  createdAt?: string;
}

export interface IngestResult {
  events: MemoryEvent[];
  /** 抽取结果里提到、但匹配不到角色的名字。 */
  unmatchedSpeakers: string[];
  /** 在场却没有视角条目的角色。 */
  silentParticipants: string[];
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 把一次抽取的产物变成记忆条目（ROADMAP P1-2）。
 *
 * 产出 1 条客观条目加 N 条视角条目：
 * - 客观条目（observerId 为 null）给用户看，用来对比「实际发生了什么」
 *   与「每个人记得什么」
 * - 视角条目才是角色召回时使用的，也是「多角色」与「一个角色的多个分身」
 *   之间的分界线
 *
 * 同一事件在不同角色记忆里允许互相矛盾，这里不做任何一致性校验——
 * 强行对齐就正好毁掉了这个特性。
 */
export function buildMemoryEvents(input: IngestInput): IngestResult {
  const createdAt = input.createdAt ?? nowIso();
  const participantIds = input.participants.map((member) => member.id);
  const byName = new Map(input.participants.map((member) => [normalizeName(member.displayName), member]));

  const base = {
    roomId: input.roomId,
    sceneId: input.sceneId,
    timeline: { worldTime: input.worldTime, sequence: input.sequence },
    location: input.extraction.location,
    participants: participantIds,
    importance: input.extraction.importance,
    affects: [] as MemoryEvent['affects'],
    sourceTurnIds: [input.turnId],
    createdAt,
    lastRecalledAt: null,
    recallCount: 0,
    pinned: false,
    importanceLocked: false,
  };

  const events: MemoryEvent[] = [
    {
      ...base,
      id: eventId(newId()),
      summary: input.extraction.summary,
      observerId: null,
      perception: '',
    },
  ];

  const unmatchedSpeakers: string[] = [];
  const covered = new Set<string>();

  for (const observation of input.extraction.observations) {
    const observer = byName.get(normalizeName(observation.speaker));
    if (!observer) {
      unmatchedSpeakers.push(observation.speaker);
      continue;
    }
    // 同一个角色只保留第一条，避免抽取结果里重复提到他
    if (covered.has(observer.id)) continue;
    covered.add(observer.id);

    events.push({
      ...base,
      id: eventId(newId()),
      summary: input.extraction.summary,
      observerId: observer.id,
      perception: observation.perception,
    });
  }

  const silentParticipants = input.participants
    .filter((member) => !covered.has(member.id))
    .map((member) => member.displayName);

  return { events, unmatchedSpeakers, silentParticipants };
}
