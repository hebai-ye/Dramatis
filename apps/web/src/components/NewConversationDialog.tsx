import type { Card, CardId, WorldBook, WorldBookId } from '@dramatis/core';
import { useMemo, useState } from 'react';
import { Modal, useModalSaves } from './Modal';

interface Props {
  mode: 'new-world' | 'in-world';
  currentWorldTitle?: string;
  cards: Card[];
  worldBooks: WorldBook[];
  /** 世界里已经有实例的卡，默认勾上。 */
  defaultCardIds: CardId[];
  attachedBookIds: WorldBookId[];
  disabled: boolean;
  onClose: () => void;
  onSubmit: (input: {
    worldTitle: string;
    conversationTitle: string;
    cardIds: CardId[];
    worldBookIds: WorldBookId[];
    sceneTitle: string;
    location: string;
    worldTime: string;
  }) => void | Promise<void>;
}

/**
 * 新世界的首条对话，或当前世界内的新一轮对话。
 *
 * 世界书挂在世界上，角色卡决定这条对话由谁开场。
 */
export function NewConversationDialog({
  mode,
  currentWorldTitle,
  cards,
  worldBooks,
  defaultCardIds,
  attachedBookIds,
  disabled,
  onClose,
  onSubmit,
}: Props) {
  const [worldTitle, setWorldTitle] = useState('新世界');
  const [conversationTitle, setConversationTitle] = useState(mode === 'new-world' ? '开场' : '新对话');
  const [sceneTitle, setSceneTitle] = useState('开场');
  const [location, setLocation] = useState('');
  const [worldTime, setWorldTime] = useState('');
  const [cardIds, setCardIds] = useState<CardId[]>(defaultCardIds);
  const [bookIds, setBookIds] = useState<WorldBookId[]>(attachedBookIds);
  const saves = useModalSaves('new-conversation');
  const [initial] = useState(() =>
    JSON.stringify([worldTitle, conversationTitle, sceneTitle, location, worldTime, cardIds, bookIds]),
  );
  const dirty =
    initial !== JSON.stringify([worldTitle, conversationTitle, sceneTitle, location, worldTime, cardIds, bookIds]);
  const guard = useMemo(
    () =>
      saves.busy
        ? { kind: 'busy' as const, message: '正在创建对话，请等待保存完成。' }
        : dirty
          ? { kind: 'dirty' as const, message: '新对话的填写内容尚未保存，关闭会放弃这份草稿。' }
          : null,
    [saves.busy, dirty],
  );

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  return (
    <Modal
      label={mode === 'new-world' ? '新对话与新世界' : '新一轮对话'}
      closeLabel="取消"
      onClose={onClose}
      guard={guard}
      initialFocus="[data-dialog-initial-focus]"
      head={
        <>
          <strong>{mode === 'new-world' ? '新对话' : '新一轮对话'}</strong>
          <span className="hint">
            {mode === 'new-world'
              ? '创建一个新世界，并在其中开启首条对话。'
              : `在「${currentWorldTitle ?? '当前世界'}」继续开一条线；角色与状态在这个世界内共用。`}
          </span>
        </>
      }
      footer={(requestClose) => (
        <>
          <button type="button" className="ghost" onClick={requestClose}>
            取消
          </button>
          <button
            type="button"
            disabled={disabled || saves.busy}
            onClick={async () => {
              if (disabled || saves.isBusy()) return;
              if (
                await saves.save(
                  'create',
                  () =>
                    onSubmit({
                      worldTitle: worldTitle.trim() === '' ? '新世界' : worldTitle.trim(),
                      conversationTitle:
                        conversationTitle.trim() === ''
                          ? mode === 'new-world'
                            ? '开场'
                            : '新对话'
                          : conversationTitle.trim(),
                      cardIds,
                      worldBookIds: bookIds,
                      sceneTitle: sceneTitle.trim() === '' ? '开场' : sceneTitle.trim(),
                      location,
                      worldTime,
                    }),
                  false,
                )
              )
                onClose();
            }}
          >
            开始
          </button>
        </>
      )}
    >
      {saves.error === null ? null : (
        <p className="notice error" role="alert">
          创建未完成：{saves.error}。填写内容已保留，请重试。
        </p>
      )}
      {mode === 'new-world' ? (
        <label>
          世界名
          <input
            data-dialog-initial-focus
            value={worldTitle}
            disabled={disabled || saves.busy}
            onChange={(event) => setWorldTitle(event.target.value)}
            placeholder="例如：旧城"
          />
        </label>
      ) : null}

      <label>
        {mode === 'new-world' ? '首条对话名' : '对话名'}
        <input
          data-dialog-initial-focus={mode === 'in-world' ? '' : undefined}
          disabled={disabled || saves.busy}
          value={conversationTitle}
          onChange={(event) => setConversationTitle(event.target.value)}
          placeholder="例如：雨夜之后"
        />
      </label>

      <label>
        这个场景叫什么
        <input
          value={sceneTitle}
          disabled={disabled || saves.busy}
          onChange={(event) => setSceneTitle(event.target.value)}
          placeholder="开场"
        />
      </label>

      <div className="grid-2">
        <label>
          地点
          <input
            value={location}
            disabled={disabled || saves.busy}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="旧城东侧"
          />
        </label>
        <label>
          世界内时间
          <input
            value={worldTime}
            disabled={disabled || saves.busy}
            onChange={(event) => setWorldTime(event.target.value)}
            placeholder="第三日 · 黄昏"
          />
        </label>
      </div>

      <fieldset className="picker">
        <legend>投入哪些角色卡（可以为空）</legend>
        {cards.length === 0 ? <p className="hint">素材库里还没有角色卡。</p> : null}
        {cards.map((card) => (
          <label key={card.id} className="inline-check">
            <input
              type="checkbox"
              checked={cardIds.includes(card.id)}
              disabled={disabled || saves.busy}
              onChange={() => setCardIds((previous) => toggle(previous, card.id))}
            />
            <span>{card.name}</span>
            {card.description.trim() === '' ? null : <span className="hint">{card.description.slice(0, 40)}</span>}
          </label>
        ))}
      </fieldset>

      <fieldset className="picker">
        <legend>{mode === 'new-world' ? '投入哪些世界书（世界卡）' : '为这个世界添加世界书'}</legend>
        {mode === 'in-world' ? <p className="hint">已挂载的世界书会保留；解绑请到运行时面板操作。</p> : null}
        {worldBooks.length === 0 ? <p className="hint">素材库里还没有世界书。</p> : null}
        {worldBooks.map((book) => (
          <label key={book.id} className="inline-check">
            <input
              type="checkbox"
              checked={bookIds.includes(book.id)}
              disabled={disabled || saves.busy || (mode === 'in-world' && attachedBookIds.includes(book.id))}
              onChange={() => setBookIds((previous) => toggle(previous, book.id))}
            />
            <span>{book.name}</span>
            <span className="hint">{book.entries.length} 条</span>
          </label>
        ))}
      </fieldset>
    </Modal>
  );
}
