import type { CastPolicy, Scene } from '@dramatis/core';
import { useDraftField } from '../lib/useDraftField';

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
  /*
   * 三个文本字段都用草稿 hook（顺序 63）：打字只改本地草稿，停手 300ms 或失焦才落库。
   * 以前每敲一个字就 `onChange` 写一次库，输入法还会被打断。
   */
  const locationField = useDraftField({
    value: scene.location,
    commit: (next) => onChange({ location: next }),
  });
  const timeField = useDraftField({
    value: scene.worldTime,
    commit: (next) => onChange({ worldTime: next }),
  });
  const summaryField = useDraftField({
    value: scene.summary,
    commit: (next) => onChange({ summary: next }),
  });

  return (
    <section className="panel">
      <h2>场景</h2>
      <p className="hint">
        M0 只有一名角色，入场策略的作用是让模型明确知道「现在不能拉人进来」——它会作为导演指令写进 prompt。
      </p>

      <label>
        地点
        <input type="text" disabled={disabled} placeholder="例如：旧城东侧的夜间酒馆" {...locationField.bind} />
      </label>

      <label>
        世界内时间
        <input type="text" disabled={disabled} placeholder="例如：第三日 · 黄昏" {...timeField.bind} />
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
        <textarea rows={4} disabled={disabled} {...summaryField.bind} />
      </label>

      {/*
        场记（P1-5 的场景层）：后台自动整理，只读。
        它不是「场景设定」——那是人写的简介，这是这一段实际发生了什么。
      */}
      <div className="recap">
        <h3>本场场记</h3>
        {scene.recap === undefined || scene.recap.trim() === '' ? (
          <p className="hint">
            还没整理过。这一场攒够 8 轮（或内容够多）后会自动压成一段场记；原文不会被删， 随时都能回看。
          </p>
        ) : (
          <>
            <p className="recap-text">{scene.recap}</p>
            <p className="hint">
              覆盖到第 {scene.recapUpToSeq ?? 0} 条消息
              {scene.recapUpdatedAt === undefined
                ? ''
                : ` · 整理于 ${new Date(scene.recapUpdatedAt).toLocaleString('zh-CN', {
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}`}
            </p>
          </>
        )}
      </div>

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
