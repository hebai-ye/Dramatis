import {
  type AdminArtifact,
  type AdminDraft,
  type ConversationId,
  createOpenAICompatibleProvider,
  createPlayerMessage,
  createTurnId,
  describeToolExecution,
  type Message,
  type MessageUsage,
  messageId,
  needsWebBridge,
  newId,
  nowIso,
  type RoomId,
} from '@dramatis/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScopedAdminBridge } from './admin-source';
import { loadBridge, saveBridge } from './bridge-store';
import type { SubmitOutcome } from './chat-draft';
import type { DramatisDb } from './db';
import type { ProvidersApi } from './providers';
import type { SessionApi } from './session';
import { handoffStreamState, resetStreamState, setStreamState } from './stream-store';

export interface AdminChatApi {
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
  commitBridge: (raw: string) => Promise<void>;
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
  /** 后台/副对话共用的便宜模型配置；缺省时用主配置。 */
  onChanged: () => void;
}): AdminChatApi {
  const { db, session, providers, onChanged, accountKey } = options;
  const currentRef = useRef(options);
  currentRef.current = options;
  const operationRef = useRef(0);
  const inFlightRef = useRef(false);
  const sameView = useCallback(
    (room: string, conversation: string) =>
      currentRef.current.db === db &&
      currentRef.current.accountKey === accountKey &&
      currentRef.current.session.world?.id === room &&
      currentRef.current.session.conversation?.id === conversation,
    [db, accountKey],
  );

  const [busy, setBusy] = useState(false);
  // 流式正文不住在这里（顺序 59）：它写进 `lib/stream-store.ts` 的 `admin` 通道，
  // 由 `SideChat` 自己订阅。住在这里等于每个 token 都把整个 App 重画一遍。
  const [error, setError] = useState<string | null>(null);
  const [bridge, setBridge] = useState<AdminBridge | null>(() => loadBridge<AdminBridge>('admin'));

  // 副对话的桥接进度同样落进 sessionStorage（顺序 25）
  useEffect(() => {
    saveBridge('admin', bridge);
  }, [bridge]);
  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // biome-ignore lint/correctness/useExhaustiveDependencies: changing source must abort the previous API request before a new tool execution.
  useEffect(() => () => abortRef.current?.abort(), [db, accountKey, session.world?.id, session.conversation?.id]);

  /**
   * 把解析出来的工具调用真正执行掉。
   *
   * 与 API 那条路**共用同一个 execute 函数**（`executeDraft`），所以「场景即时生效、
   * 角色卡与世界书只落草稿」这些语义只写了一份。
   */
  const executeDraft = useCallback(
    async (draft: AdminDraft, artifacts: AdminArtifact[], scope: AdminRequestScope): Promise<string> => {
      if (sessionRef.current.world?.id !== scope.roomId) return '原世界已切换，本次工具未执行。';
      if (draft.kind === 'scene') {
        if (!scope.targetConversationId) return '场景未设置：请先选择一条主对话作为目标。';
        const applied = await session.setWorldScene(draft.patch, scope.targetConversationId, scope.roomId);
        if (applied === null)
          return `场景未设置：目标「${scope.targetName ?? scope.targetConversationId}」已失效或世界已切换，请重新选择。`;
        const summary = `目标「${scope.targetName ?? scope.targetConversationId}」：${draft.summary}`;
        artifacts.push({ ...draftToArtifact(draft), summary, targetId: applied.id });
        return `已即时设置${summary}`;
      }

      artifacts.push(draftToArtifact(draft));
      return `${draft.summary}：草稿已放到用户面前，等待他采纳或丢弃，不要重复起草。`;
    },
    [session],
  );

  const send = useCallback(
    async (
      text: string,
      targetOrAcceptance?: ConversationId | ((outcome: SubmitOutcome) => void),
      onAcceptance?: (outcome: SubmitOutcome) => void,
    ): Promise<SubmitOutcome> => {
      const targetConversationId = typeof targetOrAcceptance === 'string' ? targetOrAcceptance : undefined;
      const accepted = typeof targetOrAcceptance === 'function' ? targetOrAcceptance : onAcceptance;
      let outcome: SubmitOutcome = { status: 'rejected', reason: '当前副对话还未准备好；输入已保留。' };
      const accept = () => {
        outcome = { status: 'accepted' };
        accepted?.(outcome);
      };
      const world = session.world;
      const conversation = session.conversation;
      if (
        !db ||
        !world ||
        !conversation ||
        conversation.kind !== 'side' ||
        conversation.archivedAt !== null ||
        conversation.deletedAt !== null ||
        busy ||
        bridge !== null ||
        inFlightRef.current
      )
        return outcome;

      const profile = providers.active;
      if (!profile) {
        setError('还没有模型配置');
        return outcome;
      }
      /*
       * 没有 API Key 就走**网页版桥接**：把管理员的提示词（含五个工具的声明与
       * 「这次没有工具接口，请写成 JSON 块」的特殊说明）交给用户贴进 DeepSeek 网页版，
       * 再把回复贴回来。原来这里是一句「还没有填 API Key」——左栏最诱人的「创建」
       * 按钮点下去直接失败，是当时唯一还会卡住的入口。
       */
      const manual = needsWebBridge(providers.apiKey);

      const operation = ++operationRef.current;
      inFlightRef.current = true;
      setError(null);
      setBusy(true);
      resetStreamState('admin');
      setBridge(null);

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
        if (targetScene && (targetScene.roomId !== world.id || targetScene.conversationId !== target?.id))
          targetScene = null;
      } catch (error) {
        if (sameView(world.id, conversation.id)) setError(error instanceof Error ? error.message : String(error));
        setBusy(false);
        inFlightRef.current = false;
        return outcome;
      }
      if (!sameView(world.id, conversation.id) || operationRef.current !== operation) {
        setBusy(false);
        inFlightRef.current = false;
        return outcome;
      }
      const scope: AdminRequestScope = {
        roomId: world.id,
        conversationId: conversation.id,
        targetConversationId: target?.id ?? null,
        targetName: target?.title ?? null,
      };
      const history = session.messages;
      const playerMessage = createPlayerMessage({
        roomId: world.id,
        conversationId: conversation.id,
        sceneId: null,
        turnId: createTurnId(),
        speakerName: world.playerName,
        content: text,
        audience: [],
      });
      const pendingDrafts = history
        .flatMap((message) => message.artifacts ?? [])
        .filter((artifact) => artifact.status === 'pending')
        .map((artifact) => artifact.summary);
      try {
        await session.appendMessages([playerMessage], accept);
        if (!sameView(world.id, conversation.id)) throw new Error('起草来源已经变化，请回到原副对话后继续。');
        if (manual) {
          const { prepareAdminSource } = await import('./admin-source');
          const source = await prepareAdminSource(
            db.repository,
            { accountKey, roomId: world.id, conversationId: conversation.id },
            text,
            playerMessage.id,
            scope.targetConversationId,
          );
          if (!sameView(world.id, conversation.id) || operationRef.current !== operation)
            throw new Error('起草来源已经变化，未发布旧提示词。');
          const prepared: AdminBridge = { ...source, ...scope };
          saveBridge('admin', prepared, true);
          setBridge(prepared);
          setBusy(false);
          inFlightRef.current = false;
          return outcome;
        }
      } catch (error) {
        if (outcome.status !== 'accepted')
          outcome = { status: 'uncertain', reason: '保存结果未确认，输入已保留；请先核对消息记录。' };
        if (sameView(world.id, conversation.id)) setError(error instanceof Error ? error.message : String(error));
        setBusy(false);
        inFlightRef.current = false;
        return outcome;
      }

      const provider = createOpenAICompatibleProvider({
        baseUrl: profile.baseUrl,
        apiKey: providers.apiKey,
        model: profile.model,
        // 副对话的调用也要进账单：它用的是同一个 Key，花的是同一笔钱
        includeUsage: true,
      });

      const controller = new AbortController();
      abortRef.current = controller;
      // 上一轮的交接如果没被收走（例如界面切走了），先清掉，别把残留带进这一轮
      resetStreamState('admin');
      const artifacts: AdminArtifact[] = [];
      /** 这一轮的管理员消息是否已经落库（审计 C13：失败时要补记，但不能记两遍）。 */
      let persisted = false;
      /** 落盘后是否把流式副本交给了消息列表（顺序 104）：没交接时 finally 才清残留。 */
      let handedOff = false;
      const buildMessage = (content: string, usage: MessageUsage | null): Message => ({
        id: messageId(newId()),
        roomId: world.id,
        conversationId: conversation.id,
        sceneId: null,
        turnId: createTurnId(),
        localSeq: 0,
        deviceId: '',
        role: 'admin',
        speakerInstanceId: null,
        speakerName: '世界管理员',
        audience: [],
        content,
        // 用量挂在消息上：副对话刷新之后仍能看到这一轮花了多少
        ...(usage === null ? {} : { usage }),
        ...(artifacts.length > 0 ? { artifacts: [...artifacts] } : {}),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        deletedAt: null,
      });

      try {
        const { buildAdminMessages, runAdminTurn } = await import('./admin-engine');
        let answer = '';
        let usage: MessageUsage | null = null;
        for await (const event of runAdminTurn(
          provider,
          buildAdminMessages({
            room: world,
            conversation,
            scene: targetScene,
            ...(scope.targetConversationId
              ? { targetConversationId: scope.targetConversationId, targetName: scope.targetName ?? undefined }
              : {}),
            instances: session.instances,
            cards: session.library.cards,
            worldBooks: session.library.worldBooks,
            personas: session.personas,
            history,
            userInput: text,
            pendingDrafts,
          }),
          {
            params: { temperature: profile.temperature },
            signal: controller.signal,
            context: {
              knownCardIds: session.library.cards.map((card) => card.id),
              knownBookIds: session.library.worldBooks.map((book) => book.id),
              // 改已有素材要「以现有内容为底」做字段级合并（顺序 86，审计 B6）
              cards: session.library.cards,
              worldBooks: session.library.worldBooks,
              knownPersonas: session.personas,
            },
            execute: (draft) => {
              if (controller.signal.aborted || !sameView(world.id, conversation.id))
                throw new Error('起草来源已经变化，已停止执行工具。');
              return executeDraft(draft, artifacts, scope);
            },
            /*
             * 顺序 104：正文逐块交给副对话，不再等整轮收完（用户原话：副对话看不到它在写）。
             * 累计放在这里：core 给的是增量，`answer` 要跨轮拼起来才是这一回合的全文。
             * 顺带把工具那行清掉——模型重新开口说话，就不该再显示上一件工具。
             */
            onDelta: (delta) => {
              answer += delta;
              if (sameView(world.id, conversation.id) && operationRef.current === operation)
                setStreamState('admin', { text: answer, phase: 'writing', progress: '' });
            },
          },
        )) {
          switch (event.type) {
            /*
             * 顺序 104：正文已经由上面的 onDelta 逐块累加，这里不能再叠加一遍
             * （原来的 `answer += event.text` 会把这整轮文字重复计一次）。
             */
            case 'text':
              break;
            case 'tool':
              /*
               * 顺序 104：让用户看清管理员刚才动了哪件素材。
               *
               * 要注意这个事件是「模型已经点名、本地已经执行完」之后才来的，不是「正在想」——
               * 所以界面上的措辞是「工具调用：…」而不是「正在调用…」。
               */
              if (sameView(world.id, conversation.id) && operationRef.current === operation)
                setStreamState('admin', { progress: describeToolExecution(event.execution) });
              break;
            case 'done':
              answer = event.text === '' ? answer : event.text;
              usage =
                event.usage === null
                  ? null
                  : {
                      promptTokens: event.usage.promptTokens ?? 0,
                      completionTokens: event.usage.completionTokens ?? 0,
                    };
              break;
            default:
              break;
          }
        }

        const content = answer.trim() === '' ? '（草稿已经放在下面，采纳后就能用。）' : answer.trim();
        const message = buildMessage(content, usage);
        await session.appendMessages([message]);
        persisted = true;
        /*
         * 顺序 104：与主对话同一条规则（顺序 91）——落盘这一刻只记下消息 id，不清正文。
         * 清空是同步的，而消息要等 IndexedDB 写完再提交一次才出现，中间那几帧就是
         * 「文字先消失、过一会儿整条出现」；交接给 SideChat，等它看见这条消息再收。
         */
        if (sameView(world.id, conversation.id) && operationRef.current === operation) {
          handoffStreamState('admin', message.id);
          handedOff = true;
        }

        // 记账。世界管理员不属于任何角色，所以不填 speaker（T7）
        await db.ledger.record({
          roomId: world.id,
          conversationId: conversation.id,
          turnId: message.turnId,
          category: 'admin',
          model: profile.model,
          promptTokens: usage?.promptTokens ?? 0,
          completionTokens: usage?.completionTokens ?? 0,
          price: profile.price ?? null,
        });
        onChanged();
      } catch (sendError) {
        const message = sendError instanceof Error ? sendError.message : String(sendError);
        if (sameView(world.id, conversation.id))
          setError(controller.signal.aborted ? `已停止生成（${message}）` : message);
        /*
         * 中途出错或被停止时，已经执行过的工具（尤其是立即生效的 set_scene）也要留痕
         * （审计 C13）：以前这里直接丢掉 artifacts，场景已经被改了，界面上却既没有记录
         * 也没有撤销入口。补一条管理员消息把它们挂上，草稿照样可以采纳或丢弃。
         */
        if (!persisted && artifacts.length > 0) {
          const note = controller.signal.aborted
            ? '（这一轮被停止了，但下面这些改动 / 草稿在停止前已经产生。）'
            : `（这一轮中途出错：${message}。下面这些改动 / 草稿在出错前已经产生。）`;
          await session.appendMessages([buildMessage(note, null)]).catch(() => undefined);
          onChanged();
        }
      } finally {
        // 已经交接给 SideChat 的流式副本由它收（它看见消息落进列表后会 acknowledge）；
        // 没交接的（出错、被停止）必须在这里清掉，不能留半截文字在界面上。
        if (!handedOff) resetStreamState('admin');
        setBusy(false);
        abortRef.current = null;
        inFlightRef.current = false;
      }
      return outcome;
    },
    [busy, bridge, db, executeDraft, onChanged, providers, session, accountKey, sameView],
  );

  /**
   * 收下网页版贴回来的东西：解析出工具调用 → 走同一套校验 → 执行 → 落成一条管理员消息。
   *
   * 与 API 那条路的差别只有「谁把文本写出来」：解析、校验、执行、落库全都在这里复用。
   */
  const commitBridge = useCallback(
    async (raw: string) => {
      const world = session.world;
      const conversation = session.conversation;
      if (
        !db ||
        !world ||
        !conversation ||
        conversation.kind !== 'side' ||
        bridge === null ||
        busy ||
        inFlightRef.current
      )
        return;
      const operation = ++operationRef.current;
      const isCurrent = () => operationRef.current === operation && sameView(world.id, conversation.id);
      inFlightRef.current = true;
      setBusy(true);
      setError(null);
      let committed = false;
      try {
        const { commitAdminSource } = await import('./admin-source');
        await commitAdminSource({
          repository: db.repository,
          bridge: bridge as ScopedAdminBridge,
          current: { accountKey, roomId: world.id, conversationId: conversation.id },
          raw,
          isCurrent,
          artifactFor: draftToArtifact,
        });
        committed = true;
        if (isCurrent()) {
          setBridge(null);
          await session.reloadWorld();
          if (isCurrent()) onChanged();
        }
      } catch (error) {
        if (isCurrent())
          setError(
            `${committed ? '起草已保存，但读取失败，请刷新核对。' : ''}${error instanceof Error ? error.message : String(error)}`,
          );
      } finally {
        if (operationRef.current === operation) {
          resetStreamState('admin');
          setBusy(false);
          inFlightRef.current = false;
        }
      }
    },
    [bridge, busy, db, session, accountKey, onChanged, sameView],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const cancelBridge = useCallback(() => {
    if (!inFlightRef.current) setBridge(null);
  }, []);

  // 返回对象要稳定（顺序 59）：App 拿它当依赖，每次渲染新造一个会让下游的 memo 全部失效
  return useMemo(
    () => ({ busy, error, send, stop, bridge, commitBridge, cancelBridge }),
    [busy, error, send, stop, bridge, commitBridge, cancelBridge],
  );
}
