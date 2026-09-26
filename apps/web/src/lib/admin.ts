import {
  type AdminArtifact,
  type AdminDraft,
  buildAdminBridgeMessages,
  buildAdminMessages,
  createOpenAICompatibleProvider,
  createPlayerMessage,
  createTurnId,
  type Message,
  type MessageUsage,
  messageId,
  needsWebBridge,
  newId,
  nowIso,
  parseAdminBridgeOutput,
  parseAdminToolCall,
  renderPromptForWeb,
  runAdminTurn,
} from '@dramatis/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadBridge, saveBridge } from './bridge-store';
import type { DramatisDb } from './db';
import type { ProvidersApi } from './providers';
import type { SessionApi } from './session';
import { resetStreamState, setStreamState } from './stream-store';

export interface AdminChatApi {
  busy: boolean;
  error: string | null;
  send: (text: string) => Promise<void>;
  stop: () => void;
  /**
   * 没有 API Key 时的网页版桥接（副对话）。
   *
   * 非 null 表示「正等着用户把网页版的输出贴回来」。管理员要调用工具，所以贴回来的
   * 东西里除了正文还有 `{"tool":…,"arguments":{…}}` 代码块——解析之后走的是与 API
   * 那条路**同一套校验与执行**（`parseAdminToolCall` → `execute`）。
   */
  bridge: { prompt: string } | null;
  commitBridge: (raw: string) => Promise<void>;
  cancelBridge: () => void;
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
  /** 后台/副对话共用的便宜模型配置；缺省时用主配置。 */
  onChanged: () => void;
}): AdminChatApi {
  const { db, session, providers, onChanged } = options;
  const [busy, setBusy] = useState(false);
  // 流式正文不住在这里（顺序 59）：它写进 `lib/stream-store.ts` 的 `admin` 通道，
  // 由 `SideChat` 自己订阅。住在这里等于每个 token 都把整个 App 重画一遍。
  const [error, setError] = useState<string | null>(null);
  const [bridge, setBridge] = useState<{ prompt: string } | null>(() => loadBridge<{ prompt: string }>('admin'));

  // 副对话的桥接进度同样落进 sessionStorage（顺序 25）
  useEffect(() => {
    saveBridge('admin', bridge);
  }, [bridge]);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * 把解析出来的工具调用真正执行掉。
   *
   * 与 API 那条路**共用同一个 execute 函数**（`executeDraft`），所以「场景即时生效、
   * 角色卡与世界书只落草稿」这些语义只写了一份。
   */
  const executeDraft = useCallback(
    async (draft: AdminDraft, artifacts: AdminArtifact[]): Promise<string> => {
      if (draft.kind === 'scene') {
        const applied = await session.setWorldScene(draft.patch);
        /*
         * 场景没落下去时**别把卡片标成「已生效」**（这是原来就有的小毛病：先 push 再判断）。
         * 这个世界还没有主对话时 setWorldScene 会返回 null，那时标成「待你决定」更诚实。
         */
        const artifact = draftToArtifact(draft);
        artifacts.push(applied === null ? { ...artifact, status: 'pending' } : artifact);
        return applied === null
          ? '这个世界还没有主对话，场景没能设置；请先让用户开一条主对话。'
          : `已把当前场景设为：${draft.summary}（生效于主对话）`;
      }

      artifacts.push(draftToArtifact(draft));
      return `${draft.summary}：草稿已放到用户面前，等待他采纳或丢弃，不要重复起草。`;
    },
    [session],
  );

  const send = useCallback(
    async (text: string) => {
      const world = session.world;
      const conversation = session.conversation;
      if (!db || !world || !conversation || conversation.kind !== 'side' || busy) return;

      const profile = providers.active;
      if (!profile) {
        setError('还没有模型配置');
        return;
      }
      /*
       * 没有 API Key 就走**网页版桥接**：把管理员的提示词（含五个工具的声明与
       * 「这次没有工具接口，请写成 JSON 块」的特殊说明）交给用户贴进 DeepSeek 网页版，
       * 再把回复贴回来。原来这里是一句「还没有填 API Key」——左栏最诱人的「创建」
       * 按钮点下去直接失败，是当时唯一还会卡住的入口。
       */
      const manual = needsWebBridge(providers.apiKey);

      setError(null);
      setBusy(true);
      resetStreamState('admin');
      setBridge(null);

      const history = session.messages;
      await session.appendMessages([
        createPlayerMessage({
          roomId: world.id,
          conversationId: conversation.id,
          sceneId: null,
          turnId: createTurnId(),
          speakerName: world.playerName,
          content: text,
          audience: [],
        }),
      ]);

      const pendingDrafts = history
        .flatMap((message) => message.artifacts ?? [])
        .filter((artifact) => artifact.status === 'pending')
        .map((artifact) => artifact.summary);

      if (manual) {
        setBridge({
          prompt: renderPromptForWeb(
            buildAdminBridgeMessages({
              room: world,
              conversation,
              scene: null,
              instances: session.instances,
              cards: session.library.cards,
              worldBooks: session.library.worldBooks,
              personas: session.personas,
              history,
              userInput: text,
              pendingDrafts,
            }),
          ),
        });
        setBusy(false);
        return;
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
      const artifacts: AdminArtifact[] = [];
      /** 这一轮的管理员消息是否已经落库（审计 C13：失败时要补记，但不能记两遍）。 */
      let persisted = false;
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
        let answer = '';
        let usage: MessageUsage | null = null;
        for await (const event of runAdminTurn(
          provider,
          buildAdminMessages({
            room: world,
            conversation,
            scene: null,
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
            execute: (draft) => executeDraft(draft, artifacts),
          },
        )) {
          switch (event.type) {
            case 'text':
              answer += event.text;
              setStreamState('admin', { text: answer, phase: 'writing' });
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
        // 落盘后立刻收掉流式副本：与主对话同一条规则，避免同一条回复显示两遍
        resetStreamState('admin');

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
        resetStreamState('admin');
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, db, executeDraft, onChanged, providers, session],
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
      if (!db || !world || !conversation || conversation.kind !== 'side' || bridge === null || busy) return;

      setBusy(true);
      setError(null);
      try {
        const parsed = parseAdminBridgeOutput(raw);
        const context = {
          knownCardIds: session.library.cards.map((card) => card.id),
          knownBookIds: session.library.worldBooks.map((book) => book.id),
          // 改已有素材要「以现有内容为底」做字段级合并（顺序 86，审计 B6）
          cards: session.library.cards,
          worldBooks: session.library.worldBooks,
          knownPersonas: session.personas,
        };

        const artifacts: AdminArtifact[] = [];
        const failed: string[] = [];
        const unknown: string[] = [];
        for (const call of parsed.calls) {
          const result = parseAdminToolCall(call, context);
          if (!result.ok) {
            failed.push(result.error);
            continue;
          }
          if (result.unknownArgs !== undefined) unknown.push(...result.unknownArgs);
          await executeDraft(result.draft, artifacts);
        }

        const notes: string[] = [];
        if (parsed.invalid.length > 0) {
          notes.push(`它提到了一件这里没有的事（${parsed.invalid.join('、')}），那部分没有执行。`);
        }
        // 多写的参数要说一声（顺序 67）：界面上没有工具结果的回填通道，只能在这儿落下
        if (unknown.length > 0) {
          notes.push(`它多写了几个用不上的参数（${[...new Set(unknown)].join('、')}），那部分没有生效。`);
        }
        if (failed.length > 0) {
          notes.push(`有一件没能落下：${failed.join('；')}。可以把要求说得更具体一点，再贴一次。`);
        }

        const fallback =
          artifacts.length > 0 ? '（草稿已经放在下面，采纳后就能用。）' : '（它这次没有起草任何素材，只说了几句话。）';
        const content =
          [parsed.answer.trim(), ...notes].filter((part) => part !== '').join('\n\n') ||
          (artifacts.length > 0 ? fallback : parsed.answer.trim() || fallback);

        await session.appendMessages([
          {
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
            // 网页版这一轮不经过服务商：没有 usage，也没有账单
            ...(artifacts.length > 0 ? { artifacts } : {}),
            createdAt: nowIso(),
            updatedAt: nowIso(),
            deletedAt: null,
          },
        ]);

        setBridge(null);
        onChanged();
      } catch (commitError) {
        setError(commitError instanceof Error ? commitError.message : String(commitError));
      } finally {
        setBusy(false);
      }
    },
    [bridge, busy, db, executeDraft, onChanged, session],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const cancelBridge = useCallback(() => setBridge(null), []);

  // 返回对象要稳定（顺序 59）：App 拿它当依赖，每次渲染新造一个会让下游的 memo 全部失效
  return useMemo(
    () => ({ busy, error, send, stop, bridge, commitBridge, cancelBridge }),
    [busy, error, send, stop, bridge, commitBridge, cancelBridge],
  );
}
