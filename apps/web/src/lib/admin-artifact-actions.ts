import type { AdminArtifact, CardId, Message, MessageId, Repository, WorldBookId } from '@dramatis/core';

export type ArtifactAction = 'adopt' | 'discard' | 'revoke';
export type ArtifactActionResult =
  | { status: 'confirmed'; message: Message; artifact: AdminArtifact }
  | { status: 'blocked'; message: Message; artifact: AdminArtifact; reason: string }
  | { status: 'missing'; reason: string }
  | { status: 'saved-read-failed'; message: Message; artifact: AdminArtifact; reason: string }
  | { status: 'uncertain'; reason: string };
type Receipt = { pending: boolean; attempted: boolean; action: ArtifactAction };
const receipts = new WeakMap<Repository, Map<string, Receipt>>();
const key = (messageId: MessageId, artifactId: string) => JSON.stringify([messageId, artifactId]);
const desired = (action: ArtifactAction) =>
  action === 'adopt' ? 'adopted' : action === 'discard' ? 'discarded' : 'pending';
const uncertain = (reason = '保存结果待核对，请先核对记录，不要重复操作。'): ArtifactActionResult => ({
  status: 'uncertain',
  reason,
});
async function read(repository: Repository, messageId: MessageId, artifactId: string) {
  const message = await repository.readAdminMessage(messageId),
    artifact = message?.artifacts?.find((a) => a.id === artifactId);
  return message && artifact ? { message, artifact } : null;
}
export async function inspectAdminArtifactAction(
  repository: Repository,
  messageId: MessageId,
  artifactId: string,
  action: ArtifactAction,
): Promise<ArtifactActionResult> {
  const map = receipts.get(repository),
    receipt = map?.get(key(messageId, artifactId));
  if (receipt?.pending) return uncertain('操作仍在处理中，请等待。');
  try {
    const value = await read(repository, messageId, artifactId);
    if (!value) return { status: 'missing', reason: '这份草稿记录已不存在。' };
    if (receipt && !receipt.attempted) {
      map?.delete(key(messageId, artifactId));
      return { ...value, status: 'blocked', reason: '上次未开始写入，可以重新操作。' };
    }
    const wanted = receipt?.action ?? action;
    if (value.artifact.conflict && wanted === 'adopt' && !receipt)
      return { ...value, status: 'blocked', reason: value.artifact.conflict };
    if (value.artifact.status !== desired(wanted)) return uncertain();
    if (wanted !== 'discard') {
      const artifact = value.artifact,
        payload = artifact.payload as { id?: unknown } | null;
      const id = artifact.targetId ?? (typeof payload?.id === 'string' ? payload.id : null);
      if (!id) return uncertain('缺少可核对的目标，未再次执行。');
      const entity =
        artifact.kind === 'character-card'
          ? await repository.getCard(id as CardId)
          : artifact.kind === 'world-book'
            ? await repository.getWorldBook(id as WorldBookId)
            : await repository.getPersona(id);
      const shouldExist =
        wanted === 'adopt'
          ? artifact.kind !== 'persona-delete'
          : artifact.kind === 'persona-upsert' && artifact.previousPayload !== undefined;
      if (shouldExist ? !entity : entity !== null) return uncertain('目标与操作记录尚未一致，未再次执行。');
    }
    map?.delete(key(messageId, artifactId));
    return { ...value, status: 'confirmed' };
  } catch (error) {
    return uncertain(error instanceof Error ? error.message : String(error));
  }
}
export async function performAdminArtifactAction(
  repository: Repository,
  messageId: MessageId,
  artifactId: string,
  action: ArtifactAction,
): Promise<ArtifactActionResult> {
  let map = receipts.get(repository);
  if (!map) {
    map = new Map();
    receipts.set(repository, map);
  }
  const id = key(messageId, artifactId);
  if (map.has(id)) return uncertain(map.get(id)?.pending ? '操作仍在处理中，请等待。' : undefined);
  const receipt: Receipt = { pending: true, attempted: false, action };
  map.set(id, receipt);
  try {
    const before = await read(repository, messageId, artifactId);
    if (!before) {
      map.delete(id);
      return { status: 'missing', reason: '这份草稿记录已不存在。' };
    }
    if (
      (before.artifact.kind === 'scene' && action !== 'discard') ||
      (before.artifact.kind === 'persona-delete' && action === 'revoke')
    ) {
      map.delete(id);
      return { ...before, status: 'blocked', reason: '这项结果不支持此操作。' };
    }
    if (before.artifact.status !== (action === 'revoke' ? 'adopted' : 'pending')) {
      map.delete(id);
      return { ...before, status: 'blocked', reason: '状态已变化，请查看当前结果。' };
    }
    receipt.attempted = true;
    const result =
      action === 'adopt'
        ? await repository.adoptAdminArtifact(messageId, artifactId)
        : action === 'revoke'
          ? await repository.revokeAdminArtifact(messageId, artifactId)
          : await repository.discardAdminArtifact(messageId, artifactId);
    const message = result && 'message' in result ? result.message : result;
    const artifact = message?.artifacts?.find((a) => a.id === artifactId);
    if (!message || !artifact) return uncertain();
    if (action === 'adopt' && artifact.conflict) {
      map.delete(id);
      return { status: 'blocked', message, artifact, reason: artifact.conflict };
    }
    if (artifact.status !== desired(action)) return uncertain();
    map.delete(id);
    return { status: 'confirmed', message, artifact };
  } catch (error) {
    return uncertain(`保存结果待核对。${error instanceof Error ? error.message : String(error)}`);
  } finally {
    receipt.pending = false;
  }
}
