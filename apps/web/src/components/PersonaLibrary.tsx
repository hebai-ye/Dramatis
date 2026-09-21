import { createPersona, type Persona } from '@dramatis/core';
import { useEffect, useRef, useState } from 'react';

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
  const activeRef = useRef<Persona | null>(active);

  useEffect(() => {
    if (editingId !== null && personas.some((persona) => persona.id === editingId)) return;
    setEditingId(personas[0]?.id ?? null);
  }, [editingId, personas]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const patchActive = (patch: Partial<Persona>): void => {
    const current = activeRef.current;
    if (current === null) return;
    const next = { ...current, ...patch };
    activeRef.current = next;
    onSave(next);
  };

  return (
    <div className="stack">
      <div className="inline">
        <select
          value={active?.id ?? ''}
          disabled={disabled}
          aria-label="正在编辑的身份"
          onChange={(event) => setEditingId(event.target.value)}
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
              value={active.name}
              disabled={disabled}
              onChange={(event) => patchActive({ name: event.target.value })}
            />
          </label>
          <label>
            设定
            <textarea
              rows={5}
              value={active.description}
              disabled={disabled}
              placeholder="你是谁、长什么样、什么来头"
              onChange={(event) => patchActive({ description: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="ghost danger"
            disabled={disabled}
            title="删除后，引用它的世界会退回没有身份的状态，但对话与记忆都保留"
            onClick={() => {
              if (window.confirm(`删除身份「${active.name}」？`)) onDelete(active.id);
            }}
          >
            删除这个身份
          </button>
        </>
      )}
    </div>
  );
}
