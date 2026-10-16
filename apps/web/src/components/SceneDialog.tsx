import {
  type CastPolicy,
  type CharacterInstance,
  defaultTravelCast,
  type InstanceId,
  type Scene,
} from '@dramatis/core';
import { useMemo, useRef, useState } from 'react';
import { CAST_POLICY_OPTIONS } from '../lib/labels';
import { useDraftField } from '../lib/useDraftField';
import { Modal, useModalSaves } from './Modal';

interface Props {
  scene: Scene | null;
  instances: CharacterInstance[];
  disabled: boolean;
  onClose: () => void;
  onSave: (patch: Partial<Scene>) => void | Promise<void>;
  /** 结束本场、开新场；会写一条旁白式动作记录「谁跟谁去了哪里」。 */
  onStartNewScene: (input: {
    title: string;
    location: string;
    worldTime: string;
    /** 这次带谁走（T17）：没勾的人留在原地，自动转「在幕后」。 */
    cast: InstanceId[];
  }) => void | Promise<void>;
}

/**
 * 场景面板（LAYOUT「输入区 · 场景：输入 / 切换当前场景」）。
 *
 * 输入场景与切换场景是两件事：
 * - 改字段 = 就地修改当前场景，安静地生效
 * - 切换场景 = 结束本场、开一场新的，并留下一条**旁白式动作**
 *   （「××× 与 ××× 进入了 ×××」），记录的是谁跟谁去了哪里
 */
