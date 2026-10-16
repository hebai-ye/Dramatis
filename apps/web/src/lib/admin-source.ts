import {
  type AdminArtifact,
  type AdminDraft,
  buildAdminBridgeMessages,
  type ConversationId,
  createSceneFor,
  createTurnId,
  type MessageId,
  messageId,
  newId,
  nowIso,
  parseAdminBridgeOutput,
  parseAdminToolCall,
  type Repository,
  type RoomId,
  renderPromptForWeb,
} from '@dramatis/core';
import type { AdminSceneTarget } from './admin-scene-effect';

export interface AdminSourceCommitResult {
  message: import('@dramatis/core').Message;
  sceneTargets: { artifactId: string; target: AdminSceneTarget }[];
  notes: string[];
}

interface AdminScope {
  accountKey: string;
  roomId: RoomId;
  conversationId: ConversationId;
}
export interface ScopedAdminBridge {
  prompt: string;
  binding: AdminScope & { version: 1; revision: string; worldTitle: string; conversationTitle: string };
}
function stale(message = '起草来源已经变化，未应用旧内容；请回到原世界与副对话，或放弃后重新准备。'): Error {
  return new Error(message);
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
async function revision(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function readSource(repository: Repository, scope: AdminScope) {
  const room = await repository.getRoom(scope.roomId);
  const conversation = await repository.getConversation(scope.conversationId);
  if (
    !room ||
    !conversation ||
    conversation.roomId !== room.id ||
    conversation.kind !== 'side' ||
    conversation.archivedAt !== null
  )
    throw stale();
  const conversations = await repository.listConversations(room.id);
  const main =
    conversations
      .filter((item) => item.kind === 'main' && item.archivedAt === null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  const scene = main?.activeSceneId ? await repository.getScene(main.activeSceneId) : null;
  if (scene && (scene.roomId !== room.id || scene.conversationId !== main?.id)) throw stale();
  const cards = await repository.listCards();
  const worldBooks = await repository.listWorldBooks();
  const personas = await repository.listPersonas();
  const instances = await repository.listInstances(room.id);
  const history = await repository.listMessages(room.id, { conversationId: conversation.id });
  // Navigation writes room.activeConversationId/updatedAt; it does not change prompt source.
  const source = JSON.stringify(
    canonical({
      scope: { accountKey: scope.accountKey, roomId: scope.roomId, conversationId: scope.conversationId },
      room: {
        id: room.id,
        title: room.title,
        playerName: room.playerName,
        playerPersona: room.playerPersona,
        cardIds: room.cardIds,
        worldBookIds: room.worldBookIds,
        instanceIds: room.instanceIds,
      },
      conversation,
      main: main && { id: main.id, activeSceneId: main.activeSceneId, stateSnapshot: main.stateSnapshot },
      scene,
      cards,
      worldBooks,
      personas,
      instances,
      history,
    }),
  );
  return { room, conversation, main, scene, cards, worldBooks, personas, instances, history, source };
}
export async function prepareAdminSource(
  repository: Repository,
  scope: AdminScope,
  input: string,
  playerMessageId: MessageId,
): Promise<ScopedAdminBridge> {
  const source = await repository.atomic((tx) => readSource(tx, scope));
  const history = source.history.filter((message) => message.id !== playerMessageId);
  return {
    prompt: renderPromptForWeb(
      buildAdminBridgeMessages({
        room: source.room,
        conversation: source.conversation,
        scene: null,
        cards: source.cards,
        worldBooks: source.worldBooks,
        personas: source.personas,
        instances: source.instances,
        history,
        userInput: input,
        pendingDrafts: history
          .flatMap((message) => message.artifacts ?? [])
          .filter((item) => item.status === 'pending')
          .map((item) => item.summary),
      }),
    ),
    binding: {
      ...scope,
      version: 1,
      revision: await revision(source.source),
      worldTitle: source.room.title,
      conversationTitle: source.conversation.title,
    },
  };
}
export async function commitAdminSource(input: {
  repository: Repository;
  bridge: ScopedAdminBridge;
  current: AdminScope;
  raw: string;
  messageId?: MessageId;
  onCommitStart?: () => void;
  isCurrent: () => boolean;
  artifactFor: (draft: AdminDraft) => AdminArtifact;
}): Promise<AdminSourceCommitResult> {
  const binding = input.bridge.binding;
  if (binding?.version !== 1 || !/^[a-f0-9]{64}$/.test(binding.revision))
    throw stale('这份旧起草缺少有效来源，请放弃旧进度并重新准备。');
  const matches = () =>
    input.isCurrent() &&
    binding.accountKey === input.current.accountKey &&
    binding.roomId === input.current.roomId &&
    binding.conversationId === input.current.conversationId;
  if (!matches()) throw stale();
  const before = await input.repository.atomic((tx) => readSource(tx, binding));
  if (!matches() || (await revision(before.source)) !== binding.revision) throw stale();
  const parsed = parseAdminBridgeOutput(input.raw);
  const drafts: AdminDraft[] = [];
  const notes: string[] = [];
  if (parsed.invalid.length) notes.push(`未执行未知工具：${parsed.invalid.join('、')}。`);
  for (const call of parsed.calls) {
    const result = parseAdminToolCall(call, {
      knownCardIds: before.cards.map((card) => card.id),
      knownBookIds: before.worldBooks.map((book) => book.id),
      cards: before.cards,
      worldBooks: before.worldBooks,
      knownPersonas: before.personas,
    });
    if (!result.ok) {
      notes.push(`未执行：${result.error}`);
      continue;
    }
    if (result.unknownArgs?.length) notes.push(`未使用参数：${result.unknownArgs.join('、')}。`);
    drafts.push(result.draft);
  }
  const id = input.messageId ?? messageId(newId());
  const at = nowIso();
  input.onCommitStart?.();
  return input.repository.atomic(async (tx) => {
    const latest = await readSource(tx, binding);
    if (!matches() || latest.source !== before.source) throw stale();
    const artifacts: AdminArtifact[] = [];
    const sceneTargets: AdminSourceCommitResult['sceneTargets'] = [];
    let activeScene = latest.scene;
    for (const draft of drafts) {
      if (!matches()) throw stale();
      const artifact = input.artifactFor(draft);
      if (draft.kind === 'scene' && latest.main) {
        const next = activeScene
          ? {
              ...activeScene,
              ...draft.patch,
              id: activeScene.id,
              roomId: activeScene.roomId,
              conversationId: activeScene.conversationId,
            }
          : createSceneFor(
              latest.room.id,
              latest.main.id,
              latest.main.stateSnapshot.map((item) => item.instanceId),
              draft.patch,
            );
        await tx.saveScene(next);
        if (!activeScene) await tx.saveConversation({ ...latest.main, activeSceneId: next.id });
        activeScene = next;
        artifacts.push({ ...artifact, status: 'applied' });
        sceneTargets.push({
          artifactId: artifact.id,
          target: {
            roomId: latest.room.id,
            worldTitle: latest.room.title,
            conversationId: latest.main.id,
            conversationTitle: latest.main.title,
            sceneId: next.id,
            sceneTitle: next.title,
          },
        });
      } else artifacts.push(draft.kind === 'scene' ? { ...artifact, status: 'pending' } : artifact);
    }
    if (!matches()) throw stale();
    const content =
      [parsed.answer.trim(), ...notes].filter(Boolean).join('\n\n') ||
      (artifacts.length
        ? '草稿已放在下面；场景标明了是否已生效，其他素材由你决定去留。'
        : '这次没有可应用的素材，请补充起草要求。');
    const messages = await tx.appendMessages(binding.roomId, [
      {
        id,
        roomId: binding.roomId,
        conversationId: binding.conversationId,
        sceneId: null,
        turnId: createTurnId(),
        localSeq: 0,
        deviceId: '',
        role: 'admin',
        speakerInstanceId: null,
        speakerName: '世界管理员',
        audience: [],
        content,
        artifacts,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
      },
    ]);
    const message = messages[0];
    if (!message) throw new Error('管理员回复保存未确认');
    return { message, sceneTargets, notes };
  });
}
