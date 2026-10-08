import { type ConversationId, newId, type RoomId, type SceneId } from '../model/ids.js';
import type { EntityStore } from '../platform/entity-store.js';
import { isTaskLeaseCurrent, type TaskLease } from '../platform/task-lease.js';
import type { Repository } from '../storage/repository.js';

export interface TurnAnalysisScope {
  roomId: RoomId;
  sceneId: SceneId | null;
  conversationId: ConversationId | null;
  turnId: string;
}
export interface TurnAnalysisSource {
  readonly scope: TurnAnalysisScope;
  readonly generation: string;
  /** Exact input snapshot in memory only; never persisted in a task/receipt. */
  readonly snapshot: string;
  readonly revision: string;
  readonly task?: TaskLease;
}
export interface AnalysisReceipt {
  version: 1;
  generation: string;
  sourceRevision: string | null;
  memoryWritten: boolean;
  effectsComplete: boolean;
  legacyPreserved: boolean;
}
export class StaleTurnAnalysisError extends Error {
  readonly code = 'stale-turn-analysis';
  constructor(message = '这轮分析的消息、上下文或任务已失效，未写入旧结果。') {
    super(message);
  }
}
export function analysisGenerationKey(roomId: RoomId, turnId: string): string {
  return `analysis.generation.v1:${JSON.stringify([roomId, turnId])}`;
}
export function analysisReceiptKey(roomId: RoomId, turnId: string): string {
  return `analysis.receipt.v1:${JSON.stringify([roomId, turnId])}`;
}
export async function readAnalysisGeneration(repository: Repository, roomId: RoomId, turnId: string): Promise<string> {
  const value = await repository.getMeta<unknown>(analysisGenerationKey(roomId, turnId));
  if (value === null) return 'initial';
  if (typeof value !== 'string' || value === '') throw new Error('分析世代标记损坏，未修改数据。');
  return value;
}
/** Must run in the SAME transaction as a turn rollback/rewrite. No historical data migration. */
export async function invalidateTurnAnalysis(repository: Repository, roomId: RoomId, turnId: string): Promise<void> {
  await repository.setMeta(analysisGenerationKey(roomId, turnId), newId());
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export async function analysisRevision(snapshot: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function readContext(repository: Repository, store: EntityStore, scope: TurnAnalysisScope, task?: TaskLease) {
  if (task && !(await isTaskLeaseCurrent(store, task, scope))) return null;
  const room = await repository.getRoom(scope.roomId);
  if (!room) return null;
  const conversation = scope.conversationId === null ? null : await repository.getConversation(scope.conversationId);
  if (
    scope.conversationId !== null &&
    (!conversation || conversation.roomId !== scope.roomId || conversation.archivedAt !== null)
  )
    return null;
  const scene = scope.sceneId === null ? null : await repository.getScene(scope.sceneId);
  if (
    scope.sceneId !== null &&
    (!scene || scene.roomId !== scope.roomId || scene.conversationId !== scope.conversationId)
  )
    return null;
  const turn = (await repository.listMessages(scope.roomId)).filter((message) => message.turnId === scope.turnId);
  if (
    turn.length === 0 ||
    turn.some((message) => message.conversationId !== scope.conversationId || message.sceneId !== scope.sceneId)
  )
    return null;
  const audience = new Set(turn.flatMap((message) => message.audience));
  const participants = (await repository.listInstances(scope.roomId)).filter((instance) => audience.has(instance.id));
  const generation = await readAnalysisGeneration(repository, scope.roomId, scope.turnId);
  // Re-read current affect/relationships at commit, never overwrite them from model input.
  // They are not source revision fields: our own successful effects change them on retry.
  const snapshot = JSON.stringify(
    canonical({
      scope,
      generation,
      messages: turn,
      room: { id: room.id, playerName: room.playerName, playerPersona: room.playerPersona },
      conversation: conversation && {
        id: conversation.id,
        updatedAt: conversation.updatedAt,
        archivedAt: conversation.archivedAt,
      },
      scene: scene && {
        id: scene.id,
        updatedAt: scene.updatedAt,
        location: scene.location,
        worldTime: scene.worldTime,
        cast: scene.cast,
      },
      participants: participants
        .map((p) => ({ id: p.id, displayName: p.displayName, cardId: p.cardId }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }),
  );
  return { room, scene, messages: turn, participants, generation, snapshot };
}
/** Capture transaction ends BEFORE hashing/network calls; same exact source is re-read at commit. */
export async function captureTurnAnalysis(repository: Repository, scope: TurnAnalysisScope, task?: TaskLease) {
  const context = await repository.atomic((repo, store) => readContext(repo, store, scope, task));
  if (context === null) return null;
  const source: TurnAnalysisSource = {
    scope: { ...scope },
    generation: context.generation,
    snapshot: context.snapshot,
    revision: await analysisRevision(context.snapshot),
    ...(task ? { task: { ...task } } : {}),
  };
  return { ...context, source };
}
/** Call ONLY inside the write transaction. No hashing, timers or network awaits here. */
export async function verifyTurnAnalysisSource(
  repository: Repository,
  store: EntityStore,
  scope: TurnAnalysisScope,
  source: TurnAnalysisSource,
): Promise<void> {
  if (JSON.stringify(canonical(scope)) !== JSON.stringify(canonical(source.scope))) throw new StaleTurnAnalysisError();
  const current = await readContext(repository, store, scope, source.task);
  if (current === null || current.generation !== source.generation || current.snapshot !== source.snapshot)
    throw new StaleTurnAnalysisError();
}
