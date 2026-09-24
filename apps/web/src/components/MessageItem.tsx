import { assessAttribution, type CastName, type InstanceId, type Message, type MessageId } from '@dramatis/core';
import { type MouseEvent, memo, type TouchEvent, useMemo, useState } from 'react';
import { countRender } from '../lib/render-count';
import { Avatar, MessageBody } from './MessageBody';

/** 一条消息显示成谁说的：玩家永远是「我」，角色按当前在场名单的显示名。 */
export function nameOf(message: Message, cast: readonly CastName[]): string {
  if (message.role === 'player') return '我';
  const speaker = cast.find((instance) => instance.id === message.speakerInstanceId);
  return speaker?.displayName ?? message.speakerName;
}

/**
 * 每条消息共用的一组回调。
 *
 * 它们全部按 id 传参、由 MainChat 用 `useCallback` 造好、再用 `useMemo` 打成一个包——
 * 这样几百条 `MessageItem` 拿到的是同一个对象，`memo` 才真的能跳过它们。
 */
export interface MessageHandlers {
  onContextMenu: (id: MessageId, x: number, y: number) => void;
  onPressStart: (id: MessageId, x: number, y: number) => void;
  onPressCancel: () => void;
  onClickCapture: (event: MouseEvent<HTMLElement>) => void;
  onStartEdit: (id: MessageId) => void;
  onCancelEdit: () => void;
  onEdit: (id: MessageId, content: string) => void;
  onRegenerate: (id: MessageId) => void;
  onDelete: (id: MessageId) => void;
  onReassign: (id: MessageId, instanceId: InstanceId) => void;
}

interface ItemProps {
  message: Message;
  /** 只要 id 与显示名（顺序 62）：情绪每轮都在变，名字不变就不该重画 */
  cast: readonly CastName[];
  /** 只有最后一条角色回复可以重抽：重抽更早的消息会让后面的对话失去前提。 */
  isLastCharacter: boolean;
  editing: boolean;
  highlighted: boolean;
  menuOpen: boolean;
  showIntent: boolean;
  busy: boolean;
  archived: boolean;
  manualMode: boolean;
  handlers: MessageHandlers;
}

