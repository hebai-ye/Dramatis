import {
  type AdminArtifact,
  type AdminDraft,
  type ConversationId,
  createOpenAICompatibleProvider,
  createPlayerMessage,
  createTurnId,
  type Message,
  type MessageId,
  type MessageUsage,
  messageId,
  needsWebBridge,
  newId,
  nowIso,
  type RoomId,
} from '@dramatis/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AdminProcessScope,
  type AdminRunIssue,
  type AdminRunPhase,
  adminProcessStore,
  sameAdminScope,
} from './admin-process-store';
import type { AdminSceneEffect } from './admin-scene-effect';
import type { ScopedAdminBridge } from './admin-source';
import { loadBridge, saveBridge } from './bridge-store';
import type { SubmitOutcome } from './chat-draft';
import type { DramatisDb } from './db';
import type { ProvidersApi } from './providers';
import type { SessionApi } from './session';
import { handoffStreamState, resetStreamState, setStreamState } from './stream-store';

export type BridgeCommitOutcome =
  | { status: 'confirmed'; messageId: MessageId }
  | { status: 'saved-read-failed'; messageId: MessageId; reason: string }
  | { status: 'rejected' | 'uncertain'; reason: string };

export interface AdminChatApi {
  processScope: AdminProcessScope | null;
  activeRunId: string | null;
  canStop: boolean;
  needsInspection: boolean;
  inspectRun: () => Promise<BridgeCommitOutcome>;
  busy: boolean;
  error: string | null;
  send: (
    text: string,
    targetOrAcceptance?: ConversationId | ((outcome: SubmitOutcome) => void),
    onAcceptance?: (outcome: SubmitOutcome) => void,
  ) => Promise<SubmitOutcome>;
  stop: () => void;
  /**
   * 没有 API Key 时的网页版桥接（副对话）。
   *
   * 非 null 表示「正等着用户把网页版的输出贴回来」。管理员要调用工具，所以贴回来的
   * 东西里除了正文还有 `{"tool":…,"arguments":{…}}` 代码块——解析之后走的是与 API
   * 那条路**同一套校验与执行**（`parseAdminToolCall` → `execute`）。
   */
  bridge: AdminBridge | null;
  commitBridge: (raw: string) => Promise<BridgeCommitOutcome>;
  inspectBridge: () => Promise<BridgeCommitOutcome>;
  cancelBridge: () => void;
}

interface AdminRequestScope {
  roomId: RoomId;
  conversationId: ConversationId;
  targetConversationId: ConversationId | null;
  targetName: string | null;
}
interface AdminBridge extends Partial<AdminRequestScope> {
  prompt: string;
  binding?: ScopedAdminBridge['binding'];
}

function draftToArtifact(draft: AdminDraft): AdminArtifact {
  const base = { id: newId(), createdAt: nowIso(), targetId: null };

  switch (draft.kind) {
    case 'character-card':
      return {
        ...base,
        kind: 'character-card',
        title: draft.card.name,
        summary: draft.summary,
        // 草稿先留在消息上，用户点「采纳」才进素材库
        status: 'pending',
        payload: draft.card,
        // 起草时那张卡的版本；采纳路径照它判断草稿是否已经过期（顺序 86，审计 B6）
        baseUpdatedAt: draft.baseUpdatedAt,
      };
    case 'world-book':
      return {
        ...base,
        kind: 'world-book',
        title: draft.book.name,
        summary: draft.summary,
        status: 'pending',
        payload: draft.book,
        previousPayload: draft.previous,
        baseUpdatedAt: draft.baseUpdatedAt,
      };
    case 'persona-upsert':
      return {
        ...base,
        kind: 'persona-upsert',
        title: draft.persona.name,
        summary: draft.summary,
        status: 'pending',
        payload: draft.persona,
        ...(draft.previous === null ? {} : { previousPayload: draft.previous }),
      };
    case 'persona-delete':
      return {
        ...base,
        kind: 'persona-delete',
        title: draft.name,
        summary: draft.summary,
        status: 'pending',
        payload: { id: draft.personaId, name: draft.name },
      };
    default:
      return {
        ...base,
        kind: 'scene',
        title: draft.patch.title ?? '当前场景',
        summary: draft.summary,
        // 场景是即时生效的：用户马上就该看到地点变了
        status: 'applied',
        payload: draft.patch,
      };
  }
}

