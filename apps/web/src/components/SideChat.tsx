import type { AdminArtifact, Conversation, ConversationId, Message, MessageId, WorldBook } from '@dramatis/core';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useAdminProcess } from '../hooks/useAdminProcess';
import type { BridgeCommitOutcome } from '../lib/admin';
import type { ArtifactAction, ArtifactActionResult } from '../lib/admin-artifact-actions';
import { type AdminProcessScope, adminProcessStore } from '../lib/admin-process-store';
import { type ChatSend, useChatDraft } from '../lib/chat-draft';
import { useChatViewportVisibility } from '../lib/chat-visibility';
import { countRender } from '../lib/render-count';
import { isNearBottom } from '../lib/scroll';
import { acknowledgeStreamHandoff, resetStreamState, useStreamState } from '../lib/stream-store';
import { useCoarsePointer } from '../lib/viewport';
import { AdminArtifactCard } from './AdminArtifactCard';
import { AdminProcessDisclosure } from './AdminProcessDisclosure';
import { Composer } from './Composer';
import { WebBridgePanel } from './WebBridgePanel';

interface Props {
  conversation: Conversation;
  messages: Message[];
  busy: boolean;
  ready: boolean;
  archived: boolean;
  onSend: (text: string, targetConversationId?: ConversationId) => ReturnType<ChatSend>;
  draftScope?: string;
  onStop: () => void;
  onAdopt:
    | ((messageId: MessageId, artifact: AdminArtifact) => void)
    | ((messageId: MessageId, artifact: AdminArtifact) => Promise<ArtifactActionResult>);
  onDiscard:
    | ((messageId: MessageId, artifact: AdminArtifact) => void)
    | ((messageId: MessageId, artifact: AdminArtifact) => Promise<ArtifactActionResult>);
  onRevoke?:
    | ((messageId: MessageId, artifact: AdminArtifact) => void)
    | ((messageId: MessageId, artifact: AdminArtifact) => Promise<ArtifactActionResult>);
  onInspect?: (messageId: MessageId, artifact: AdminArtifact, action: ArtifactAction) => Promise<ArtifactActionResult>;
  onOpenTarget?: (artifact: AdminArtifact) => void;
  onReverse?: (messageId: MessageId, artifact: AdminArtifact) => void | Promise<void>;
  worldBooks?: readonly WorldBook[];
  conversations?: readonly Conversation[];
  existingIds?: readonly string[];
  processScope?: AdminProcessScope | null;
  activeRunId?: string | null;
  canStop?: boolean;
  needsInspection?: boolean;
  onRunInspect?: () => Promise<BridgeCommitOutcome>;
  bridge?: {
    prompt: string;
    binding?: {
      accountKey: string;
      roomId: string;
      conversationId: string;
      revision: string;
      worldTitle: string;
      conversationTitle: string;
    };
  } | null;
  manualMode?: boolean;
  onBridgeCommit?: ((text: string) => void) | ((text: string) => Promise<BridgeCommitOutcome>);
  onBridgeInspect?: () => Promise<BridgeCommitOutcome>;
  onBridgeCancel?: () => void;
  error?: string | null;
}
function SideChatImpl({
  conversation,
  messages,
  busy,
  ready,
  archived,
  onSend,
  draftScope,
  onStop,
  onAdopt,
  onDiscard,
  onRevoke,
  onInspect,
  onOpenTarget,
  existingIds = [],
  processScope = null,
  activeRunId = null,
  canStop = true,
  needsInspection = false,
  onRunInspect,
  onReverse,
  worldBooks = [],
  conversations = [],
  bridge = null,
  manualMode = false,
  onBridgeCommit,
  onBridgeInspect,
  onBridgeCancel,
  error = null,
}: Props) {
  countRender('SideChat');
  const coarsePointer = useCoarsePointer();
  const stream = useStreamState('admin');
  const currentRun = useAdminProcess(processScope, { runId: activeRunId ?? '' });
  const streamText = stream.text || currentRun?.unsaved?.text || '';
  const streamProgress = stream.progress;
  const {
    input,
    setInput,
    submit: submitDraft,
    notice: sendNotice,
  } = useChatDraft(draftScope ?? conversation.id, (text) => onSend(text, target?.id));
  const bottomRef = useRef<HTMLDivElement | null>(null),
    inputRef = useRef<HTMLTextAreaElement | null>(null),
    bodyRef = useRef<HTMLDivElement | null>(null),
    flowRef = useRef<HTMLDivElement | null>(null);
  const { visibleRef, scrollVisibility } = useChatViewportVisibility(bodyRef, inputRef, conversation.id);
  const nearBottomRef = useRef(true),
    conversationKeyRef = useRef<string | null>(null),
    previousMessageRef = useRef<MessageId | null>(null);
  const [following, setFollowing] = useState(true);
  const onBodyScroll = useCallback(() => {
    const node = bodyRef.current;
    if (node && visibleRef.current) {
      nearBottomRef.current = isNearBottom(node);
      setFollowing(nearBottomRef.current);
    }
  }, [visibleRef]);
  const contentLength = messages.length + streamText.length + streamProgress.length + (currentRun?.entries.length ?? 0);
  const lastMessageId = messages.at(-1)?.id ?? null,
    lastIsPlayer = messages.at(-1)?.role === 'player';
  const handedOver = stream.handoffId !== null && messages.some((message) => message.id === stream.handoffId);
  useEffect(() => {
    if (handedOver && stream.handoffId !== null) acknowledgeStreamHandoff('admin', stream.handoffId);
  }, [handedOver, stream.handoffId]);
  useEffect(() => () => resetStreamState('admin'), []);
  useEffect(() => {
    if (contentLength === 0) return;
    const switched = conversationKeyRef.current !== conversation.id,
      sent = lastIsPlayer && previousMessageRef.current !== lastMessageId;
    conversationKeyRef.current = conversation.id;
    previousMessageRef.current = lastMessageId;
    const node = bodyRef.current;
    if (!node) return;
    if (!visibleRef.current) {
      if (scrollVisibility.followHiddenRef.current === true) node.scrollTop = node.scrollHeight;
      return;
    }
    if (typeof window !== 'undefined' && window.getSelection()?.toString()) return;
    if (switched || sent || nearBottomRef.current) {
      nearBottomRef.current = true;
      setFollowing(true);
      node.scrollTo({ top: node.scrollHeight, behavior: 'instant' });
    }
  }, [contentLength, conversation.id, lastMessageId, lastIsPlayer, visibleRef, scrollVisibility]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-observe the flow when its conversation changes.
  useEffect(() => {
    const node = flowRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (nearBottomRef.current && visibleRef.current && !window.getSelection()?.toString() && bodyRef.current)
        bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [conversation.id, visibleRef]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: textarea height follows the current draft.
  useEffect(() => {
    const node = inputRef.current;
    if (node) {
      node.style.height = 'auto';
      node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
    }
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
    if (!ready || busy || archived || bridge !== null || needsInspection) return;
    void submitDraft();
  };
  const freezeReading = () => {
    nearBottomRef.current = false;
    setFollowing(false);
  };
  const renderCard = (message: Message, artifact: AdminArtifact) => {
    const run = processScope ? adminProcessStore.get(processScope, { messageId: message.id }) : null;
    const target = run?.sceneTargets[artifact.id];
    return (
      <AdminArtifactCard
        key={`${draftScope ?? conversation.id}:${artifact.id}`}
        artifact={artifact}
        disabled={busy || archived}
        exists={
          typeof (artifact.payload as { id?: unknown } | null)?.id === 'string' &&
          existingIds.includes((artifact.payload as { id: string }).id)
        }
        scopeKey={`${draftScope ?? conversation.id}:${message.id}`}
        targetLabel={
          artifact.kind === 'scene' && target
            ? [target.worldTitle, target.conversationTitle, target.sceneTitle].join(' / ')
            : undefined
        }
        currentBook={worldBooks.find((book) => book.id === (artifact.payload as { id?: unknown } | null)?.id) ?? null}
        {...(onReverse ? { onReverse: () => onReverse(message.id, artifact) } : {})}
        onAdopt={() => onAdopt(message.id, artifact)}
        onDiscard={() => onDiscard(message.id, artifact)}
        {...(onRevoke ? { onRevoke: () => onRevoke(message.id, artifact) } : {})}
        {...(onInspect ? { onInspect: (action: ArtifactAction) => onInspect(message.id, artifact, action) } : {})}
        {...(onOpenTarget ? { onOpenTarget: () => onOpenTarget(artifact) } : {})}
        onReadHistory={freezeReading}
      />
    );
  };
  const showRun =
    !handedOver &&
    !(currentRun?.messageId && messages.some((m) => m.id === currentRun.messageId)) &&
    (busy || streamText !== '' || streamProgress !== '' || currentRun !== null);
  const composer = (
    <Composer
      value={input}
      onChange={setInput}
      inputRef={inputRef}
      disabled={!ready || archived}
      busy={busy}
      canStop={canStop}
      bridgeOpen={bridge !== null || needsInspection}
      manualMode={bridge === null && manualMode}
      bridgeTitle={
        needsInspection ? '上一轮保存结果待核对，输入已保留，请先只读核对' : '先应用或放弃这次起草，再发下一句'
      }
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
  );
  return (
    <section className="chat-surface side">
      <div className="chat-body" ref={bodyRef} onScroll={onBodyScroll}>
        <div className="admin-flow" ref={flowRef}>
          <div className="admin-hint">
            <strong>世界管理员</strong>
          </div>
          {messages.length === 0 && streamText === '' && !busy ? (
            <p className="hint">例如：起草一个酒馆老板，再补一段旧城设定。</p>
          ) : null}
          {messages.map((message) => {
            const run = processScope ? adminProcessStore.get(processScope, { messageId: message.id }) : null;
            return (
              <article
                key={run?.runId ?? message.id}
                data-message-id={message.id}
                className={`admin-row ${message.role}`}
              >
                <span className="admin-role">
                  {message.role === 'admin' ? '管理员' : message.role === 'player' ? '我' : message.role}
                </span>
                {run && processScope ? <AdminProcessDisclosure scope={processScope} runId={run.runId} /> : null}
                <div className="admin-text">{message.content}</div>
                {message.artifacts?.map((artifact) => renderCard(message, artifact))}
              </article>
            );
          })}
          {showRun ? (
            <article key={activeRunId ?? 'stream'} className="admin-row admin">
              <span className="admin-role">管理员</span>
              {currentRun && processScope ? (
                <AdminProcessDisclosure scope={processScope} runId={currentRun.runId} />
              ) : streamText === '' && streamProgress === '' ? (
                <p className="hint">正在准备…</p>
              ) : null}
              {!currentRun && streamProgress !== '' ? <p className="hint">工具调用：{streamProgress}</p> : null}
              {streamText !== '' ? (
                <div className={`admin-text${busy || stream.phase === 'writing' ? ' streaming' : ''}`}>
                  {streamText}
                </div>
              ) : null}
              {currentRun?.unsaved && (currentRun.unsaved.text !== '' || currentRun.unsaved.artifacts.length > 0) ? (
                <>
                  <p className="hint warn">
                    {currentRun.phase === 'uncertain'
                      ? '保存结果待核对，内容已保留，可复制。'
                      : '以下内容未保存，可复制保留。'}
                  </p>
                  {currentRun.unsaved.artifacts.map((artifact) => (
                    <div className="artifact" key={artifact.id}>
                      <strong>{artifact.title}</strong>
                      <p className="hint">{artifact.summary} · 草稿尚未保存</p>
                      <details>
                        <summary>查看未保存内容</summary>
                        <pre>{JSON.stringify(artifact.payload, null, 2)}</pre>
                      </details>
                    </div>
                  ))}
                </>
              ) : null}
            </article>
          ) : null}
          {bridge && onBridgeCommit ? (
            <WebBridgePanel
              bridge={{
                stage: 'admin',
                prompt: bridge.prompt,
                sourceLabel: bridge.binding
                  ? [bridge.binding.worldTitle, bridge.binding.conversationTitle].join(' / ')
                  : '旧进度缺少来源，请放弃后重新准备',
                sourceKey: bridge.binding
                  ? JSON.stringify([
                      bridge.binding.accountKey,
                      bridge.binding.roomId,
                      bridge.binding.conversationId,
                      bridge.binding.revision,
                    ])
                  : bridge.prompt,
              }}
              busy={busy}
              disabled={archived}
              onReply={() => {}}
              onAnalysis={() => {}}
              onAdmin={onBridgeCommit}
              onInspect={onBridgeInspect}
              onSkip={onBridgeCancel ?? (() => {})}
            />
          ) : null}
          <div ref={bottomRef} />
        </div>
      </div>
      {!following ? (
        <button
          type="button"
          className="ghost admin-back-latest"
          onClick={() => {
            nearBottomRef.current = true;
            setFollowing(true);
            bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'instant' });
          }}
        >
          回到最新 ↓
        </button>
      ) : null}
      {(needsInspection || currentRun?.phase === 'saved-read-failed') && onRunInspect ? (
        <div className="composer-notice">
          <p className="hint">上一轮内容已保留。先核对保存结果，再发送下一句。</p>
          <button type="button" className="ghost" disabled={busy} onClick={() => void onRunInspect()}>
            只读核对保存结果
          </button>
        </div>
      ) : null}
      {!currentRun && error ? (
        <p className="notice error composer-notice" role="alert">
          {error}
        </p>
      ) : null}
      <div className="admin-scene-target">
        <label>
          场景目标{' '}
          <select
            aria-label="场景目标"
            value={target?.id ?? ''}
            disabled={mains.length === 0 || busy || bridge !== null || needsInspection || archived}
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
      {sendNotice ? (
        <p className="notice error composer-notice" role="alert">
          {sendNotice}
        </p>
      ) : null}
      {bridge ? (
        <>
          <p className="hint composer-notice">先应用或放弃当前回复，再发送下一句。</p>
          <details className="admin-next-draft">
            <summary>下一句草稿{input ? ' · 已保留' : ''}</summary>
            {composer}
          </details>
        </>
      ) : (
        composer
      )}
    </section>
  );
}
export const SideChat = memo(SideChatImpl);