/** 编辑框：草稿只活在这里，打字不会惊动别的消息。 */
function EditBox({
  message,
  onSave,
  onCancel,
}: {
  message: Message;
  onSave: (content: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(message.content);
  return (
    <>
      <textarea rows={4} value={draft} onChange={(event) => setDraft(event.target.value)} />
      <div className="bubble-actions">
        <button type="button" onClick={() => onSave(draft)}>
          保存
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </>
  );
}

/**
 * 一条消息（顺序 59 从 MainChat 的 `messages.map` 里抽出来并 `memo`）。
 *
 * 目的只有一个：输入框每敲一个字、流式每来一个 token，几百条已落盘的消息不再重画。
 * 所以它的每个 prop 都是标量或稳定引用；按 id 传参的回调打包成 `handlers`。
 */
export const MessageItem = memo(function MessageItem({
  message,
  cast,
  isLastCharacter,
  editing,
  highlighted,
  menuOpen,
  showIntent,
  busy,
  archived,
  manualMode,
  handlers,
}: ItemProps) {
  countRender('MessageItem');
  const displayName = nameOf(message, cast);

  /**
   * 归属评估（T18）：纯规则、不调模型，结果只用来提示。
   * 消息或名单一变就重算——改了归属之后提示必须跟着刷新。
   */
  const attribution = useMemo(
    () =>
      message.role === 'character'
        ? assessAttribution({
            content: message.content,
            speaker: { instanceId: message.speakerInstanceId ?? ('' as InstanceId), displayName },
            cast,
          })
        : null,
    [message, cast, displayName],
  );

  return (
    <article
      data-message-id={message.id}
      className={`message-row ${message.role}${highlighted ? ' highlighted' : ''}${menuOpen ? ' menu-open' : ''}`}
      onContextMenu={(event) => {
        event.preventDefault();
        handlers.onContextMenu(message.id, event.clientX, event.clientY);
      }}
      onTouchStart={(event: TouchEvent<HTMLElement>) => {
        const point = event.touches[0];
        handlers.onPressStart(message.id, point?.clientX ?? 0, point?.clientY ?? 0);
      }}
      onTouchEnd={handlers.onPressCancel}
      onTouchMove={handlers.onPressCancel}
      onTouchCancel={handlers.onPressCancel}
      onClickCapture={handlers.onClickCapture}
    >
      {message.role === 'character' ? <Avatar name={displayName} /> : null}

      <div className="message-column">
        {message.role === 'character' ? <span className="message-name">{displayName}</span> : null}

        {/*
          他的心理活动**默认收起来**（用户要求：别把角色的心理摆在明面上）。
          措辞按来源分：他自己写的、导演调用推出来的、还是从推理流里摘的。
        */}
        {message.intent === undefined ? null : (
          <details className="intent-line" open={showIntent || undefined}>
            <summary>
              {message.intentSource === 'reasoning'
                ? '他当时在想什么（点开看）'
                : message.intentSource === 'planned'
                  ? '他这一轮想做什么（点开看）'
                  : '他自己写的意图（点开看）'}
            </summary>
            <p>{message.intent}</p>
          </details>
        )}

        {/*
          归属可疑提示（T18）。只提示、不自动改：硬改归属比错位更糟，
          所以把「更像是谁说的」摆出来，用户点一下才动数据。
        */}
        {attribution?.suspicious ? (
          <div className="attr-warn">
            <span>
              ⚠ 这条可能不是「{displayName}」说的：{attribution.reasons[0]}
            </span>
            {attribution.candidates.map((candidate) => (
              <button
                key={candidate.instanceId}
                type="button"
                className="ghost"
                disabled={busy || archived}
                title={candidate.reason}
                onClick={() => handlers.onReassign(message.id, candidate.instanceId)}
              >
                改成「{candidate.displayName}」说的
              </button>
            ))}
          </div>
        ) : null}

        {editing ? (
          <EditBox
            message={message}
            onSave={(content) => handlers.onEdit(message.id, content)}
            onCancel={handlers.onCancelEdit}
          />
        ) : (
          <MessageBody message={message} speakerName={displayName} showSpeaker={false}>
            {isLastCharacter ? (
              <button
                type="button"
                className="ghost"
                disabled={busy || archived || manualMode}
                title={
                  manualMode
                    ? '网页版模式下不重抽：删掉这条回复，再发一遍那句话，就会重新给你一段提示词'
                    : '撤销这条回复，让角色重新说一次'
                }
                onClick={() => handlers.onRegenerate(message.id)}
              >
                重抽
              </button>
            ) : null}
            <button
              type="button"
              className="ghost"
              disabled={busy || archived}
              onClick={() => handlers.onStartEdit(message.id)}
            >
              编辑
            </button>
            <button
              type="button"
              className="ghost danger"
              disabled={busy || archived}
              onClick={() => {
                if (window.confirm('删除这条消息？')) handlers.onDelete(message.id);
              }}
            >
              删除
            </button>
            <span className="row-menu-more">右键看更多</span>
          </MessageBody>
        )}
      </div>
    </article>
  );
});

interface ListProps {
  messages: readonly Message[];
  cast: readonly CastName[];
  lastCharacterId: MessageId | null;
  editingId: MessageId | null;
  highlightId: MessageId | null;
  menuFor: MessageId | null;
  showIntent: boolean;
  busy: boolean;
  archived: boolean;
  manualMode: boolean;
  handlers: MessageHandlers;
}

/**
 * 整个消息列表也 `memo`：输入框打字时 MainChat 会重渲染，但列表的 props 一个都没变，
 * 于是连几百个 `MessageItem` 元素都不用再造。
 */
export const MessageList = memo(function MessageList(props: ListProps) {
  countRender('MessageList');
  return (
    <>
      {props.messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          cast={props.cast}
          isLastCharacter={message.id === props.lastCharacterId}
          editing={props.editingId === message.id}
          highlighted={props.highlightId === message.id}
          menuOpen={props.menuFor === message.id}
          showIntent={props.showIntent}
          busy={props.busy}
          archived={props.archived}
          manualMode={props.manualMode}
          handlers={props.handlers}
        />
      ))}
    </>
  );
});