/**
 * 副对话（LAYOUT「副对话状态」）。
 *
 * 这里跑的是 AI 工作流而不是角色扮演：模型是世界管理员，产出的是角色卡、
 * 世界书与场景设置。**真的调用工具**——模型请求、我们执行、再把结果回填。
 * 角色卡与世界书先落成草稿挂在消息上，由用户决定去留。
 */
export function useAdminChat(options: {
  db: DramatisDb | null;
  session: SessionApi;
  providers: ProvidersApi;
  accountKey: string;
  onChanged: () => void;
}): AdminChatApi {
  const { db, session, providers, accountKey, onChanged } = options;
  const currentRef = useRef(options);
  currentRef.current = options;
  const roomId = session.world?.id,
    conversationId = session.conversation?.id;
  const scope = useMemo<AdminProcessScope | null>(
    () => (db && roomId && conversationId ? { db, accountKey, roomId, conversationId } : null),
    [db, accountKey, roomId, conversationId],
  );
  type Operation = {
    scope: AdminProcessScope;
    runId: string;
    controller: AbortController | null;
    busy: boolean;
    canStop: boolean;
  };
  const activeRef = useRef<Operation | null>(null);
  const bridgeAttempt = useRef<{ scope: AdminProcessScope; id: MessageId; uncertain: boolean } | null>(null);
  const pendingApi = useRef<
    {
      scope: AdminProcessScope;
      id: MessageId;
      runId: string;
      sceneLinks: {
        conversationId: import('@dramatis/core').ConversationId;
        sceneId: import('@dramatis/core').SceneId;
      }[];
    }[]
  >([]);
  const [ui, setUi] = useState<{
    scope: AdminProcessScope | null;
    runId: string | null;
    busy: boolean;
    canStop: boolean;
    error: string | null;
  }>({ scope: null, runId: null, busy: false, canStop: false, error: null });
  const [bridge, setBridge] = useState<AdminBridge | null>(() => loadBridge<AdminBridge>('admin'));
  useEffect(() => {
    saveBridge('admin', bridge);
  }, [bridge]);
  const previous = activeRef.current;
  if (previous && !sameAdminScope(previous.scope, scope)) {
    previous.controller?.abort();
    adminProcessStore.leave(previous.scope);
    resetStreamState('admin');
    setUi((current) =>
      sameAdminScope(current.scope, previous.scope) ? { ...current, busy: false, canStop: false } : current,
    );
    if (!scope || previous.scope.db !== scope.db || previous.scope.accountKey !== scope.accountKey)
      adminProcessStore.clearAccount(previous.scope.db, previous.scope.accountKey);
    activeRef.current = null;
  }
  useEffect(
    () => () => {
      const op = activeRef.current;
      if (scope && op && sameAdminScope(op.scope, scope)) {
        op.controller?.abort();
        adminProcessStore.leave(scope);
      }
    },
    [scope],
  );
  const visible = useCallback(
    (op: Operation) =>
      activeRef.current === op &&
      currentRef.current.db === op.scope.db &&
      currentRef.current.accountKey === op.scope.accountKey &&
      currentRef.current.session.world?.id === op.scope.roomId &&
      currentRef.current.session.conversation?.id === op.scope.conversationId,
    [],
  );
  const phase = useCallback(
    (op: Operation, next: AdminRunPhase, issue: AdminRunIssue | null = null) => {
      const stored = adminProcessStore.get(op.scope, { runId: op.runId });
      if (stored?.phase !== next || stored?.issue !== issue) {
        const terminal = [
          'saved',
          'stopped',
          'failed',
          'partial',
          'uncertain',
          'saved-read-failed',
          'saved-accounting-failed',
        ].includes(next);
        if (terminal) adminProcessStore.settle(op.scope, op.runId, { phase: next, issue });
        else adminProcessStore.update(op.scope, op.runId, { phase: next, issue });
      }
      op.canStop =
        op.controller !== null &&
        ['waiting-model', 'receiving-reasoning', 'writing', 'executing', 'waiting-next-model'].includes(next);
      if (visible(op))
        setUi((previous) =>
          sameAdminScope(previous.scope, op.scope) &&
          previous.runId === op.runId &&
          previous.busy === op.busy &&
          previous.canStop === op.canStop &&
          previous.error === (issue?.text ?? null)
            ? previous
            : { scope: op.scope, runId: op.runId, busy: op.busy, canStop: op.canStop, error: issue?.text ?? null },
        );
    },
    [visible],
  );
  const begin = useCallback(
    (resumeRunId?: string) => {
      if (!scope) return null;
      const op: Operation = { scope, runId: resumeRunId ?? newId(), controller: null, busy: true, canStop: false };
      activeRef.current = op;
      if (!resumeRunId || !adminProcessStore.resume(scope, op.runId, Date.now()))
        adminProcessStore.begin(scope, op.runId, Date.now());
      phase(op, 'saving-input');
      return op;
    },
    [scope, phase],
  );
  const finish = useCallback(
    (op: Operation) => {
      op.busy = false;
      op.canStop = false;
      if (visible(op)) setUi((previous) => ({ ...previous, busy: false, canStop: false }));
      adminProcessStore.settle(op.scope, op.runId, { endedAt: Date.now() });
    },
    [visible],
  );
  const send = useCallback(
    async (
      text: string,
      targetOrAcceptance?: ConversationId | ((outcome: SubmitOutcome) => void),
      onAcceptance?: (outcome: SubmitOutcome) => void,
    ): Promise<SubmitOutcome> => {
      const targetConversationId = typeof targetOrAcceptance === 'string' ? targetOrAcceptance : undefined;
      const accepted = typeof targetOrAcceptance === 'function' ? targetOrAcceptance : onAcceptance;
      if (scope && pendingApi.current.some((p) => sameAdminScope(p.scope, scope)))
        return { status: 'uncertain', reason: '上一轮保存结果待核对，正文和草稿已保留；请先只读核对。' };
      let outcome: SubmitOutcome = {
        status: 'rejected',
        reason: bridge ? '还有网页版回复等待处理，请回原来源处理。' : '当前副对话还未准备好，输入已保留。',
      };
      const world = session.world,
        conversation = session.conversation;
      if (
        !db ||
        !scope ||
        !world ||
        !conversation ||
        conversation.kind !== 'side' ||
        conversation.archivedAt !== null ||
        conversation.deletedAt !== null ||
        bridge ||
        activeRef.current?.busy
      )
        return outcome;
      const profile = providers.active;
      if (!profile) {
        setUi({ scope, runId: null, busy: false, canStop: false, error: '还没有模型配置' });
        return outcome;
      }
      const op = begin();
      if (!op) return outcome;
      resetStreamState('admin');
      const mains = session.conversations.filter(
        (item) =>
          item.roomId === world.id && item.kind === 'main' && item.archivedAt === null && item.deletedAt === null,
      );
      const requestedTarget = targetConversationId ?? (mains.length === 1 ? mains[0]?.id : undefined);
      let target = null;
      let targetScene = null;
      try {
        target = requestedTarget ? await db.repository.getConversation(requestedTarget) : null;
        if (
          target &&
          (target.roomId !== world.id ||
            target.kind !== 'main' ||
            target.archivedAt !== null ||
            target.deletedAt !== null)
        )
          target = null;
        targetScene = target?.activeSceneId ? await db.repository.getScene(target.activeSceneId) : null;
        if (
          targetScene &&
          (targetScene.roomId !== world.id ||
            targetScene.conversationId !== target?.id ||
            targetScene.deletedAt !== null)
        )
          targetScene = null;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        phase(op, 'failed', { kind: 'error', text: reason });
        finish(op);
        return { status: 'rejected', reason };
      }
      if (!visible(op)) {
        finish(op);
        return outcome;
      }
      const requestScope: AdminRequestScope = {
        roomId: world.id,
        conversationId: conversation.id,
        targetConversationId: target?.id ?? null,
        targetName: target?.title ?? null,
      };
      const history = session.messages;
      const player = createPlayerMessage({
        roomId: world.id,
        conversationId: conversation.id,
        sceneId: null,
        turnId: createTurnId(),
        speakerName: world.playerName,
        content: text,
        audience: [],
      });
      const accept = () => {
        outcome = { status: 'accepted' };
        accepted?.(outcome);
      };
      try {
        await session.appendMessages([player], accept);
        if (!visible(op)) throw new Error('起草来源已经变化');
        phase(op, 'preparing');
        if (needsWebBridge(providers.apiKey)) {
          const { prepareAdminSource } = await import('./admin-source');
          const source = await prepareAdminSource(
            db.repository,
            { accountKey, roomId: world.id, conversationId: conversation.id },
            text,
            player.id,
            requestScope.targetConversationId,
          );
          if (!visible(op)) throw new Error('起草来源已经变化，未发布旧提示词。');
          const prepared: AdminBridge = { ...source, ...requestScope };
          saveBridge('admin', prepared, true);
          setBridge(prepared);
          phase(op, 'preparing');
          finish(op);
          return outcome;
        }
      } catch (error) {
        if (outcome.status !== 'accepted')
          outcome = { status: 'uncertain', reason: '保存结果未确认，输入已保留；请先核对消息记录。' };
        phase(op, outcome.status === 'uncertain' ? 'uncertain' : 'failed', {
          kind: outcome.status === 'uncertain' ? 'uncertain' : 'error',
          text: error instanceof Error ? error.message : String(error),
        });
        finish(op);
        return outcome;
      }
      op.controller = new AbortController();
      const controller = op.controller;
      const artifacts: AdminArtifact[] = [];
      let answer = '',
        persisted = false,
        handedOff = false,
        saveAttempted = false;
      let usage: MessageUsage | null = null;
      const outputId = messageId(newId()),
        outputTurnId = createTurnId();
      const rememberUncertain = () => {
        if (!pendingApi.current.some((p) => p.id === outputId))
          pendingApi.current.push({
            scope: op.scope,
            id: outputId,
            runId: op.runId,
            sceneLinks: (adminProcessStore.get(op.scope, { runId: op.runId })?.sceneEffects ?? [])
              .filter((e) => !e.activeLinked)
              .map((e) => ({ conversationId: e.target.conversationId, sceneId: e.target.sceneId })),
          });
      };
      const buildMessage = (content: string): Message => ({
        id: outputId,
        roomId: world.id,
        conversationId: conversation.id,
        sceneId: null,
        turnId: outputTurnId,
        localSeq: 0,
        deviceId: '',
        role: 'admin',
        speakerInstanceId: null,
        speakerName: '世界管理员',
        audience: [],
        content,
        ...(usage ? { usage } : {}),
        ...(artifacts.length ? { artifacts: [...artifacts] } : {}),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        deletedAt: null,
      });
      const handoff = () => {
        adminProcessStore.bindMessage(op.scope, op.runId, outputId);
        adminProcessStore.update(op.scope, op.runId, { unsaved: null });
        if (visible(op)) {
          handoffStreamState('admin', outputId);
          handedOff = true;
        }
      };
      try {
        const provider = createOpenAICompatibleProvider({
          baseUrl: profile.baseUrl,
          apiKey: providers.apiKey,
          model: profile.model,
          includeUsage: true,
        });
        const { buildAdminMessages, runAdminTurn } = await import('./admin-engine');
        for await (const event of runAdminTurn(
          provider,
          buildAdminMessages({
            room: world,
            conversation,
            scene: targetScene,
            ...(requestScope.targetConversationId
              ? {
                  targetConversationId: requestScope.targetConversationId,
                  targetName: requestScope.targetName ?? undefined,
                }
              : {}),
            instances: session.instances,
            cards: session.library.cards,
            worldBooks: session.library.worldBooks,
            personas: session.personas,
            history,
            userInput: text,
            pendingDrafts: history
              .flatMap((m) => m.artifacts ?? [])
              .filter((a) => a.status === 'pending')
              .map((a) => a.summary),
          }),
          {
            params: { temperature: profile.temperature },
            signal: controller.signal,
            context: {
              knownCardIds: session.library.cards.map((c) => c.id),
              knownBookIds: session.library.worldBooks.map((b) => b.id),
              cards: session.library.cards,
              worldBooks: session.library.worldBooks,
              knownPersonas: session.personas,
            },
            execute: async (draft, observation) => {
              if (controller.signal.aborted || !visible(op)) throw new Error('起草来源已经变化，已停止执行工具。');
              observation?.markStarted();
              if (draft.kind === 'scene') {
                if (!requestScope.targetConversationId) return '场景未设置：请先选择一条主对话作为目标。';
                let lastEffect: AdminSceneEffect | null = null;
                const artifact = draftToArtifact(draft);
                const recordUnlinked = (effect: AdminSceneEffect) => {
                  artifacts.push({
                    ...artifact,
                    status: 'pending',
                    targetId: effect.scene.id,
                    summary: `目标「${requestScope.targetName ?? requestScope.targetConversationId}」：场景已写入，主对话关联待核对。`,
                  });
                  adminProcessStore.bindSceneTarget(op.scope, op.runId, artifact.id, effect.target);
                  controller.abort();
                };
                let applied: Awaited<ReturnType<SessionApi['setWorldScene']>>;
                try {
                  applied = await session.setWorldScene(
                    draft.patch,
                    requestScope.targetConversationId,
                    requestScope.roomId,
                    (effect) => {
                      lastEffect = effect;
                      adminProcessStore.sceneEffect(op.scope, op.runId, effect);
                    },
                  );
                } catch (error) {
                  const effect = lastEffect as AdminSceneEffect | null;
                  if (effect && !effect.activeLinked) recordUnlinked(effect);
                  throw error;
                }
                const effect = lastEffect as AdminSceneEffect | null;
                if (effect && !effect.activeLinked) {
                  recordUnlinked(effect);
                  throw new Error('场景已写入，主对话关联待核对；已停止本轮后续工具。');
                }
                if (!applied)
                  return `场景未设置：目标「${requestScope.targetName ?? requestScope.targetConversationId}」已失效或世界已切换，请重新选择。`;
                artifacts.push({
                  ...artifact,
                  summary: `目标「${requestScope.targetName ?? requestScope.targetConversationId}」：${artifact.summary}`,
                  targetId: applied.id,
                });
                if (applied && lastEffect)
                  adminProcessStore.bindSceneTarget(
                    op.scope,
                    op.runId,
                    artifact.id,
                    (lastEffect as AdminSceneEffect).target,
                  );
                return applied ? `场景已保存：${draft.summary}` : '未应用：这个世界还没有主对话。';
              }
              artifacts.push(draftToArtifact(draft));
              return `${draft.summary}：草稿已生成，等待本轮保存和用户采纳。`;
            },
            onObservation: (event) => {
              if (!visible(op)) return;
              adminProcessStore.observe(op.scope, op.runId, event, Date.now());
              const observed = adminProcessStore.get(op.scope, { runId: op.runId });
              if (observed) phase(op, observed.phase);
            },
            onDelta: (delta) => {
              if (!visible(op)) return;
              answer += delta;
              setStreamState('admin', { text: answer, phase: 'writing', progress: '' });
              adminProcessStore.update(op.scope, op.runId, { updatedAt: Date.now() });
              phase(op, 'writing');
            },
          },
        )) {
          if (event.type === 'done') {
            answer = event.text || answer;
            usage = event.usage
              ? { promptTokens: event.usage.promptTokens ?? 0, completionTokens: event.usage.completionTokens ?? 0 }
              : null;
          }
        }
        if (!visible(op)) throw new Error('起草来源已经变化，已停止保存旧回复。');
        phase(op, 'saving-output');
        saveAttempted = true;
        await session.appendMessages([
          buildMessage(answer.trim() || (artifacts.length ? '结果见下方。' : '本轮未返回正文。')),
        ]);
        persisted = true;
        handoff();
        const hasFailure = adminProcessStore
          .get(op.scope, { runId: op.runId })
          ?.entries.some((e) => e.event.type === 'tool-end' && !e.event.execution.ok);
        const unlinked =
          adminProcessStore.get(op.scope, { runId: op.runId })?.sceneEffects.some((e) => !e.activeLinked) ?? false;
        const finalPhase = unlinked ? 'uncertain' : hasFailure ? 'partial' : 'saved';
        if (unlinked) rememberUncertain();
        phase(
          op,
          finalPhase,
          unlinked
            ? { kind: 'uncertain', text: '场景已经写入，但主对话关联结果待核对。请先只读核对，不要重复设置。' }
            : null,
        );
        try {
          await db.ledger.record({
            roomId: world.id,
            conversationId: conversation.id,
            turnId: outputTurnId,
            category: 'admin',
            model: profile.model,
            promptTokens: usage?.promptTokens ?? 0,
            completionTokens: usage?.completionTokens ?? 0,
            price: profile.price ?? null,
          });
        } catch (error) {
          phase(op, finalPhase === 'saved' ? 'saved-accounting-failed' : finalPhase, {
            kind: unlinked ? 'uncertain' : 'accounting',
            text: `${unlinked ? '场景关联仍待核对。' : ''}内容已保存，用量记录未完成。${error instanceof Error ? error.message : String(error)}`,
          });
        }
        if (visible(op)) onChanged();
      } catch (error) {
        const note = error instanceof Error ? error.message : String(error);
        let uncertain = saveAttempted;
        if (saveAttempted) {
          try {
            if (await db.repository.readAdminMessage(outputId)) {
              persisted = true;
              uncertain = false;
              handoff();
            }
          } catch {
            /* No write replay without evidence. */
          }
        } else if (artifacts.length && visible(op)) {
          try {
            saveAttempted = true;
            await session.appendMessages([
              buildMessage(`${answer}\n\n${controller.signal.aborted ? '已停止' : '未完成'}：${note}`.trim()),
            ]);
            persisted = true;
            handoff();
          } catch {
            uncertain = true;
          }
        }
        const effects = adminProcessStore.get(op.scope, { runId: op.runId })?.sceneEffects ?? [];
        if (effects.some((e) => !e.activeLinked)) uncertain = true;
        if (uncertain) rememberUncertain();
        adminProcessStore.settle(op.scope, op.runId, {
          unsaved: persisted ? null : { text: answer, artifacts: [...artifacts] },
        });
        phase(
          op,
          uncertain
            ? 'uncertain'
            : persisted || effects.length
              ? 'partial'
              : controller.signal.aborted
                ? 'stopped'
                : 'failed',
          {
            kind: uncertain ? 'uncertain' : 'error',
            text: uncertain
              ? `保存结果待核对，已完成的改动不会重试。${note}`
              : controller.signal.aborted
                ? '已停止，已完成的结果保留。'
                : note,
          },
        );
        if (visible(op)) onChanged();
      } finally {
        if (visible(op) && !handedOff) resetStreamState('admin');
        finish(op);
      }
      return outcome;
    },
    [db, scope, session, providers, accountKey, bridge, onChanged, begin, finish, phase, visible],
  );
  const inspectRun = useCallback(async (): Promise<BridgeCommitOutcome> => {
    if (!db || !scope || activeRef.current?.busy)
      return { status: 'rejected', reason: '请在原来源等待当前操作结束后核对。' };
    const current = ui.runId ? adminProcessStore.get(scope, { runId: ui.runId }) : null;
    const attempt =
      pendingApi.current.find((p) => sameAdminScope(p.scope, scope)) ??
      (current?.phase === 'saved-read-failed' && current.messageId
        ? {
            scope,
            id: current.messageId,
            runId: current.runId,
            sceneLinks: current.sceneEffects
              .filter((effect) => !effect.activeLinked)
              .map((effect) => ({ conversationId: effect.target.conversationId, sceneId: effect.target.sceneId })),
          }
        : null);
    if (!attempt) return { status: 'rejected', reason: '当前没有待核对的保存结果。' };
    const op = begin(attempt.runId);
    if (!op) return { status: 'rejected', reason: '来源不可用' };
    phase(op, 'saving-output');
    let saved = false;
    let knownUnlinked = false;
    try {
      const found = await db.repository.readAdminMessage(attempt.id);
      if (!found || found.roomId !== scope.roomId || found.conversationId !== scope.conversationId)
        throw new Error('尚未读到原回复回执，已保留未确认内容，不能重提。');
      for (const link of attempt.sceneLinks) {
        const conversation = await db.repository.getConversation(link.conversationId),
          scene = await db.repository.getScene(link.sceneId);
        if (
          conversation?.roomId !== scope.roomId ||
          conversation.deletedAt !== null ||
          scene?.roomId !== scope.roomId ||
          scene.conversationId !== link.conversationId ||
          scene.deletedAt !== null
        )
          throw new Error('场景或主对话归属尚未核实；本次仅核对，没有再次设置场景。');
        if (conversation.activeSceneId !== link.sceneId) knownUnlinked = true;
      }
      saved = true;
      pendingApi.current = pendingApi.current.filter((p) => p !== attempt);
      adminProcessStore.bindMessage(scope, op.runId, found.id);
      adminProcessStore.update(scope, op.runId, { unsaved: null });
      if (visible(op)) {
        await session.reloadWorld();
        if (visible(op)) onChanged();
      }
      phase(
        op,
        knownUnlinked ? 'partial' : 'saved',
        knownUnlinked
          ? { kind: 'error', text: '已核实：场景已保存但未设为当前场景。可以重新设置；本次没有重放写入。' }
          : null,
      );
      return { status: 'confirmed', messageId: found.id };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      phase(op, saved ? 'saved-read-failed' : 'uncertain', { kind: saved ? 'read' : 'uncertain', text: reason });
      return saved ? { status: 'saved-read-failed', messageId: attempt.id, reason } : { status: 'uncertain', reason };
    } finally {
      finish(op);
    }
  }, [db, scope, ui.runId, begin, phase, finish, visible, session, onChanged]);
  const commitBridge = useCallback(
    async (raw: string): Promise<BridgeCommitOutcome> => {
      const world = session.world,
        conversation = session.conversation;
      if (bridgeAttempt.current?.uncertain)
        return { status: 'uncertain', reason: '此前提交结果未确认，请只读核对，不能重复应用。' };
      if (
        scope &&
        bridge?.binding &&
        (bridge.binding.accountKey !== scope.accountKey ||
          bridge.binding.roomId !== scope.roomId ||
          bridge.binding.conversationId !== scope.conversationId)
      ) {
        const reason = '请回原世界、原账户和原副对话处理这份起草。';
        setUi({ scope, runId: null, busy: false, canStop: false, error: reason });
        return { status: 'rejected', reason };
      }
      if (
        !db ||
        !scope ||
        !world ||
        !conversation ||
        conversation.kind !== 'side' ||
        !bridge ||
        activeRef.current?.busy
      )
        return { status: 'rejected', reason: '当前无法应用这份回复。' };
      const op = begin();
      if (!op) return { status: 'rejected', reason: '来源不可用' };
      phase(op, 'saving-output');
      let savedId: MessageId | null = null;
      let attempted = false;
      const receiptId = messageId(newId());
      bridgeAttempt.current = { scope: op.scope, id: receiptId, uncertain: false };
      try {
        const { commitAdminSource } = await import('./admin-source');
        const result = await commitAdminSource({
          repository: db.repository,
          bridge: bridge as ScopedAdminBridge,
          current: { accountKey, roomId: world.id, conversationId: conversation.id },
          raw,
          messageId: receiptId,
          onCommitStart: () => {
            attempted = true;
          },
          isCurrent: () => visible(op),
          artifactFor: draftToArtifact,
        });
        savedId = result.message.id;
        adminProcessStore.bindMessage(op.scope, op.runId, savedId);
        bridgeAttempt.current = null;
        for (const entry of result.sceneTargets)
          adminProcessStore.bindSceneTarget(op.scope, op.runId, entry.artifactId, entry.target);
        if (visible(op)) {
          setBridge(null);
          await session.reloadWorld();
          if (visible(op)) onChanged();
        }
        phase(op, result.notes.length ? 'partial' : 'saved');
        return { status: 'confirmed', messageId: savedId };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!savedId && attempted) {
          try {
            const found = await db.repository.readAdminMessage(receiptId);
            if (found?.roomId === world.id && found.conversationId === conversation.id) {
              savedId = found.id;
              adminProcessStore.bindMessage(op.scope, op.runId, savedId);
              bridgeAttempt.current = null;
              if (visible(op)) setBridge(null);
            }
          } catch {
            /* Receipt inspection never repeats the transaction. */
          }
        }
        if (savedId) {
          phase(op, 'saved-read-failed', { kind: 'read', text: `起草已保存，但读取失败，请刷新核对。${message}` });
          return { status: 'saved-read-failed', messageId: savedId, reason: message };
        }
        const rejected = !attempted || /来源|变化|旧起草|原世界|未应用|有效来源/.test(message);
        if (rejected) bridgeAttempt.current = null;
        else if (bridgeAttempt.current) bridgeAttempt.current.uncertain = true;
        phase(op, rejected ? 'failed' : 'uncertain', { kind: rejected ? 'error' : 'uncertain', text: message });
        return { status: rejected ? 'rejected' : 'uncertain', reason: message };
      } finally {
        finish(op);
      }
    },
    [db, scope, session, accountKey, bridge, onChanged, begin, finish, phase, visible],
  );
  const inspectBridge = useCallback(async (): Promise<BridgeCommitOutcome> => {
    const attempt = bridgeAttempt.current;
    if (!db || !scope || !attempt || !sameAdminScope(attempt.scope, scope) || activeRef.current?.busy)
      return { status: 'rejected', reason: '请回原来源核对保存结果。' };
    const op = begin();
    if (!op) return { status: 'rejected', reason: '来源不可用' };
    phase(op, 'saving-output');
    let saved = false;
    try {
      const found = await db.repository.readAdminMessage(attempt.id);
      if (!found || found.roomId !== scope.roomId || found.conversationId !== scope.conversationId) {
        phase(op, 'uncertain', { kind: 'uncertain', text: '尚未读到提交回执，不能据此重新应用。' });
        return { status: 'uncertain', reason: '尚未读到提交回执，请保留内容并稍后只读核对。' };
      }
      saved = true;
      bridgeAttempt.current = null;
      adminProcessStore.bindMessage(op.scope, op.runId, found.id);
      if (visible(op)) {
        setBridge(null);
        await session.reloadWorld();
        if (visible(op)) onChanged();
      }
      phase(op, 'saved');
      return { status: 'confirmed', messageId: found.id };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      phase(op, saved ? 'saved-read-failed' : 'uncertain', { kind: saved ? 'read' : 'uncertain', text: reason });
      return saved ? { status: 'saved-read-failed', messageId: attempt.id, reason } : { status: 'uncertain', reason };
    } finally {
      finish(op);
    }
  }, [db, scope, session, onChanged, begin, finish, phase, visible]);
  const stop = useCallback(() => {
    const op = activeRef.current;
    if (!op?.canStop) return;
    phase(op, 'stopping');
    op.controller?.abort();
  }, [phase]);
  const cancelBridge = useCallback(() => {
    if (!activeRef.current?.busy && !bridgeAttempt.current?.uncertain) setBridge(null);
  }, []);
  const owned = sameAdminScope(ui.scope, scope);
  const shownBridge =
    bridge &&
    (!bridge.binding ||
      (bridge.binding.accountKey === accountKey &&
        bridge.binding.roomId === session.world?.id &&
        bridge.binding.conversationId === session.conversation?.id))
      ? bridge
      : null;
  return useMemo(
    () => ({
      busy: owned && ui.busy,
      error: owned ? ui.error : null,
      send,
      stop,
      bridge: shownBridge,
      commitBridge,
      inspectBridge,
      cancelBridge,
      processScope: scope,
      activeRunId: owned ? ui.runId : null,
      canStop: owned && ui.canStop,
      needsInspection: scope !== null && pendingApi.current.some((p) => sameAdminScope(p.scope, scope)),
      inspectRun,
    }),
    [owned, ui, send, stop, shownBridge, commitBridge, inspectBridge, cancelBridge, scope, inspectRun],
  );
}
