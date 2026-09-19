import {
  type AdminArtifact,
  type AdminDraft,
  buildAdminMessages,
  createOpenAICompatibleProvider,
  createPlayerMessage,
  createTurnId,
  type Message,
  type MessageUsage,
  messageId,
  newId,
  nowIso,
  runAdminTurn,
} from '@dramatis/core';
import { useCallback, useRef, useState } from 'react';
import type { DramatisDb } from './db';
import type { ProvidersApi } from './providers';
import type { SessionApi } from './session';

export interface AdminChatApi {
  busy: boolean;
  streamText: string;
  error: string | null;
  send: (text: string) => Promise<void>;
  stop: () => void;
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
      };
    case 'world-book':
      return {
        ...base,
        kind: 'world-book',
        title: draft.book.name,
        summary: draft.summary,
        status: 'pending',
        payload: draft.book,
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
  const [streamText, setStreamText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
      if (providers.apiKey.trim() === '') {
        setError('还没有填 API Key');
        return;
      }

      setError(null);
      setBusy(true);
      setStreamText('');

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
            },
            execute: async (draft) => {
              if (draft.kind === 'scene') {
                const applied = await session.setWorldScene(draft.patch);
                artifacts.push(draftToArtifact(draft));
                return applied === null
                  ? '这个世界还没有主对话，场景没能设置；请先让用户开一条主对话。'
                  : `已把当前场景设为：${draft.summary}（生效于主对话）`;
              }

              artifacts.push(draftToArtifact(draft));
              return `${draft.summary}：草稿已放到用户面前，等待他采纳或丢弃，不要重复起草。`;
            },
          },
        )) {
          switch (event.type) {
            case 'text':
              answer += event.text;
              setStreamText(answer);
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
        const message: Message = {
          id: messageId(newId()),
          roomId: world.id,
          conversationId: conversation.id,
          sceneId: null,
          turnId: createTurnId(),
          seq: 0,
          role: 'admin',
          speakerInstanceId: null,
          speakerName: '世界管理员',
          audience: [],
          content,
          // 用量挂在消息上：副对话刷新之后仍能看到这一轮花了多少
          ...(usage === null ? {} : { usage }),
          ...(artifacts.length > 0 ? { artifacts } : {}),
          createdAt: nowIso(),
          updatedAt: nowIso(),
          deletedAt: null,
        };
        await session.appendMessages([message]);

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
      } finally {
        setStreamText('');
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, db, onChanged, providers, session],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return { busy, streamText, error, send, stop };
}
