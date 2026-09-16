import type { Card, ImportWarning } from '@dramatis/core';
import { useRef } from 'react';

interface Props {
  card: Card | null;
  warnings: ImportWarning[];
  error: string | null;
  /** 说明导入会落在哪里，避免用户不知道会新建世界还是加入当前房间。 */
  importHint?: string;
  onImport: (file: File) => void;
  disabled: boolean;
}

export function CardPanel({ card, warnings, error, importHint, onImport, disabled }: Props) {
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
        导入角色卡（PNG / JSON）
      </button>
      {importHint !== undefined ? <p className="hint">{importHint}</p> : null}

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
