import {
  type AdminArtifact,
  type Conversation,
  type ConversationId,
  isCompleteWorldBook,
  isModifiedWorldBookArtifact,
  type Message,
  type MessageId,
  type WorldBook,
  worldBookArtifactConflict,
} from '@dramatis/core';
import { memo, useEffect, useRef, useState } from 'react';
import { countRender } from '../lib/render-count';
import { acknowledgeStreamHandoff, resetStreamState, useStreamState } from '../lib/stream-store';
import { useCoarsePointer } from '../lib/viewport';
import { Composer } from './Composer';
import { WebBridgePanel } from './WebBridgePanel';
import { WorldBookDiff } from './WorldBookDiff';

interface Props {
  conversation: Conversation;
  messages: Message[];
  busy: boolean;
  ready: boolean;
  archived: boolean;
  onSend: (text: string, targetConversationId?: ConversationId) => void;
  onStop: () => void;
  onAdopt: (messageId: MessageId, artifact: AdminArtifact) => void | Promise<void>;
  onDiscard: (messageId: MessageId, artifact: AdminArtifact) => void | Promise<void>;
  onRevoke?: (messageId: MessageId, artifact: AdminArtifact) => void | Promise<void>;
  onReverse?: (messageId: MessageId, artifact: AdminArtifact) => void | Promise<void>;
  worldBooks?: readonly WorldBook[];
  conversations?: readonly Conversation[];
  /** 兼容现有调用；世界书冲突由完整 worldBooks 判断。 */
  existingIds?: readonly string[];
  /** 没有 API Key 时，起草这一步走网页版桥接。 */
  bridge?: { prompt: string } | null;
  /** 没配 API Key：发送按钮改成「生成提示词」，别让人以为点了会直接有回复。 */
  manualMode?: boolean;
  onBridgeCommit?: (text: string) => void;
  onBridgeCancel?: () => void;
  /**
   * 副对话自己的错误（顺序 67）。
   *
   * 以前 `useAdminChat` 里的 `error` 只写进状态、没人接：副对话失败时**界面上什么都不显示**，
   * 用户看到的是「点了没反应」。主对话的错误早就显示在左栏提示条里，副对话这条补上。
   */
  error?: string | null;
}

const STATUS_LABEL: Record<AdminArtifact['status'], string> = {
  pending: '待你决定',
  adopted: '已采纳',
  discarded: '已丢弃',
  applied: '已生效',
};

const ARTIFACT_LABEL: Record<AdminArtifact['kind'], string> = {
  'character-card': '角色卡',
  'world-book': '世界书',
  'persona-upsert': '玩家身份',
  'persona-delete': '删除身份',
  scene: '场景',
};

