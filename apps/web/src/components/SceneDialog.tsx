import {
  type CastPolicy,
  type CharacterInstance,
  defaultTravelCast,
  type InstanceId,
  type Scene,
} from '@dramatis/core';
import { type ChangeEvent, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CAST_POLICY_OPTIONS } from '../lib/labels';
import { type DialogGuard, useDialogActions } from './DialogShell';
import { Modal } from './Modal';

export type SceneSwitchResult =
  | { status: 'complete' }
  | { status: 'partial'; message: string }
  | { status: 'unavailable'; message: string };

interface Props {
  scene: Scene | null;
  instances: CharacterInstance[];
  disabled: boolean;
  onClose: () => void;
  onSave: (patch: Partial<Scene>) => Promise<void>;
  /** 结束本场、开新场；会写一条旁白式动作记录「谁跟谁去了哪里」。 */
  onStartNewScene: (input: {
    title: string;
    location: string;
    worldTime: string;
    /** 这次带谁走（T17）：没勾的人留在原地，自动转「在幕后」。 */
    cast: InstanceId[];
  }) => Promise<SceneSwitchResult>;
}

type DialogActions = ReturnType<typeof useDialogActions>;

const SCENE_DIRTY_GUARD: DialogGuard = {
  kind: 'dirty',
  message: '场景名、地点、时间或同行勾选尚未保存。离开会放弃这些更改；场景设定仍会自动保存。',
};
const CAST_DIRTY_GUARD: DialogGuard = {
  kind: 'dirty',
  message: '同行勾选只用于切换场景，保存当前场景不会保存这些勾选。关闭会放弃同行勾选；场景设定仍会自动保存。',
};
const TARGET_CHANGED_GUARD: DialogGuard = {
  kind: 'dirty',
  message:
    '当前场景已变化，本面板保留的是原场景输入。关闭会放弃本面板未提交的场景名、地点、时间、场景设定和同行勾选；已经提交的写入不会回滚。',
};

