import type { Card, CardId, WorldBook, WorldBookId } from '@dramatis/core';
import { useState } from 'react';

interface Props {
  cards: Card[];
  worldBooks: WorldBook[];
  /** 世界里已经有实例的卡，默认勾上。 */
  defaultCardIds: CardId[];
  attachedBookIds: WorldBookId[];
  disabled: boolean;
  onClose: () => void;
  onSubmit: (input: {
    title: string;
    cardIds: CardId[];
    worldBookIds: WorldBookId[];
    sceneTitle: string;
    location: string;
    worldTime: string;
  }) => void;
}

/**
 * 新对话（LAYOUT「输入区：开启新对话时投入世界卡与零或以上角色卡」）。
 *
 * 世界书就是世界卡，不是另一种资产——所以这里选的是「这条线用哪些世界书」
 * 与「由谁开始」，而不是先建世界再建对话。
 */
export function NewConversationDialog({
  cards,
  worldBooks,
  defaultCardIds,
  attachedBookIds,
  disabled,
  onClose,
  onSubmit,
}: Props) {
  const [title, setTitle] = useState('新对话');
  const [sceneTitle, setSceneTitle] = useState('开场');
  const [location, setLocation] = useState('');
  const [worldTime, setWorldTime] = useState('');
  const [cardIds, setCardIds] = useState<CardId[]>(defaultCardIds);
  const [bookIds, setBookIds] = useState<WorldBookId[]>(attachedBookIds);

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  return (
    <div className="modal-backdrop">
      <button type="button" className="modal-scrim" aria-label="关闭新对话" onClick={onClose} />
      <section className="modal" role="dialog" aria-label="新对话">
        <header className="modal-head">
          <strong>新对话</strong>
          <span className="hint">同一个世界下可以开多条线；角色与状态是世界共用的。</span>
          <div className="topbar-spacer" />
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
        </header>

        <div className="modal-body">
          <label>
            对话名
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：雨夜之后" />
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
              <input
                value={worldTime}
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
                  onChange={() => setCardIds((previous) => toggle(previous, card.id))}
                />
                <span>{card.name}</span>
                {card.description.trim() === '' ? null : <span className="hint">{card.description.slice(0, 40)}</span>}
              </label>
            ))}
          </fieldset>

          <fieldset className="picker">
            <legend>投入哪些世界书（世界卡）</legend>
            {worldBooks.length === 0 ? <p className="hint">素材库里还没有世界书。</p> : null}
            {worldBooks.map((book) => (
              <label key={book.id} className="inline-check">
                <input
                  type="checkbox"
                  checked={bookIds.includes(book.id)}
                  onChange={() => setBookIds((previous) => toggle(previous, book.id))}
                />
                <span>{book.name}</span>
                <span className="hint">{book.entries.length} 条</span>
              </label>
            ))}
          </fieldset>
        </div>

        <footer className="modal-foot">
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              onSubmit({
                title: title.trim() === '' ? '新对话' : title.trim(),
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
        </footer>
      </section>
    </div>
  );
}
