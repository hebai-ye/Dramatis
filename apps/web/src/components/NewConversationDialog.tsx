import type { Card, CardId, WorldBook, WorldBookId } from '@dramatis/core';
import { useState } from 'react';
import { Modal } from './Modal';

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
  }) => void;
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

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  return (
    <Modal
      label={mode === 'new-world' ? '新对话与新世界' : '新一轮对话'}
      closeLabel="取消"
      onClose={onClose}
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
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
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
              })
            }
          >
            开始
          </button>
        </>
      }
    >
      {mode === 'new-world' ? (
        <label>
          世界名
          <input value={worldTitle} onChange={(event) => setWorldTitle(event.target.value)} placeholder="例如：旧城" />
        </label>
      ) : null}

      <label>
        {mode === 'new-world' ? '首条对话名' : '对话名'}
        <input
          value={conversationTitle}
          onChange={(event) => setConversationTitle(event.target.value)}
          placeholder="例如：雨夜之后"
        />
      </label>

      <label>
        这个场景叫什么
        <input value={sceneTitle} onChange={(event) => setSceneTitle(event.target.value)} placeholder="开场" />
      </label>

      <div className="grid-2">
        <label>
          地点
          <input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="旧城东侧" />
        </label>
        <label>
          世界内时间
          <input value={worldTime} onChange={(event) => setWorldTime(event.target.value)} placeholder="第三日 · 黄昏" />
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
              disabled={mode === 'in-world' && attachedBookIds.includes(book.id)}
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