/** 必须处于 Modal 创建的 DialogShell provider 内，才能保护 Esc、遮罩与关闭按钮。 */
function GuardBridge({
  guard,
  actionsRef,
}: {
  guard: DialogGuard | null;
  actionsRef: { current: DialogActions | null };
}) {
  const actions = useDialogActions();
  useLayoutEffect(() => {
    actionsRef.current = actions;
    actions.setGuard(guard);
  }, [actions, actionsRef, guard]);
  useLayoutEffect(
    () => () => {
      actionsRef.current = null;
      actions.setGuard(null);
    },
    [actions, actionsRef],
  );
  return null;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SummaryDraft {
  sceneId: Scene['id'] | null;
  draft: string;
  saved: string;
  queued: string;
  pending: number;
  error: string | null;
  focused: boolean;
  composing: boolean;
  explicitComposing: boolean;
  tail: Promise<void>;
}

function newSummaryDraft(scene: Scene | null): SummaryDraft {
  const value = scene?.summary ?? '';
  return {
    sceneId: scene?.id ?? null,
    draft: value,
    saved: value,
    queued: value,
    pending: 0,
    error: null,
    focused: false,
    composing: false,
    explicitComposing: false,
    tail: Promise.resolve(),
  };
}

/** 摘要继续自动保存；只在 Promise 成功后确认保存，失败时保留可重试的本地草稿。 */
function useSceneSummary(scene: Scene | null, onSave: Props['onSave']) {
  const resourceRef = useRef<SummaryDraft>(newSummaryDraft(scene));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);
  const commitRef = useRef(onSave);
  commitRef.current = onSave;
  const [, render] = useState(0);
  const refresh = useCallback((resource: SummaryDraft): void => {
    if (mountedRef.current && resourceRef.current === resource) render((version) => version + 1);
  }, []);
  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  useLayoutEffect(() => {
    const resource = resourceRef.current;
    if (resource.sceneId !== (scene?.id ?? null)) {
      clearTimer();
      // 开窗时的编辑目标固定；外部换场不会覆盖原摘要草稿。
      return;
    }
    const value = scene?.summary ?? '';
    if (
      resource.draft === resource.saved &&
      resource.pending === 0 &&
      !resource.focused &&
      !resource.composing &&
      value !== resource.saved
    ) {
      resource.draft = resource.saved = resource.queued = value;
      refresh(resource);
    }
  }, [scene, clearTimer, refresh]);

  const enqueue = useCallback(
    (resource: SummaryDraft): Promise<void> => {
      if (resource.composing) return Promise.reject(new Error('请先完成输入法输入，再保存或离开。'));
      const next = resource.draft;
      if (next === resource.queued && (resource.pending > 0 || resource.error === null)) return resource.tail;
      // 入队时捕获目标场景的回调，后续渲染不能把旧摘要写到新场景。
      const commit = commitRef.current;
      resource.queued = next;
      resource.pending += 1;
      refresh(resource);
      resource.tail = resource.tail
        .catch(() => {})
        .then(async () => {
          try {
            await commit({ summary: next });
            resource.saved = next;
            resource.error = null;
          } catch (error) {
            resource.error = failureMessage(error);
            throw error;
          } finally {
            resource.pending -= 1;
            refresh(resource);
          }
        });
      // 防抖与失焦触发没有 await 的调用者；错误由界面保留并展示。
      void resource.tail.catch(() => {});
      return resource.tail;
    },
    [refresh],
  );
  const flush = useCallback(async (): Promise<void> => {
    clearTimer();
    const resource = resourceRef.current;
    await enqueue(resource);
    // 等待所有已入队写入；一次失败不能把该草稿标成已保存。
    while (resource.pending > 0 || resource.draft !== resource.saved) await enqueue(resource);
  }, [clearTimer, enqueue]);
  const queue = useCallback((): void => {
    clearTimer();
    const resource = resourceRef.current;
    if (resource.composing) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (resourceRef.current === resource && !resource.composing) void enqueue(resource).catch(() => {});
    }, 300);
  }, [clearTimer, enqueue]);

  const resource = resourceRef.current;
  return {
    pending: resource.pending > 0,
    composing: resource.composing,
    isComposing: () => resourceRef.current.composing,
    error: resource.error,
    flush,
    bind: {
      value: resource.draft,
      onChange: (event: ChangeEvent<HTMLTextAreaElement>): void => {
        const current = resourceRef.current;
        current.draft = event.target.value;
        // native-only 组合回退由下一次普通 input 解除；显式组合只能由 compositionend 结束。
        current.composing = current.explicitComposing || (event.nativeEvent as InputEvent).isComposing === true;
        refresh(current);
        queue();
      },
      onFocus: (): void => {
        resourceRef.current.focused = true;
      },
      onBlur: (): void => {
        resourceRef.current.focused = false;
        if (!resourceRef.current.composing) void flush().catch(() => {});
      },
      onCompositionStart: (): void => {
        resourceRef.current.explicitComposing = true;
        resourceRef.current.composing = true;
        clearTimer();
        refresh(resourceRef.current);
      },
      onCompositionEnd: (): void => {
        resourceRef.current.explicitComposing = false;
        resourceRef.current.composing = false;
        refresh(resourceRef.current);
        queue();
      },
    },
  };
}

