import type { ConversationId, EventId, InstanceId, RoomId, SceneId } from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import type { Repository } from '../storage/repository.js';
import { applyAffectUpdates } from './affect.js';
import { buildMemoryEvents } from './ingest.js';
import { parseTurnAnalysis } from './turn-analysis.js';

/**
 * 把「一轮分析」的结果落库（记忆 + 情绪关系）。
 *
 * 抽出来只有一个理由：**同一段输出有两个来源**——后台任务里模型直接返回的，
 * 与网页版桥接下用户粘回来的。两边的落库规则必须逐字一致（幂等、只清这一轮的旧记忆、
 * 已经推演过的不再叠加），否则「网页版玩出来的记忆」会和「API 玩出来的」不一样。
 *
 * 输入是**原始文本**而不是解析好的对象：解析层本来就宽容（模型只写一半也能收下），
 * 这个宽容度对粘贴回来的文本同样重要（网页版可能顺手加一句「好的，这是 JSON：」）。
 */
export interface ApplyTurnAnalysisInput {
  repository: Repository;
  roomId: RoomId;
  sceneId: SceneId | null;
  conversationId: ConversationId | null;
  turnId: string;
  /** 这一轮的世界内时间，写进记忆的时间线。 */
  worldTime: string;
  /** 这一轮在场的角色（也是视角条目的候选）。 */
  participants: readonly CharacterInstance[];
  /** 模型或用户粘回来的那段文本。 */
  raw: string;
  /** 落库时间，默认现在。 */
  at?: string;
}

export interface ApplyTurnAnalysisResult {
  /** 写进去的记忆条数（1 条客观 + N 条视角）。 */
  memories: number;
  /** 记了状态变化的角色数。 */
  updates: number;
  /** 抽取结果里提到、但匹配不到角色的名字。 */
  unmatchedSpeakers: string[];
}

export async function applyTurnAnalysis(input: ApplyTurnAnalysisInput): Promise<ApplyTurnAnalysisResult> {
  const repository = input.repository;
  const { extraction, updates } = parseTurnAnalysis(input.raw);
  const at = input.at ?? new Date().toISOString();

  /*
   * 参与者**从库里现取**，而不是用调用方手里的那份快照。
   *
   * 两个理由：① 幂等判断读的是 `affected[].affect.history`，拿旧快照会以为「这一轮没推演过」，
   * 于是重贴一次就把关系翻一倍（写测试时当场撞上）；② 情绪推演是读-改-写，
   * 基于旧快照写回去会把别人刚改的地方压掉。
   */
  const wanted = new Set(input.participants.map((instance) => instance.id));
  const stored = await repository.listInstances(input.roomId);
  const participants = stored.filter((instance) => wanted.has(instance.id));

  const sequence = await repository.nextMemorySequence(input.roomId);
  const { events, unmatchedSpeakers } = buildMemoryEvents({
    roomId: input.roomId,
    sceneId: input.sceneId,
    conversationId: input.conversationId,
    worldTime: input.worldTime,
    sequence,
    participants,
    extraction,
    turnId: input.turnId,
    createdAt: at,
  });

  // 先清掉这一轮可能残留的旧记忆，让重试（或重贴一次）天然幂等
  await repository.deleteMemoriesByTurn(input.roomId, input.turnId);
  await repository.saveMemories(events);

  // 幂等：同一个回合已经推演过就不再叠加，否则重贴会让关系翻倍
  const already = participants.some((instance) =>
    instance.affect.history.some((change) => change.turnId === input.turnId),
  );
  let applied = 0;
  if (!already) {
    // 顺序 27d：状态变化要和刚刚写入的「这个角色眼中的记忆」绑定。
    const sourceMemoryIdsByObserver = new Map<InstanceId, EventId[]>();
    for (const event of events) {
      if (event.observerId === null) continue;
      const current = sourceMemoryIdsByObserver.get(event.observerId) ?? [];
      current.push(event.id);
      sourceMemoryIdsByObserver.set(event.observerId, current);
    }

    const result = applyAffectUpdates(participants, updates, {
      at,
      turnId: input.turnId,
      sourceMemoryIdsByObserver,
    });
    for (const item of result.applied) {
      await repository.saveInstance(item.next);
      applied += 1;
    }
  }

  return { memories: events.length, updates: applied, unmatchedSpeakers };
}