function ArtifactCard({
  artifact,
  disabled,
  currentBook,
  onAdopt,
  onDiscard,
  onRevoke,
  onReverse,
}: {
  artifact: AdminArtifact;
  disabled: boolean;
  /** 当前素材库中的原书，用于显示实时版本冲突。 */
  currentBook: WorldBook | null;
  onAdopt: () => void | Promise<void>;
  onDiscard: () => void | Promise<void>;
  onRevoke?: () => void | Promise<void>;
  onReverse?: () => void | Promise<void>;
}) {
  const [operation, setOperation] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const operationRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const locked = disabled || operation !== null;
  const perform = async (label: string, action: () => void | Promise<void>): Promise<void> => {
    if (disabled || operationRef.current) return;
    operationRef.current = true;
    setOperation(label);
    setOperationError(null);
    try {
      await action();
      // A resolved request can also mean a rejected version conflict. The saved artifact status owns success.
    } catch (error) {
      if (mountedRef.current) {
        const detail = error instanceof Error ? error.message : String(error);
        setOperationError(`操作未完成：${detail || '请稍后再试'}。请核对当前素材状态后再操作。`);
      }
    } finally {
      operationRef.current = false;
      if (mountedRef.current) setOperation(null);
    }
  };
  /*
   * 草稿预览（顺序 26）：卡片在采纳之前要能看出「它到底长什么样」。
   * 世界书给前几条词条，让人看得到粒度。
   *
   * 顺序 90：角色卡的开场白已被删掉（用户裁定「彻底删除已有数据」），
   * 于是这里改看「设定」（`description`）——那是卡上还剩的、最能判断
   * 「这个角色合不合世界」的一段。
   */
  const payload = artifact.payload as {
    description?: unknown;
    entries?: unknown;
  } | null;
  const description = typeof payload?.description === 'string' ? payload.description.trim() : '';
  const entryCount = Array.isArray(payload?.entries) ? payload.entries.length : 0;

  const conflict =
    artifact.conflict ?? (artifact.status === 'pending' ? worldBookArtifactConflict(artifact, currentBook) : null);
  const modifiedBook = isModifiedWorldBookArtifact(artifact);
  return (
    <div className={`artifact ${artifact.status}`} aria-busy={operation !== null}>
      <div className="artifact-head">
        <span className="tag accent">{ARTIFACT_LABEL[artifact.kind]}</span>
        <strong>{artifact.title}</strong>
        <span className="hint">{STATUS_LABEL[artifact.status]}</span>
      </div>
      <p className="hint">{artifact.summary}</p>

      {description === '' ? null : (
        <p className="hint artifact-preview">
          设定：{description.length > 56 ? `${description.slice(0, 56)}…` : description}
        </p>
      )}
      {entryCount === 0 ? null : <p className="hint">共 {String(entryCount)} 条词条</p>}

      {artifact.kind === 'world-book' &&
      isCompleteWorldBook(artifact.payload) &&
      (!modifiedBook || isCompleteWorldBook(artifact.previousPayload)) ? (
        <WorldBookDiff
          before={isCompleteWorldBook(artifact.previousPayload) ? artifact.previousPayload : null}
          after={artifact.payload}
        />
      ) : null}
      {conflict == null ? null : <p className="hint warn">⚠️ {conflict}</p>}
      {operation === null ? null : (
        <p className="hint" role="status">
          {operation}
        </p>
      )}
      {operationError === null ? null : (
        <p className="notice error" role="alert">
          {operationError}
        </p>
      )}

      {artifact.status === 'pending' ? (
        <div className="inline">
          <button
            type="button"
            className={artifact.kind === 'persona-delete' ? 'ghost danger' : undefined}
            disabled={locked || conflict != null}
            onClick={() => void perform('正在采纳…', onAdopt)}
          >
            {artifact.kind === 'persona-delete' ? '确认删除' : '采纳'}
          </button>
          <button
            type="button"
            className="ghost danger"
            disabled={locked}
            onClick={() => void perform('正在丢弃…', onDiscard)}
          >
            丢弃
          </button>
        </div>
      ) : null}

      {artifact.status === 'adopted' && modifiedBook ? (
        <div className="inline">
          <span className="hint">修改类采纳需核对后反向修改</span>
          <button
            type="button"
            className="ghost"
            disabled={locked || !onReverse}
            onClick={() => {
              if (onReverse) void perform('正在起草反向修改…', onReverse);
            }}
          >
            起草反向修改
          </button>
        </div>
      ) : null}

      {artifact.status === 'adopted' &&
      !modifiedBook &&
      onRevoke !== undefined &&
      artifact.kind !== 'persona-delete' ? (
        <div className="inline">
          <span className="hint">已进素材库</span>
          <button
            type="button"
            className="ghost"
            disabled={locked}
            title="删掉刚进素材库的那一份，草稿退回「待采纳」——当作这次采纳没发生过"
            onClick={() => void perform('正在撤回…', onRevoke)}
          >
            撤回这次采纳
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 副对话（LAYOUT「副对话状态」）。
 *
 * 界面上是「世界管理员与用户」的对话，内容是正常的 AI 工作流：创建角色、
 * 创建设定。**不用气泡**——因为它不是在扮演谁，气泡会让人误以为管理员是
 * 场上的一员。此时 AI 不是任何角色。
 *
 * 管理员产出的角色卡与世界卡由用户决定去留：草稿摆在正文下面，
 * 点「采纳」才进素材库。
 */
function SideChatImpl({
  conversation,
  messages,
  busy,
  ready,
  archived,
  onSend,
  onStop,
  onAdopt,
  onDiscard,
  onRevoke,
  onReverse,
  worldBooks = [],
  conversations = [],
  bridge = null,
  manualMode = false,
  onBridgeCommit,
  onBridgeCancel,
  error = null,
}: Props) {
  countRender('SideChat');
  const coarsePointer = useCoarsePointer();
  /**
   * 流式正文自己订阅（顺序 59）：管理员每条分块只重画这一块，
   * 主对话那几百条消息、左栏与面板一条都不动。
   *
   * 顺序 104：这里多了两件事——`progress`（管理员刚才调了哪件工具）与 `handoffId`
   * （这一轮已经落盘、交给消息列表了）。交接的理由与主对话一致（顺序 91）：
   * 落盘那一刻同步清空会让文字先消失、等 IndexedDB 提交完再整条出现。
   */
  const stream = useStreamState('admin');
  const streamText = stream.text;
  const streamProgress = stream.progress;
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const contentLength =
    messages.reduce((total, message) => total + message.content.length, 0) + streamText.length + streamProgress.length;
  const lastMessageId = messages.at(-1)?.id ?? null;
  const handedOver = stream.handoffId !== null && stream.handoffId === lastMessageId;

  useEffect(() => {
    // 看见这条消息落进列表了才算交接完成；上一位的迟到 effect 不能收掉下一位已开始的流
    if (handedOver && stream.handoffId !== null) acknowledgeStreamHandoff('admin', stream.handoffId);
  }, [handedOver, stream.handoffId]);

  useEffect(
    () => () => {
      // 换对话 / 离开这一屏时把副通道收干净：不能把半截文字或没收走的交接带回来
      resetStreamState('admin');
    },
    [],
  );

  useEffect(() => {
    if (contentLength === 0) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [contentLength]);

  // 与主对话的输入框同一条规则：跟着字数长高，最多 200px
  // biome-ignore lint/correctness/useExhaustiveDependencies: 同上——跟着 input 重跑，但读的是 DOM 的实际高度
  useEffect(() => {
    const node = inputRef.current;
    if (node === null) return;
    node.style.height = 'auto';
    node.style.height = `${String(Math.min(node.scrollHeight, 200))}px`;
  }, [input]);

  const [selection, setSelection] = useState<{ roomId: string; id: ConversationId } | null>(null);
  const mains = conversations.filter(
    (item) =>
      item.roomId === conversation.roomId &&
      item.kind === 'main' &&
      item.archivedAt === null &&
      item.deletedAt === null,
  );
  const selected =
    selection?.roomId === conversation.roomId ? mains.find((item) => item.id === selection.id) : undefined;
  const target = selected ?? (mains.length === 1 ? mains[0] : undefined);

  const submit = (): void => {
    if (!ready || busy || archived || bridge !== null) return;
    const text = input.trim();
    if (text === '') return;
    onSend(text, target?.id);
    setInput('');
  };

  return (
    <section className="chat-surface side">
      <div className="chat-body">
        <div className="admin-hint">
          <strong>世界管理员</strong>
          <span className="hint">
            帮你起草角色卡、世界书与场景设置。它不扮演任何角色，素材由你采纳，场景修改会即时生效。
          </span>
        </div>

        {error === null ? null : (
          <div className="notice error">
            <strong>出错了</strong>
            <p>{error}</p>
          </div>
        )}

        {messages.length === 0 && streamText === '' && streamProgress === '' ? (
          <p className="hint">例如：「按这个世界的风格，起草一个酒馆老板，再补一段旧城的设定。」</p>
        ) : null}

        {messages.map((message) => (
          <article key={message.id} className={`admin-row ${message.role}`}>
            <span className="admin-role">
              {message.role === 'admin' ? '管理员' : message.role === 'player' ? '我' : message.role}
            </span>
            <div className="admin-text">{message.content}</div>

            {message.artifacts?.map((artifact) => (
              <ArtifactCard
                key={artifact.id}
                artifact={artifact}
                disabled={busy || archived}
                currentBook={
                  worldBooks.find((book) => book.id === (artifact.payload as { id?: unknown } | null)?.id) ?? null
                }
                {...(onReverse === undefined ? {} : { onReverse: () => onReverse(message.id, artifact) })}
                onAdopt={() => onAdopt(message.id, artifact)}
                onDiscard={() => onDiscard(message.id, artifact)}
                {...(onRevoke === undefined ? {} : { onRevoke: () => onRevoke(message.id, artifact) })}
              />
            ))}
          </article>
        ))}

        {/*
          顺序 104：副对话原来要等整轮收完才显示整段文字，中途什么都看不见。
          现在逐字流；管理员点名工具时（这个事件是「已经执行完」之后才来的）显示
          「工具调用：新建角色卡「秦娘」」这样一行，让用户看清它动了哪件素材。
          交接完成（handedOver）之后这一帧起不再画：正文已经在列表里了。
        */}
        {handedOver || (streamText === '' && streamProgress === '' && !busy) ? null : (
          <article className="admin-row admin">
            <span className="admin-role">管理员</span>
            {streamProgress === '' ? null : <p className="hint">工具调用：{streamProgress}</p>}
            {streamText === '' ? null : <div className="admin-text streaming">{streamText}</div>}
            {streamText === '' && streamProgress === '' ? <p className="hint">正在准备…</p> : null}
          </article>
        )}

        <div ref={bottomRef} />
      </div>

      {bridge === null || onBridgeCommit === undefined ? null : (
        <WebBridgePanel
          bridge={{ stage: 'admin', prompt: bridge.prompt }}
          busy={busy}
          disabled={archived}
          onReply={() => {}}
          onAnalysis={() => {}}
          onAdmin={onBridgeCommit}
          onSkip={onBridgeCancel ?? (() => {})}
        />
      )}

      <div className="admin-scene-target">
        <label>
          场景目标{' '}
          <select
            aria-label="场景目标"
            value={target?.id ?? ''}
            disabled={mains.length === 0 || busy || bridge !== null || archived}
            onChange={(event) =>
              setSelection(
                event.target.value ? { roomId: conversation.roomId, id: event.target.value as ConversationId } : null,
              )
            }
          >
            <option value="">{mains.length === 0 ? '没有主对话，不能设置场景' : '请选择场景目标'}</option>
            {mains.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        {!target ? (
          <p className="hint">
            {mains.length === 0 ? '请先新建主对话。' : '多条主对话时需要明确选择。'}角色卡、世界书和身份仍可起草。
          </p>
        ) : (
          <p className="hint">场景将即时修改「{target.title}」。本轮发送后固定目标。</p>
        )}
      </div>

      {/* 与主对话同一个输入区形态（用户 2026-09-21 要求照 Codex 的样子） */}
      <Composer
        value={input}
        onChange={setInput}
        inputRef={inputRef}
        disabled={!ready || archived}
        busy={busy}
        bridgeOpen={bridge !== null}
        manualMode={bridge === null && manualMode}
        bridgeTitle="先把这一轮贴回来（或点「放弃这次起草」）再发下一句"
        onSend={submit}
        onStop={onStop}
        placeholder={
          archived
            ? '已归档的对话不能再说话'
            : coarsePointer
              ? '告诉管理员你想搭什么……（回车换行，点右下角发送）'
              : '告诉管理员你想搭什么……（Enter 发送）'
        }
        tools={<span className="composer-location">{conversation.title}</span>}
      />
    </section>
  );
}

/**
 * memo（顺序 59）。它的输入框草稿住在自己里面，所以打字不会牵动 App；
 * 反过来，主对话流式或落盘时只要 props 没变，这一块也整块跳过。
 */
export const SideChat = memo(SideChatImpl);
