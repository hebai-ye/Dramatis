import type { Card, ImportWarning, WorldBook, WorldBookId } from '@dramatis/core';
import { useRef } from 'react';

interface Props {
  card: Card | null;
  warnings: ImportWarning[];
  error: string | null;
  /** 说明导入会落在哪里，避免用户不知道会新建世界还是加入当前房间。 */
  importHint?: string;
  worldBooks: WorldBook[];
  onDetachWorldBook: (id: WorldBookId) => void;
  onImport: (file: File) => void;
  disabled: boolean;
}

export function CardPanel({
  card,
  warnings,
  error,
  importHint,
  worldBooks,
  onDetachWorldBook,
  onImport,
  disabled,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <section className="panel">
      <h2>角色卡</h2>

      <input
        ref={inputRef}
        type="file"
        accept=".json,.png,application/json,image/png"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onImport(file);
          event.target.value = '';
        }}
      />

      <button type="button" disabled={disabled} onClick={() => inputRef.current?.click()}>
        导入素材（角色卡 / 世界书）
      </button>
      {importHint !== undefined ? <p className="hint">{importHint}</p> : null}

      {worldBooks.length > 0 ? (
        <div className="card-summary">
          <h3>已挂载的世界书</h3>
          <ul className="room-list">
            {worldBooks.map((book) => (
              <li key={book.id}>
                <span className="room-title">{book.name || '未命名世界书'}</span>
                <span className="hint">{book.entries.length} 条</span>
                <button
                  type="button"
                  className="ghost danger"
                  disabled={disabled}
                  title="解绑（不会删除世界书本身）"
                  onClick={() => onDetachWorldBook(book.id)}
                >
                  解绑
                </button>
              </li>
            ))}
          </ul>
          <p className="hint">关键词命中时才会插入 prompt；常驻条目每轮都在。</p>
        </div>
      ) : null}

      {card ? (
        <div className="card-summary">
          <h3>{card.name}</h3>
          <p className="hint">
            {card.source.spec}
            {card.source.specVersion !== '' ? ` v${card.source.specVersion}` : ''}
            {card.source.fileName !== undefined ? ` · ${card.source.fileName}` : ''}
          </p>
          {card.tags.length > 0 ? <p className="hint">标签：{card.tags.join('、')}</p> : null}
          {card.creator !== '' ? <p className="hint">作者：{card.creator}</p> : null}
          <p className="hint">
            描述 {card.description.length} 字 · 性格 {card.personality.length} 字 · 开场白 {card.firstMessage.length} 字
            · 备选开场 {card.alternateGreetings.length} 条
          </p>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="notice warn">
          <strong>导入提示（{warnings.length}）</strong>
          <ul>
            {warnings.map((warning, index) => (
              <li key={`${warning.code}-${String(index)}`}>{warning.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {error !== null ? (
        <div className="notice error">
          <strong>出错了</strong>
          <p>{error}</p>
        </div>
      ) : null}
    </section>
  );
}
