import { createPersona, type Persona } from '@dramatis/core';
import type { ChangeEvent } from 'react';
import { useLibraryEditor } from '../lib/library-editor';

interface Props {
  personas: Persona[];
  selectedId?: string | null;
  onSelectionChange?: (id: string | null) => void;
  hideSelector?: boolean;
  disabled: boolean;
  onSave: (persona: Persona) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}

/**
 * 玩家身份库（左栏「我的身份」）。
 *
 * 一份 persona 描述「你在对话中是谁」，可以跨世界、跨对话复用。
 * 这里负责创建、编辑与删除；具体某条对话用哪一份，留到对话面板里选择。
 */
export function PersonaLibrary({
  personas,
  disabled,
  onSave,
  onDelete,
  selectedId,
  onSelectionChange,
  hideSelector = false,
}: Props) {
  const editor = useLibraryEditor({
    items: personas,
    view: 'personas',
    selectedId,
    onSelectionChange,
    initialId: personas[0]?.id ?? null,
    disabled,
    onSave,
  });
  const draft = editor.draft;
  const active = draft;
  const writeDisabled = editor.writeDisabled;
  const patchActive = (patch: Partial<Persona>, event?: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    editor.patch(patch, (event?.nativeEvent as InputEvent | undefined)?.isComposing === true);
  };
  const beginComposition = editor.beginComposition;
  const endComposition = editor.endComposition;
  const blurEditor = editor.commit;
  return (
    <div className="stack">
      <div className="inline">
        {!hideSelector ? (
          <select
            value={active?.id ?? ''}
            aria-label="正在编辑的身份"
            onChange={(event) => editor.select(event.target.value || null)}
          >
            <option value="">选择要编辑的身份…</option>
            {personas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className="ghost"
          disabled={writeDisabled}
          onClick={() => editor.create(createPersona({ name: '新身份' }))}
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
      {active === null ? (
        <p className="hint">身份决定角色怎么称呼你，也是角色关系的目标。可以建多个，按世界切换。</p>
      ) : (
        <>
          <label>
            名字
            <input
              type="text"
              value={draft?.name ?? active.name}
              disabled={writeDisabled}
              onBlur={blurEditor}
              onCompositionStart={beginComposition}
              onCompositionEnd={endComposition}
              onChange={(event) => patchActive({ name: event.target.value }, event)}
            />
          </label>
          <label>
            设定
            <textarea
              rows={5}
              value={draft?.description ?? active.description}
              disabled={writeDisabled}
              placeholder="你是谁、长什么样、什么来头"
              onBlur={blurEditor}
              onCompositionStart={beginComposition}
              onCompositionEnd={endComposition}
              onChange={(event) => patchActive({ description: event.target.value }, event)}
            />
          </label>
          <button
            type="button"
            className="ghost danger"
            disabled={writeDisabled}
            title="删除后，引用它的世界会退回没有身份的状态，但对话与记忆都保留"
            onClick={() => {
              if (window.confirm(`删除身份「${active.name}」？`)) return editor.remove(() => onDelete(active.id));
            }}
          >
            删除这个身份
          </button>
        </>
      )}
    </div>
  );
}
