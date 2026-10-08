import type { ConversationId, EventId, InstanceId, RoomId, SceneId } from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import type { Repository } from '../storage/repository.js';
import { applyAffectUpdates, parseAffectUpdates } from './affect.js';
import {
  type AnalysisReceipt,
  analysisReceiptKey,
  analysisRevision,
  readAnalysisGeneration,
  StaleTurnAnalysisError,
  type TurnAnalysisSource,
  verifyTurnAnalysisSource,
} from './analysis-revision.js';
import { buildMemoryEvents } from './ingest.js';
import { parseTurnAnalysis } from './turn-analysis.js';

export interface ApplyTurnAnalysisInput {
  repository: Repository;
  roomId: RoomId;
  sceneId: SceneId | null;
  conversationId: ConversationId | null;
  turnId: string;
  worldTime: string;
  participants: readonly CharacterInstance[];
  raw: string;
  at?: string;
  /** Capture before the model call. Missing only for the legacy pasted-analysis caller. */
  source?: TurnAnalysisSource;
  /** Old queued extraction/affect jobs share the same generation and completion receipt. */
  mode?: 'combined' | 'memory' | 'affect';
}
export interface ApplyTurnAnalysisResult {
  memories: number;
  updates: number;
  unmatchedSpeakers: string[];
  /** Existing unmarked memories cannot prove whether a past state update was applied. */
  legacyPreserved: boolean;
}
function hasUnrevertedEffect(instance: CharacterInstance, turnId: string): boolean {
  return [instance.affect.history, ...instance.relationships.map((edge) => edge.history)].some((history) => {
    const reverted = new Set(history.map((change) => change.reversionOf).filter((id) => id !== null));
    return history.some(
      (change) => change.turnId === turnId && change.reversionOf === null && !reverted.has(change.id),
    );
  });
}
function checkedReceipt(value: AnalysisReceipt | null): AnalysisReceipt | null {
  if (value === null) return null;
  if (
    value.version !== 1 ||
    typeof value.generation !== 'string' ||
    typeof value.memoryWritten !== 'boolean' ||
    typeof value.effectsComplete !== 'boolean' ||
    typeof value.legacyPreserved !== 'boolean' ||
    !(value.sourceRevision === null || typeof value.sourceRevision === 'string')
  )
    throw new Error('分析完成凭证损坏，未改写记忆或角色状态。');
  return value;
}

/** Source verification, memory/state writes and completion receipt commit together or all roll back. */
export async function applyTurnAnalysis(input: ApplyTurnAnalysisInput): Promise<ApplyTurnAnalysisResult> {
  const { extraction, updates: combinedUpdates } = parseTurnAnalysis(input.raw);
  const updates = input.mode === 'affect' ? parseAffectUpdates(input.raw) : combinedUpdates;
  const at = input.at ?? new Date().toISOString();
  // No WebCrypto await inside an IndexedDB transaction.
  if (input.source && (await analysisRevision(input.source.snapshot)) !== input.source.revision)
    throw new StaleTurnAnalysisError();
  const scope = {
    roomId: input.roomId,
    sceneId: input.sceneId,
    conversationId: input.conversationId,
    turnId: input.turnId,
  };
  return input.repository.atomic(async (repository, store) => {
    if (input.source) await verifyTurnAnalysisSource(repository, store, scope, input.source);
    const generation = await readAnalysisGeneration(repository, input.roomId, input.turnId);
    const previous = checkedReceipt(
      await repository.getMeta<AnalysisReceipt>(analysisReceiptKey(input.roomId, input.turnId)),
    );
    const receipt = previous?.generation === generation ? previous : null;
    if (receipt?.sourceRevision && input.source && receipt.sourceRevision !== input.source.revision) {
      throw new StaleTurnAnalysisError('这轮已有其他修订的分析，必须先撤销旧分析再应用新修订。');
    }
    const wanted = new Set(input.participants.map((instance) => instance.id));
    const participants = (await repository.listInstances(input.roomId)).filter((instance) => wanted.has(instance.id));
    const existing = (await repository.listMemories(input.roomId)).filter((memory) =>
      memory.sourceTurnIds.includes(input.turnId),
    );
    // No migration/backfill: old histories can have been pruned. Absence is not proof of non-application.
    const legacyPreserved = receipt?.legacyPreserved ?? (previous === null && existing.length > 0);
    const writeMemory = input.mode !== 'affect';
    const writeEffects = input.mode !== 'memory';
    let events = existing;
    let unmatchedSpeakers: string[] = [];
    if (writeMemory) {
      const sequence = await repository.nextMemorySequence(input.roomId);
      const built = buildMemoryEvents({
        ...scope,
        worldTime: input.worldTime,
        sequence,
        participants,
        extraction,
        createdAt: at,
      });
      events = built.events;
      unmatchedSpeakers = built.unmatchedSpeakers;
      // Preserve existing pasted-memory replacement semantics (A08 is not decided here).
      await repository.deleteMemoriesByTurn(input.roomId, input.turnId);
      await repository.saveMemories(events);
    }
    let applied = 0;
    if (writeEffects && !receipt?.effectsComplete && !legacyPreserved) {
      const sourceMemoryIdsByObserver = new Map<InstanceId, EventId[]>();
      for (const event of events) {
        if (event.observerId === null) continue;
        const ids = sourceMemoryIdsByObserver.get(event.observerId) ?? [];
        ids.push(event.id);
        sourceMemoryIdsByObserver.set(event.observerId, ids);
      }
      // Per-participant legacy guard also checks relationship-only history, not just affect.
      const eligible = participants.filter((instance) => !hasUnrevertedEffect(instance, input.turnId));
      const result = applyAffectUpdates(eligible, updates, { at, turnId: input.turnId, sourceMemoryIdsByObserver });
      for (const item of result.applied) {
        await repository.saveInstance(item.next);
        applied++;
      }
    }
    await repository.setMeta<AnalysisReceipt>(analysisReceiptKey(input.roomId, input.turnId), {
      version: 1,
      generation,
      sourceRevision: input.source?.revision ?? receipt?.sourceRevision ?? null,
      memoryWritten: writeMemory || receipt?.memoryWritten === true,
      effectsComplete: writeEffects || receipt?.effectsComplete === true,
      legacyPreserved,
    });
    return { memories: writeMemory ? events.length : 0, updates: applied, unmatchedSpeakers, legacyPreserved };
  });
}
