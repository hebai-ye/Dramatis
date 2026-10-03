import {
  createBlankWorldBook,
  createWorldBookEntry,
  type WorldBook,
  type WorldBookEntry,
  type WorldBookId,
} from '@dramatis/core';
import { useState } from 'react';
import { useLibraryEditor } from '../lib/library-editor';

interface Props {
  books: WorldBook[];
  selectedId?: string | null;
  onSelectionChange?: (id: string | null) => void;
  hideSelector?: boolean;
  canAttach?: boolean;
  onDetach?: (id: WorldBookId) => void | Promise<void>;
  attachedIds: string[];
  disabled: boolean;
  onSave: (book: WorldBook) => void | Promise<void>;
  onDelete: (id: WorldBookId) => void | Promise<void>;
  onAttach: (book: WorldBook) => void | Promise<void>;
}

const KEY_SEPARATOR = /[,，、]/;

function parseKeys(value: string): string[] {
  return value
    .split(KEY_SEPARATOR)
    .map((key) => key.trim())
    .filter((key) => key !== '');
}

/**
 * 世界书设计器（侧边栏的设定功能）。
 *
 * 世界书是「这个世界怎么运转」的地方：地名、组织、历史、人物关系，
 * 只有关键词命中时才插入 prompt，所以写多少都不会挤占日常对话的预算。
 */