/** 场景名、地点、时间显式保存；场景设定自动保存；切场是独立操作。 */
export function SceneDialog({ scene, instances, disabled, onClose, onSave, onStartNewScene }: Props) {
  const [title, setTitle] = useState(scene?.title ?? '');
  const [location, setLocation] = useState(scene?.location ?? '');
  const [worldTime, setWorldTime] = useState(scene?.worldTime ?? '');
  const [travelCast, setTravelCast] = useState<InstanceId[]>(() => defaultTravelCast(scene, instances));
  const [baseline, setBaseline] = useState(() => ({ title, location, worldTime, travelCast }));
  const [operation, setOperation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [switched, setSwitched] = useState<string | null>(null);
  const busyRef = useRef(false);
  const switchedRef = useRef(false);
  const switchingRef = useRef(false);
  const initialSceneIdRef = useRef(scene?.id ?? null);
  const latestSceneIdRef = useRef(scene?.id ?? null);
  latestSceneIdRef.current = scene?.id ?? null;
  const editorSceneRef = useRef(scene);
  if (latestSceneIdRef.current === initialSceneIdRef.current) editorSceneRef.current = scene;
  const editorScene = editorSceneRef.current;
  const saveCallbackRef = useRef(onSave);
  saveCallbackRef.current = onSave;
  const actionsRef = useRef<DialogActions | null>(null);
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const saveTarget = useCallback((patch: Partial<Scene>): Promise<void> => {
    if (latestSceneIdRef.current !== initialSceneIdRef.current) {
      return Promise.reject(new Error('当前场景已变化，原场景输入未写入新场景。请关闭面板后重新打开。'));
    }
    return saveCallbackRef.current(patch);
  }, []);
  const summaryField = useSceneSummary(scene, saveTarget);
  const targetChanged =
    latestSceneIdRef.current !== initialSceneIdRef.current && !switchingRef.current && !switchedRef.current;
  const fieldsDirty = title !== baseline.title || location !== baseline.location || worldTime !== baseline.worldTime;
  const castDirty =
    travelCast.length !== baseline.travelCast.length || travelCast.some((id) => !baseline.travelCast.includes(id));
  // 摘要提交前后复用同一 dirty guard，确认框不需要因为无关的自动保存再确认一次。
  const dirtyGuard = switched !== null ? null : fieldsDirty ? SCENE_DIRTY_GUARD : castDirty ? CAST_DIRTY_GUARD : null;
  const guard = useMemo<DialogGuard | null>(() => {
    if (operation !== null || summaryField.pending) {
      return { kind: 'busy', message: '场景正在保存或切换，请等待完成。' };
    }
    if (targetChanged) return TARGET_CHANGED_GUARD;
    if (disabled || summaryField.composing) {
      return {
        kind: 'busy',
        message: summaryField.composing ? '请先完成输入法输入，再保存或离开。' : '场景正在保存或切换，请等待完成。',
      };
    }
    return dirtyGuard;
  }, [operation, disabled, summaryField.pending, summaryField.composing, dirtyGuard, targetChanged]);

  const begin = (label: string, allowSwitched = false): boolean => {
    if (busyRef.current || disabled || (switchedRef.current && !allowSwitched)) return false;
    if (latestSceneIdRef.current !== initialSceneIdRef.current) {
      setError('当前场景已变化，请关闭面板后重新打开；原输入未写入新场景。');
      return false;
    }
    if (summaryField.isComposing()) {
      setError('请先完成输入法输入，再保存或离开。');
      return false;
    }
    busyRef.current = true;
    setOperation(label);
    setError(null);
    setSavedNotice(null);
    actionsRef.current?.setGuard({ kind: 'busy', message: `${label}，请等待完成。` });
    return true;
  };
  const finish = (): void => {
    busyRef.current = false;
    if (mountedRef.current) setOperation(null);
  };
  const markClean = (): void => {
    setBaseline({ title, location, worldTime, travelCast });
    actionsRef.current?.setGuard(null);
  };
  const close = async (): Promise<void> => {
    // 外部目标变化由 dirty guard 确认放弃；主动切场已消费原输入。这两种关闭都不能写新目标。
    if (switchedRef.current || (latestSceneIdRef.current !== initialSceneIdRef.current && !switchingRef.current)) {
      if (!busyRef.current && mountedRef.current) onClose();
      return;
    }
    if (!begin('正在保存场景设定', true)) return;
    try {
      await summaryField.flush();
      if (!mountedRef.current) return;
      if (latestSceneIdRef.current !== initialSceneIdRef.current) {
        setError('当前场景已变化，已保留原输入。请确认放弃后关闭。');
        return;
      }
      markClean();
      onClose();
    } catch (cause) {
      if (mountedRef.current) setError(`场景设定未保存，已保留输入：${failureMessage(cause)}`);
    } finally {
      finish();
    }
  };
  const save = async (): Promise<void> => {
    if (scene === null || !begin('正在保存当前场景')) return;
    try {
      await summaryField.flush();
      if (!mountedRef.current) return;
      await saveTarget({ title, location, worldTime });
      if (!mountedRef.current) return;
      if (latestSceneIdRef.current !== initialSceneIdRef.current) {
        setError('当前场景已变化，已保留原输入。请确认放弃后关闭。');
        return;
      }
      // 保存当前场景不消费同行勾选，仍须确认放弃后才能关闭。
      setBaseline((previous) => ({ ...previous, title, location, worldTime }));
      finish();
      actionsRef.current?.setGuard(castDirty ? CAST_DIRTY_GUARD : null);
      if (castDirty) {
        setSavedNotice('当前场景已保存。同行勾选只用于切换场景；关闭将放弃这些勾选。');
        actionsRef.current?.requestAction(() => {
          void close();
        });
      } else onClose();
    } catch (cause) {
      if (mountedRef.current) setError(`保存未完成，已保留输入：${failureMessage(cause)}`);
    } finally {
      finish();
    }
  };
  const switchScene = async (): Promise<void> => {
    if (!begin('正在切换场景')) return;
    try {
      await summaryField.flush();
      if (!mountedRef.current) return;
      if (latestSceneIdRef.current !== initialSceneIdRef.current) {
        throw new Error('当前场景已变化，未开始切换。请关闭面板后重新打开。');
      }
      switchingRef.current = true;
      const input = {
        title: title.trim() === '' ? '新场景' : title.trim(),
        location,
        worldTime,
        cast: travelCast,
      };
      const result = await onStartNewScene(input);
      if (!mountedRef.current) return;
      if (result.status === 'unavailable') {
        setError(result.message);
        return;
      }
      setBaseline({ title: input.title, location: input.location, worldTime: input.worldTime, travelCast });
      actionsRef.current?.setGuard(null);
      switchedRef.current = true;
      if (result.status === 'partial') {
        setTitle(input.title);
        setLocation(input.location);
        setWorldTime(input.worldTime);
        setSwitched(`场景已切换，后续未完成：${result.message}`);
      } else onClose();
    } catch (cause) {
      if (mountedRef.current) setError(`切换未完成，已保留输入：${failureMessage(cause)}`);
    } finally {
      switchingRef.current = false;
      finish();
    }
  };
  const savePolicy = async (castPolicy: CastPolicy): Promise<void> => {
    if (!begin('正在保存入场策略')) return;
    try {
      await summaryField.flush();
      if (!mountedRef.current) return;
      await saveTarget({ castPolicy });
    } catch (cause) {
      if (mountedRef.current) setError(`入场策略未保存：${failureMessage(cause)}`);
    } finally {
      finish();
    }
  };
  const locked = disabled || operation !== null || switched !== null || targetChanged;
  const cast = editorScene === null ? [] : instances.filter((instance) => editorScene.cast.includes(instance.id));

  return (
    <Modal
      label="场景"
      onClose={() => {
        void close();
      }}
      head={
        <>
          <strong>场景</strong>
          <span className="hint">
            {scene === null
              ? '这条对话还没有场景'
              : `当前：${scene.title}${scene.location === '' ? '' : ` · ${scene.location}`}`}
          </span>
        </>
      }
      footer={
        <>
          <button
            type="button"
            className="ghost"
            disabled={locked || scene === null || summaryField.composing}
            onClick={() => {
              void save();
            }}
          >
            {operation === '正在保存当前场景' ? '正在保存…' : '保存当前场景'}
          </button>
          <button
            type="button"
            disabled={locked || summaryField.composing}
            title="结束本场、开一场新的，并留下一条「谁跟谁去了哪里」的旁白"
            onClick={() => {
              void switchScene();
            }}
          >
            {operation === '正在切换场景' ? '正在切换…' : '从这里切换场景'}
          </button>
        </>
      }
    >
      <GuardBridge guard={guard} actionsRef={actionsRef} />
      {targetChanged ? (
        <p className="notice warn" role="alert">
          当前场景已变化。已保留原场景输入，保存和切场已停用；请关闭此面板后重新打开。
        </p>
      ) : null}
      {error === null ? null : (
        <p className="notice warn" role="alert">
          {error}
        </p>
      )}
      {savedNotice === null ? null : (
        <p className="hint" role="status">
          {savedNotice}
        </p>
      )}
      {switched === null ? null : (
        <p className="notice warn" role="status">
          {switched}。请关闭此面板后查看当前场景。
        </p>
      )}
      <p className="hint">场景名、地点和时间在「保存当前场景」后生效；「从这里切换场景」会创建新场景。</p>
      <label>
        场景名
        <input value={title} disabled={locked} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>
        地点
        <input
          value={location}
          disabled={locked}
          placeholder="例如：旧城东侧的夜间酒馆"
          onChange={(event) => setLocation(event.target.value)}
        />
      </label>
      <label>
        世界内时间
        <input
          value={worldTime}
          disabled={locked}
          placeholder="例如：第三日 · 黄昏"
          onChange={(event) => setWorldTime(event.target.value)}
        />
      </label>
      {editorScene !== null ? (
        <>
          <label>
            入场策略
            <select
              value={editorScene.castPolicy}
              disabled={locked || summaryField.composing}
              onChange={(event) => {
                void savePolicy(event.target.value as CastPolicy);
              }}
            >
              {CAST_POLICY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">
            {CAST_POLICY_OPTIONS.find((option) => option.value === editorScene.castPolicy)?.note ?? ''}
          </p>
          <label>
            场景设定
            <textarea rows={4} disabled={locked} {...summaryField.bind} />
          </label>
          <p className="hint">场景设定停笔或离开输入框后自动保存；关闭或切场前会等待保存完成。</p>
          {summaryField.pending ? (
            <p className="hint" role="status">
              正在自动保存场景设定…
            </p>
          ) : null}
          {summaryField.error === null ? null : (
            <div className="notice warn" role="alert">
              <p>场景设定保存失败，草稿已保留：{summaryField.error}</p>
              <button
                type="button"
                className="ghost"
                disabled={locked || summaryField.pending || summaryField.composing}
                onClick={() => {
                  void summaryField.flush().catch(() => {});
                }}
              >
                重试保存场景设定
              </button>
            </div>
          )}
        </>
      ) : null}
      <p className="hint">
        此刻在场：{cast.length === 0 ? '没有人' : cast.map((instance) => instance.displayName).join('、')}
      </p>
      <fieldset className="picker">
        <legend>这次带谁走</legend>
        <p className="hint">同行勾选只用于切换场景。取消勾选的人留在原地，会自动转为「在幕后」；旁白只记跟着走的人。</p>
        {cast.length === 0 ? (
          <p className="hint">此刻场上没有人。</p>
        ) : (
          cast.map((instance) => (
            <label key={instance.id} className="inline-check">
              <input
                type="checkbox"
                checked={travelCast.includes(instance.id)}
                disabled={locked}
                onChange={() =>
                  setTravelCast((previous) =>
                    previous.includes(instance.id)
                      ? previous.filter((id) => id !== instance.id)
                      : [...previous, instance.id],
                  )
                }
              />
              <span>{instance.displayName}</span>
            </label>
          ))
        )}
      </fieldset>
    </Modal>
  );
}
