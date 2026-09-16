import { createPersona, type Persona } from '@dramatis/core';

interface Props {
  personas: Persona[];
  activeId: string | null;
  disabled: boolean;
  onSelect: (persona: Persona) => void;
  onSave: (persona: Persona) => void;
  onDelete: (id: string) => void;
}

/**
 * 玩家身份库（侧边栏的设定功能）。
 *
 * 一份 persona 描述「你在这个世界里是谁」，可以跨世界复用。
 * 当前世界用哪一份由顶部栏切换，这里只负责编辑它们。
 */
export function PersonaLibrary({ personas, activeId, disabled, onSelect, onSave, onDelete }: Props) {
  const active = personas.find((persona) => persona.id === activeId) ?? null;

  return (
    <div className="stack">
      <div className="inline">
        <select
          value={activeId ?? ''}
          disabled={disabled}
          onChange={(event) => {
            const persona = personas.find((item) => item.id === event.target.value);
            if (persona) onSelect(persona);
          }}
        >
          <option value="">选择身份…</option>
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
            onSelect(persona);
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
              onChange={(event) => onSave({ ...active, name: event.target.value })}
            />
          </label>
          <label>
            设定
            <textarea
              rows={5}
              value={active.description}
              disabled={disabled}
              placeholder="你是谁、长什么样、什么来头"
              onChange={(event) => onSave({ ...active, description: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="ghost danger"
            disabled={disabled || personas.length <= 1}
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