export function SceneDialog({ scene, instances, disabled, onClose, onSave, onStartNewScene }: Props) {
  const [title, setTitle] = useState(scene?.title ?? '');
  const [location, setLocation] = useState(scene?.location ?? '');
  const [worldTime, setWorldTime] = useState(scene?.worldTime ?? '');
  // 默认带走此刻在场上的人；换场前可以逐个取消（长跑里秦娘就是这样被误带走的）
  const [travelCast, setTravelCast] = useState<InstanceId[]>(() => defaultTravelCast(scene, instances));
  // This dialog can intentionally create the next scene in the same conversation.
  // Its writes remain owned by that conversation until the successful close.
  const saves = useModalSaves(JSON.stringify([scene?.roomId, scene?.conversationId]));
  const closingRef = useRef(false);
  const discardCloseRef = useRef(false);
  const [closing, setClosing] = useState(false);
  const [initial] = useState(() => JSON.stringify([title, location, worldTime, travelCast]));
  const dirty = initial !== JSON.stringify([title, location, worldTime, travelCast]);
  const guard = useMemo(
    () =>
      saves.busy || closing
        ? { kind: 'busy' as const, message: '正在保存场景，请等待完成。' }
        : dirty || saves.error !== null
          ? {
              kind: 'dirty' as const,
              message: '场景名、地点、时间或携带角色尚未保存，关闭会放弃这些更改；已自动保存的设定会保留。',
              discard: () => {
                discardCloseRef.current = saves.error !== null;
              },
            }
          : null,
    [saves.busy, saves.error, closing, dirty],
  );
  const editingDisabled = disabled || saves.busy || closing;

  /*
   * 「场景设定」是这里唯一的长文本字段，也是唯一会被手写/笔画输入法打断的那个（顺序 91①）。
   * 以前它 `value={scene.summary}` + `onChange` 直接 `onSave`：落一个笔画写一次库，父组件
   * 回写还会把组合打断。现在用顺序 63 的草稿 hook——打字只改本地草稿，停手 300ms 或失焦
   * 才落库，组合期一个字节都不写。同名的内嵌面板（ScenePanel）早就是这种写法。
   */
  const summaryField = useDraftField({
    value: scene?.summary ?? '',
    commit: (next) => {
      void saves.save('summary', () => onSave({ summary: next }));
    },
  });

  /**
   * 关掉弹窗的每一条通路（遮罩、关闭按钮、两个页脚按钮）都先把没到点的草稿交出去：
   * `useDraftField` 卸载时会清掉计时器（`useDraftField.ts:70`），不 flush 就丢掉最后几个字。
   * Esc、遮罩与标题关闭经过统一守卫，获准关闭后同样等待设定落盘。
   */
  const close = async (): Promise<void> => {
    if (closingRef.current) return;
    if (discardCloseRef.current) {
      onClose();
      return;
    }
    closingRef.current = true;
    setClosing(true);
    try {
      if (!(await summaryField.flush())) return;
      if (await saves.flush()) onClose();
    } finally {
      closingRef.current = false;
      setClosing(false);
    }
  };
  const saveAndClose = async (key: string, action: () => void | Promise<void>): Promise<void> => {
    if (disabled || saves.isBusy() || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    try {
      // Flush into the current scene before switching so the old summary cannot
      // be written to the newly created scene by a late close.
      if (!(await summaryField.flush())) return;
      if (!(await saves.flush())) return;
      if (await saves.save(key, action, false)) onClose();
    } finally {
      closingRef.current = false;
      setClosing(false);
    }
  };

  const cast = scene === null ? [] : instances.filter((instance) => scene.cast.includes(instance.id));

  return (
    <Modal
      label="场景"
      onClose={close}
      guard={guard}
      initialFocus="[data-dialog-initial-focus]"
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
            disabled={editingDisabled}
            onClick={() => saveAndClose('scene', () => onSave({ title, location, worldTime }))}
          >
            保存当前场景
          </button>
          <button
            type="button"
            disabled={editingDisabled}
            title="结束本场、开一场新的，并留下一条「谁跟谁去了哪里」的旁白"
            onClick={() =>
              saveAndClose('scene', () =>
                onStartNewScene({
                  title: title.trim() === '' ? '新场景' : title.trim(),
                  location,
                  worldTime,
                  cast: travelCast,
                }),
              )
            }
          >
            从这里切换场景
          </button>
        </>
      }
    >
      {saves.error === null ? null : (
        <p className="notice error" role="alert">
          场景保存未完成：{saves.error}。草稿已保留，请重试。
        </p>
      )}
      <label>
        场景名
        <input
          data-dialog-initial-focus
          value={title}
          disabled={editingDisabled}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        地点
        <input
          value={location}
          disabled={editingDisabled}
          placeholder="例如：旧城东侧的夜间酒馆"
          onChange={(event) => setLocation(event.target.value)}
        />
      </label>
      <label>
        世界内时间
        <input
          value={worldTime}
          disabled={editingDisabled}
          placeholder="例如：第三日 · 黄昏"
          onChange={(event) => setWorldTime(event.target.value)}
        />
      </label>

      {scene !== null ? (
        <>
          <label>
            入场策略
            <select
              value={scene.castPolicy}
              disabled={editingDisabled}
              onChange={(event) => {
                const castPolicy = event.target.value as CastPolicy;
                void saves.save('policy', () => onSave({ castPolicy }));
              }}
            >
              {CAST_POLICY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">{CAST_POLICY_OPTIONS.find((option) => option.value === scene.castPolicy)?.note ?? ''}</p>

          <label>
            场景设定
            <textarea rows={4} disabled={editingDisabled} {...summaryField.bind} />
          </label>
        </>
      ) : null}

      <p className="hint">
        此刻在场：{cast.length === 0 ? '没有人' : cast.map((instance) => instance.displayName).join('、')}
      </p>

      <fieldset className="picker">
        <legend>这次带谁走</legend>
        <p className="hint">取消勾选的人留在原地，会自动转为「在幕后」；旁白只记跟着走的人。</p>
        {cast.length === 0 ? (
          <p className="hint">此刻场上没有人。</p>
        ) : (
          cast.map((instance) => (
            <label key={instance.id} className="inline-check">
              <input
                type="checkbox"
                checked={travelCast.includes(instance.id)}
                disabled={editingDisabled}
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
