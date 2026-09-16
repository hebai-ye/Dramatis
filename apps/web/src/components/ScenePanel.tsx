import type { CastPolicy, Scene } from '@dramatis/core';

interface Props {
  scene: Scene;
  onChange: (patch: Partial<Scene>) => void;
  onStartNewScene: (title: string) => void;
  disabled: boolean;
}

const CAST_POLICY_OPTIONS: Array<{ value: CastPolicy; label: string; note: string }> = [
  { value: 'locked', label: '锁定名单', note: 'AI 不得引入任何新角色' },
  { value: 'invite_only', label: '仅限召唤', note: '只有你点名的角色才能入场' },
  { value: 'triggered', label: '条件触发', note: '设定被触发时才入场' },
  { value: 'open', label: '自由入场', note: '符合条件的角色可自行登场' },
];

export function ScenePanel({ scene, onChange, onStartNewScene, disabled }: Props) {
  const current = CAST_POLICY_OPTIONS.find((option) => option.value === scene.castPolicy);

  return (
    <section className="panel">
      <h2>场景</h2>
      <p className="hint">
        M0 只有一名角色，入场策略的作用是让模型明确知道「现在不能拉人进来」——它会作为导演指令写进 prompt。
      </p>

      <label>
        地点
        <input
          type="text"
          value={scene.location}
          disabled={disabled}
          placeholder="例如：旧城东侧的夜间酒馆"
          onChange={(event) => onChange({ location: event.target.value })}
        />
      </label>

      <label>
        世界内时间
        <input
          type="text"
          value={scene.worldTime}
          disabled={disabled}
          placeholder="例如：第三日 · 黄昏"
          onChange={(event) => onChange({ worldTime: event.target.value })}
        />
      </label>

      <label>
        入场策略
        <select
          value={scene.castPolicy}
          disabled={disabled}
          onChange={(event) => onChange({ castPolicy: event.target.value as CastPolicy })}
        >
          {CAST_POLICY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {current ? <p className="hint">{current.note}</p> : null}

      <label>
        场景设定
        <textarea
          rows={4}
          value={scene.summary}
          disabled={disabled}
          onChange={(event) => onChange({ summary: event.target.value })}
        />
      </label>

      <button
        type="button"
        className="ghost"
        disabled={disabled}
        title="结束当前场景并开一个新的，过去的场景会被保留"
        onClick={() => {
          const title = window.prompt('新场景的名字', '新场景');
          if (title !== null) onStartNewScene(title.trim() === '' ? '新场景' : title.trim());
        }}
      >
        结束本场，开新场景
      </button>
    </section>
  );
}
