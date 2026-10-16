import type { CastPolicy, Scene } from '@dramatis/core';
import { useCallback, useEffect } from 'react';
import { CAST_POLICY_OPTIONS } from '../lib/labels';
import { type DraftFlush, flushDraftFields, useDraftField } from '../lib/useDraftField';
import { useSerialSave } from '../lib/useSerialSave';
import { DraftSaveFeedback } from './DraftSaveFeedback';

interface Props {
  scene: Scene;
  onChange: (patch: Partial<Scene>) => void | Promise<void>;
  onStartNewScene: (title: string) => void | Promise<void>;
  disabled: boolean;
  onRegisterFlush?: (flush: DraftFlush | null) => void;
}

export function ScenePanel({ scene, onChange, onStartNewScene, disabled, onRegisterFlush }: Props) {
  const saves = useSerialSave(scene.id);
  const locationField = useDraftField({
    value: scene.location,
    scope: scene.id,
    commit: (next) => saves.run(() => onChange({ location: next })),
  });
  const timeField = useDraftField({
    value: scene.worldTime,
    scope: scene.id,
    commit: (next) => saves.run(() => onChange({ worldTime: next })),
  });
  const summaryField = useDraftField({
    value: scene.summary,
    scope: scene.id,
    commit: (next) => saves.run(() => onChange({ summary: next })),
  });
  const policyField = useDraftField({
    value: scene.castPolicy,
    scope: scene.id,
    delay: 0,
    commit: (next) => saves.run(() => onChange({ castPolicy: next as CastPolicy })),
  });
  const current = CAST_POLICY_OPTIONS.find((option) => option.value === policyField.bind.value);
  const flush = useCallback(async () => {
    return flushDraftFields([locationField, timeField, summaryField, policyField], saves.flush);
  }, [locationField, timeField, summaryField, policyField, saves.flush]);
  useEffect(() => {
    onRegisterFlush?.(flush);
    return () => onRegisterFlush?.(null);
  }, [onRegisterFlush, flush]);

  return (
    <section className="panel">
      <h2>场景</h2>
      <p className="hint">修改后自动保存。入场策略决定角色能否自行加入当前场景。</p>

      <label>
        地点
        <input type="text" disabled={disabled} placeholder="例如：旧城东侧的夜间酒馆" {...locationField.bind} />
      </label>
      <DraftSaveFeedback field={locationField} label="地点" />

      <label>
        世界内时间
        <input type="text" disabled={disabled} placeholder="例如：第三日 · 黄昏" {...timeField.bind} />
      </label>
      <DraftSaveFeedback field={timeField} label="世界内时间" />

      <label>
        入场策略
        <select disabled={disabled} {...policyField.bind}>
          {CAST_POLICY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <DraftSaveFeedback field={policyField} label="入场策略" />
      {current ? <p className="hint">{current.note}</p> : null}

      <label>
        场景设定
        <textarea rows={4} disabled={disabled} {...summaryField.bind} />
      </label>
      <DraftSaveFeedback field={summaryField} label="场景设定" />
      {saves.error ? (
        <p className="hint error" role="alert">
          场景操作未完成：{saves.error}
        </p>
      ) : null}

      <button
        type="button"
        className="ghost"
        disabled={disabled || saves.busy}
        title="结束当前场景并开一个新的，过去的场景会被保留"
        onClick={async () => {
          const title = window.prompt('新场景的名字', '新场景');
          if (title === null || !(await flush())) return;
          try {
            await saves.run(() => onStartNewScene(title.trim() === '' ? '新场景' : title.trim()));
          } catch {
            /* The local queue displays the error. */
          }
        }}
      >
        结束本场，开新场景
      </button>
    </section>
  );
}
