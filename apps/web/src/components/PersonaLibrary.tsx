import { createPersona, type Persona } from '@dramatis/core';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';

interface Props {
  personas: Persona[];
  disabled: boolean;
  onSave: (persona: Persona) => void;
  onDelete: (id: string) => void;
}

/**
 * 玩家身份库（左栏「我的身份」）。
 *
 * 一份 persona 描述「你在对话中是谁」，可以跨世界、跨对话复用。
 * 这里负责创建、编辑与删除；具体某条对话用哪一份，留到对话面板里选择。
 */
export function PersonaLibrary({ personas, disabled, onSave, onDelete }: Props) {
  const [editingId, setEditingId] = useState<string | null>(personas[0]?.id ?? null);
  const active = personas.find((persona) => persona.id === editingId) ?? personas[0] ?? null;
  const [draft, setDraft] = useState<Persona | null>(active);
  const draftRef = useRef<Persona | null>(active);
  const savedRef = useRef<Persona | null>(active);
  const focusedRef = useRef(false);
  const composingRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (editingId !== null && personas.some((persona) => persona.id === editingId)) return;
    setEditingId(personas[0]?.id ?? null);
  }, [editingId, personas]);

  useEffect(() => {
    /*
     * 输入法/手写输入会把一个词拆成多个 composition 事件。
     * 焦点还在输入框、或正在组合时，绝不把父组件刚回写的旧对象盖回草稿，
     * 否则每落一个笔画都会重新挂值，组合马上断掉。
     */
    if (active !== null && draftRef.current?.id === active.id && (focusedRef.current || composingRef.current)) {
      return;
    }
    draftRef.current = active;
    savedRef.current = active;
    setDraft(active);
  }, [active]);

  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    },
    [],
  );

  const clearSaveTimer = (): void => {
    if (saveTimerRef.current === null) return;
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
  };

  const commitDraft = (): void => {
    clearSaveTimer();
    const current = draftRef.current;
    if (current === null || composingRef.current) return;
    const saved = savedRef.current;
    if (saved !== null && saved.name === current.name && saved.description === current.description) return;
    savedRef.current = current;
    onSave(current);
  };

  const queueSave = (): void => {
    clearSaveTimer();
    if (composingRef.current) return;
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      if (composingRef.current) return;
      const current = draftRef.current;
      if (current === null) return;
      savedRef.current = current;
      onSave(current);
    }, 300);
  };

  const patchActive = (patch: Partial<Persona>, event?: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    const current = draftRef.current;
    if (current === null) return;
    const next = { ...current, ...patch };
    draftRef.current = next;
    setDraft(next);
    const nativeComposing = event !== undefined && (event.nativeEvent as InputEvent).isComposing === true;
    if (!composingRef.current && !nativeComposing) queueSave();
  };

  const beginComposition = (): void => {
    composingRef.current = true;
    clearSaveTimer();
  };

  const endComposition = (): void => {
    composingRef.current = false;
    queueSave();
  };

  const focusEditor = (): void => {
    focusedRef.current = true;
  };

  const blurEditor = (): void => {
    focusedRef.current = false;
    commitDraft();
  };

  return (
    <div className="stack">
      <div className="inline">
        <select
          value={active?.id ?? ''}
          disabled={disabled}
          aria-label="正在编辑的身份"
          onChange={(event) => {
            commitDraft();
            focusedRef.current = false;
            setEditingId(event.target.value);
          }}
        >
          <option value="">选择要编辑的身份…</option>
          {personas.map((persona) => (
            <option key={persona.id} value={persona.id}>
              {persona.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ghost"
          disabled={disabled}
          onClick={() => {
            commitDraft();
            const persona = createPersona({ name: '新身份' });
            onSave(persona);
            setEditingId(persona.id);
          }}
        >
          ＋ 新建
        </button>
      </div>

      {active === null ? (
        <p className="hint">身份决定角色怎么称呼你，也是角色关系的目标。可以建多个，按世界切换。</p>
      ) : (
        <>
          <label>
            名字
            <input
              type="text"
              value={draft?.name ?? active.name}
              disabled={disabled}
              onFocus={focusEditor}
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
              disabled={disabled}
              placeholder="你是谁、长什么样、什么来头"
              onFocus={focusEditor}
              onBlur={blurEditor}
              onCompositionStart={beginComposition}
              onCompositionEnd={endComposition}
              onChange={(event) => patchActive({ description: event.target.value }, event)}
            />
          </label>
          <button
            type="button"
            className="ghost danger"
            disabled={disabled}
            title="删除后，引用它的世界会退回没有身份的状态，但对话与记忆都保留"
            onClick={() => {
              const persona = draftRef.current ?? active;
              if (window.confirm(`删除身份「${persona.name}」？`)) onDelete(persona.id);
            }}
          >
            删除这个身份
          </button>
        </>
      )}
    </div>
  );
}