export function WorldDesigner({
  books,
  attachedIds,
  disabled,
  onSave,
  onDelete,
  onAttach,
  onDetach,
  canAttach = true,
  selectedId,
  onSelectionChange,
  hideSelector = false,
}: Props) {
  const [expandedEntry, setExpandedEntry] = useState<string | null>(null);
  const editor = useLibraryEditor({
    items: books,
    view: 'worldbooks',
    selectedId,
    onSelectionChange,
    disabled,
    onSave,
  });
  const draft = editor.draft;
  const writeDisabled = editor.writeDisabled;
  const commit = (next: WorldBook): void => {
    editor.replace(next);
    void editor.commit();
  };
  const patchEntry = (entryId: string, changes: Partial<WorldBookEntry>): void => {
    if (!draft) return;
    commit({
      ...draft,
      entries: draft.entries.map((entry) => (entry.id === entryId ? { ...entry, ...changes } : entry)),
    });
  };

  /**
   * 文本先改本地草稿，短延迟或失焦时统一落盘。
   *
   * 文本输入逐字落盘会连带重扫整个素材库，打字时会明显卡顿；
   * 复选框、增删这类离散操作用 patchEntry 立即保存，文本走协调后的延迟/失焦提交。
   */
  const patchEntryLocal = (entryId: string, changes: Partial<WorldBookEntry>): void => {
    if (!draft) return;
    editor.replace({
      ...draft,
      entries: draft.entries.map((entry) => (entry.id === entryId ? { ...entry, ...changes } : entry)),
    });
  };

  return (
    <div className="stack" onCompositionStart={editor.beginComposition} onCompositionEnd={editor.endComposition}>
      <div className="inline">
        {!hideSelector ? (
          <select value={editor.selectedId ?? ''} onChange={(event) => editor.select(event.target.value || null)}>
            <option value="">选择一本世界书…</option>
            {books.map((book) => (
              <option key={book.id} value={book.id}>
                {book.name}（{book.entries.length} 条）
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className="ghost"
          disabled={writeDisabled}
          onClick={() => editor.create(createBlankWorldBook())}
        >
          ＋ 新建
        </button>
      </div>

      {editor.error ? (
        <p role="alert" className="notice error">
          {editor.error}
          <button type="button" disabled={writeDisabled} onClick={editor.commit}>
            重试保存
          </button>
        </p>
      ) : null}
      {draft === null ? (
        <p className="hint">
          世界书只在关键词命中时插入对话，适合放地名、组织、历史这类「需要时才提起」的设定。
          上方「素材」面板里可以把它挂到当前世界。
        </p>
      ) : (
        <>
          <label>
            名称
            <input
              type="text"
              value={draft.name}
              disabled={writeDisabled}
              onChange={(event) => editor.patch({ name: event.target.value })}
              onBlur={editor.commit}
            />
          </label>

          <div className="inline">
            <button
              type="button"
              className="ghost"
              disabled={writeDisabled}
              onClick={() => {
                const entry = createWorldBookEntry();
                commit({ ...draft, entries: [...draft.entries, entry] });
                setExpandedEntry(entry.id);
              }}
            >
              ＋ 新增条目
            </button>
            <button
              type="button"
              className="ghost"
              disabled={writeDisabled || !canAttach || (attachedIds.includes(draft.id) && !onDetach)}
              onClick={() =>
                editor.run(() => (attachedIds.includes(draft.id) && onDetach ? onDetach(draft.id) : onAttach(draft)))
              }
            >
              {attachedIds.includes(draft.id) ? '从当前世界解绑' : '挂到当前世界'}
            </button>
          </div>

          {!canAttach ? <p className="hint">请先选择一个世界，再挂载世界书。</p> : null}
          {draft.entries.length === 0 ? (
            <p className="hint">还没有条目。常驻条目每轮都会插入；带关键词的条目只在命中时插入。</p>
          ) : (
            <ul className="entry-list">
              {draft.entries.map((entry) => {
                const expanded = expandedEntry === entry.id;
                return (
                  <li key={entry.id}>
                    <div className="entry-head">
                      <button
                        type="button"
                        className="room-open"
                        onClick={() => setExpandedEntry(expanded ? null : entry.id)}
                      >
                        <span className="room-title">{entry.title || '未命名条目'}</span>
                        <span className="hint">
                          {entry.constant
                            ? '常驻'
                            : entry.keys.length === 0
                              ? '没有关键词，永远不会触发'
                              : entry.keys.join('、')}
                        </span>
                      </button>
                      <label className="inline-check">
                        <input
                          type="checkbox"
                          checked={entry.disabled}
                          disabled={writeDisabled}
                          onChange={(event) => patchEntry(entry.id, { disabled: event.target.checked })}
                        />
                        停用
                      </label>
                      <button
                        type="button"
                        className="ghost danger"
                        disabled={writeDisabled}
                        onClick={() =>
                          commit({ ...draft, entries: draft.entries.filter((item) => item.id !== entry.id) })
                        }
                      >
                        删
                      </button>
                    </div>

                    {expanded ? (
                      <div className="entry-editor">
                        <label>
                          标题（只给自己看）
                          <input
                            type="text"
                            value={entry.title}
                            disabled={writeDisabled}
                            onChange={(event) => patchEntryLocal(entry.id, { title: event.target.value })}
                            onBlur={editor.commit}
                          />
                        </label>
                        <label>
                          内容
                          <textarea
                            rows={4}
                            value={entry.content}
                            disabled={writeDisabled}
                            placeholder="命中后会原样插入 prompt 的设定文字"
                            onChange={(event) => patchEntryLocal(entry.id, { content: event.target.value })}
                            onBlur={editor.commit}
                          />
                        </label>
                        <label>
                          关键词（用逗号分隔）
                          <input
                            type="text"
                            value={entry.keys.join('、')}
                            disabled={writeDisabled || entry.constant}
                            placeholder="酒馆、旧城、老板"
                            onChange={(event) => patchEntryLocal(entry.id, { keys: parseKeys(event.target.value) })}
                            onBlur={editor.commit}
                          />
                        </label>
                        <div className="grid-3">
                          <label className="inline-check">
                            <input
                              type="checkbox"
                              checked={entry.constant}
                              disabled={writeDisabled}
                              onChange={(event) => patchEntry(entry.id, { constant: event.target.checked })}
                            />
                            常驻（不看关键词）
                          </label>
                          <label>
                            顺序
                            <input
                              type="number"
                              step="10"
                              value={entry.order}
                              disabled={writeDisabled}
                              onChange={(event) => patchEntry(entry.id, { order: Number(event.target.value) || 0 })}
                            />
                          </label>
                          <label>
                            触发概率 %
                            <input
                              type="number"
                              min="1"
                              max="100"
                              value={entry.probability}
                              disabled={writeDisabled}
                              onChange={(event) =>
                                patchEntry(entry.id, {
                                  probability: Math.max(1, Math.min(100, Number(event.target.value) || 100)),
                                })
                              }
                            />
                          </label>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          <button
            type="button"
            className="ghost danger"
            disabled={writeDisabled}
            onClick={() => {
              const impact = canAttach
                ? '从素材库删除，并从当前世界解绑；对话记录保留。'
                : '从素材库删除；对话记录保留。';
              if (window.confirm(`删除世界书「${draft.name}」？${impact}`)) {
                return editor.remove(() => onDelete(draft.id));
              }
            }}
          >
            删除这本世界书
          </button>
        </>
      )}
    </div>
  );
}
