import type { Card, CharacterInstance, InstanceId, MemoryEvent, Presence, RelationshipField } from '@dramatis/core';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PRESENCE_OPTIONS, signed } from '../lib/labels';
import { avatarOf, portraitOf } from '../lib/portraits';
import { useDraftField } from '../lib/useDraftField';
import { Avatar } from './MessageBody';
import { Modal, useModalSaves } from './Modal';

interface Props {
  instance: CharacterInstance;
  card: Card | null;
  memories: MemoryEvent[];
  disabled: boolean;
  onClose: () => void;
  onRename: (id: InstanceId, name: string) => void | Promise<void>;
  onSetPresence: (id: InstanceId, presence: Presence) => void | Promise<void>;
  /** 手动调整对玩家的某个关系维度（顺序 89：好感滑杆）。 */
  onSetRelationship: (id: InstanceId, field: RelationshipField, value: number) => void | Promise<void>;
  onRemove: (id: InstanceId) => void | Promise<void>;
  /** 按一条状态历史撤销影响（顺序 27d）。 */
  onRevertChange: (id: InstanceId, changeId: string) => Promise<void>;
}

/**
 * 角色详情（LAYOUT「在这里打开角色，显示角色详细信息」）。
 *
 * 显示的是这个角色**在这个世界里**的状态：角色卡是模板，实例才是他此刻
 * 的样子——情绪、关系、记忆都属于实例，换一张卡也不会把它们清掉。
 */
export function CastDetail({
  instance,
  card,
  memories,
  disabled,
  onClose,
  onRename,
  onSetPresence,
  onSetRelationship,
  onRemove,
  onRevertChange,
}: Props) {
  const scope = JSON.stringify([instance.roomId, instance.id]);
  const saves = useModalSaves(scope);
  const closingRef = useRef(false);
  const discardCloseRef = useRef(false);
  const [renderOwner, setRenderOwner] = useState(() => ({ scope }));
  let owner = renderOwner;
  if (owner.scope !== scope) {
    owner = { scope };
    setRenderOwner(owner);
  }
  const activeScope = useRef<typeof owner | null>(null);
  const requestRef = useRef<{ owner: typeof owner; changeId: string } | null>(null);
  const [feedback, setFeedback] = useState<{
    owner: typeof owner;
    pendingId: string | null;
    error: string | null;
  } | null>(null);
  useLayoutEffect(() => {
    activeScope.current = owner;
    return () => {
      activeScope.current = null;
      if (requestRef.current?.owner === owner) requestRef.current = null;
    };
  }, [owner]);
  const visibleFeedback = feedback?.owner === owner ? feedback : null;
  const pendingId = visibleFeedback?.pendingId ?? null;
  const editingDisabled = disabled || saves.busy || pendingId !== null;
  const guard = useMemo(
    () =>
      saves.busy || pendingId !== null
        ? {
            kind: 'busy' as const,
            message: pendingId !== null ? '正在撤销影响，请等待保存和核验完成。' : '正在保存角色更改，请等待完成。',
          }
        : saves.error !== null
          ? {
              kind: 'dirty' as const,
              message: '部分角色更改未保存。可以继续编辑并重试，或放弃这份未保存的草稿后关闭。',
              discard: () => {
                discardCloseRef.current = true;
              },
            }
          : null,
    [saves.busy, saves.error, pendingId],
  );
  async function revert(changeId: string): Promise<void> {
    if (disabled || saves.isBusy() || activeScope.current !== owner || requestRef.current?.owner === owner) return;
    const request = { owner, changeId };
    requestRef.current = request;
    setFeedback({ owner, pendingId: changeId, error: null });
    try {
      await onRevertChange(instance.id, changeId);
      if (activeScope.current === owner && requestRef.current === request)
        setFeedback({ owner, pendingId: null, error: null });
    } catch (error) {
      if (activeScope.current === owner && requestRef.current === request)
        setFeedback({ owner, pendingId: null, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (requestRef.current === request) requestRef.current = null;
    }
  }
  const own = memories.filter((memory) => memory.observerId === instance.id);
  const towardPlayer = instance.relationships.find((edge) => edge.target === 'player');
  const relationshipLabels = {
    trust: '信任',
    affinity: '好感',
    fear: '畏惧',
    respect: '敬重',
    tension: '紧张',
  } as const;
  const stateChanges = [
    ...instance.affect.history.map((change) => ({
      id: change.id,
      at: change.at,
      reason: change.reason,
      detail: `情绪 ${change.beforeValence.toFixed(2)} → ${change.afterValence.toFixed(2)}；激动 ${change.beforeArousal.toFixed(2)} → ${change.afterArousal.toFixed(2)}`,
      sourceMemoryIds: change.sourceMemoryIds,
      reversionOf: change.reversionOf,
    })),
    ...instance.relationships.flatMap((edge) =>
      edge.history.map((change) => ({
        id: change.id,
        at: change.at,
        reason: change.reason,
        detail: `对${edge.target === 'player' ? '玩家' : '他人'}的${relationshipLabels[change.field]} ${change.before.toFixed(2)} → ${change.after.toFixed(2)}`,
        sourceMemoryIds: change.sourceMemoryIds,
        reversionOf: change.reversionOf,
      })),
    ),
  ].sort((left, right) => right.at.localeCompare(left.at));
  const revertedIds = new Set(stateChanges.map((change) => change.reversionOf).filter((id) => id !== null));
  /** 显示名用草稿 hook（顺序 63）：以前每敲一个字就把实例写回仓储。 */
  const nameField = useDraftField({
    value: instance.displayName,
    commit: (next) => {
      if (next.trim() === '') return;
      void saves.save('name', () => onRename(instance.id, next));
    },
  });

  /*
   * 好感滑杆（顺序 89，用户点名「好感要能自己调」）。
   *
   * 显示按百分比：内部量表是 -1 ~ 1，40% 就是 0.4（新的初始好感）。滑杆只覆盖
   * 0 ~ 1：用户想表达的是「关系不错/很好」，负值交给剧情去跌，也可以等模型推下来
   * 之后在标签上看到负数（滑杆停在 0）。
   *
   * 拖动期间只改本地草稿，停手 300ms 才落库一次——`useDraftField` 那套正是为此写的，
   * 否则一次拖动会写几十次 IndexedDB 并重建整份快照。
   */
  const affinityPercent = towardPlayer === undefined ? 0 : Math.round(towardPlayer.affinity * 100);
  const affinityField = useDraftField({
    value: String(affinityPercent),
    commit: (next) => {
      const parsed = Number(next);
      if (!Number.isFinite(parsed)) return;
      void saves.save('affinity', () => onSetRelationship(instance.id, 'affinity', parsed / 100));
    },
  });
  const close = async (): Promise<void> => {
    if (closingRef.current || requestRef.current?.owner === owner) return;
    if (discardCloseRef.current) {
      onClose();
      return;
    }
    closingRef.current = true;
    try {
      if (!(await nameField.flush()) || !(await affinityField.flush())) return;
      if ((await saves.flush()) && activeScope.current === owner) onClose();
    } finally {
      closingRef.current = false;
    }
  };

  return (
    <Modal
      label="角色详情"
      onClose={close}
      guard={guard}
      head={
        <>
          <Avatar name={instance.displayName} size={40} avatar={avatarOf(card)} />
          <input className="conversation-name" disabled={editingDisabled} aria-label="显示名" {...nameField.bind} />
        </>
      }
    >
      {saves.error === null ? null : (
        <p className="notice error" role="alert">
          角色更改保存未完成：{saves.error}。草稿已保留，关闭时会重试保存。
        </p>
      )}
      {portraitOf(card) ? (
        <img className="cast-portrait" src={portraitOf(card) ?? ''} alt={`${instance.displayName}的立绘`} />
      ) : null}
      <section className="panel">
        <h2>在场状态</h2>
        <select
          value={instance.presence}
          disabled={editingDisabled}
          onChange={(event) => {
            const presence = event.target.value as Presence;
            void saves.save('presence', () => onSetPresence(instance.id, presence));
          }}
        >
          {PRESENCE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="hint">{PRESENCE_OPTIONS.find((option) => option.value === instance.presence)?.note ?? ''}</p>
      </section>

      <section className="panel">
        <h2>此刻的状态</h2>
        {pendingId === null ? null : (
          <p className="hint" role="status">
            正在撤销这条影响，等待保存并核验结果。
          </p>
        )}
        {visibleFeedback?.error ? (
          <p className="notice error" role="alert">
            撤销结果未确认：{visibleFeedback.error}
          </p>
        ) : null}
        <p className="hint">
          情绪：{signed(instance.affect.valence)} / 激动 {instance.affect.arousal.toFixed(2)}
        </p>
        {towardPlayer ? (
          <>
            <p className="hint">
              对玩家：信任 {signed(towardPlayer.trust)}、好感 {signed(towardPlayer.affinity)}、畏惧{' '}
              {signed(towardPlayer.fear)}、敬重 {signed(towardPlayer.respect)}、紧张 {signed(towardPlayer.tension)}
            </p>
            <label className="affinity-slider">
              <span className="hint">好感 {affinityPercent}%（可手动调整，独立于剧情推演）</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                disabled={editingDisabled}
                aria-label="对玩家的好感"
                {...affinityField.bind}
              />
            </label>
          </>
        ) : (
          <p className="hint">还没有对玩家的关系记录。</p>
        )}
        {stateChanges.length > 0 ? (
          <details>
            <summary>状态变化的可撤销记录（最近 {Math.min(stateChanges.length, 8)} 条）</summary>
            <ul className="state-history">
              {stateChanges.slice(0, 8).map((change) => (
                <li key={change.id}>
                  <div>
                    <strong>{change.reason || '未记录原因'}</strong>
                    <p className="hint">{change.detail}</p>
                    <p className="hint">
                      来源记忆 {change.sourceMemoryIds.length} 条
                      {change.reversionOf === null ? '' : ' · 这是一条撤销记录'}
                    </p>
                  </div>
                  {change.reversionOf !== null ? null : revertedIds.has(change.id) ? (
                    <span className="tag">已撤销</span>
                  ) : (
                    <button
                      type="button"
                      className="ghost"
                      disabled={editingDisabled}
                      title="追加一条反向记录，不改原记录"
                      onClick={() => void revert(change.id)}
                    >
                      {pendingId === change.id ? '正在撤销…' : '撤销这条影响'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section className="panel">
        <h2>角色卡</h2>
        {card === null ? (
          <p className="hint">找不到对应的角色卡。</p>
        ) : (
          <>
            <p className="hint">模板：{card.name}</p>
            {card.description.trim() !== '' ? <p>{card.description}</p> : null}
            {card.personality.trim() !== '' ? <p className="hint">性格：{card.personality}</p> : null}
          </>
        )}
      </section>

      <section className="panel">
        <h2>他记得的事（{own.length} 条）</h2>
        {own.length === 0 ? (
          <p className="hint">还没有属于他的记忆条目。</p>
        ) : (
          <ul className="hint">
            {own.slice(0, 5).map((memory) => (
              <li key={memory.id}>
                {memory.summary}
                {memory.perception.trim() === '' ? '' : `（他的感受：${memory.perception}）`}
              </li>
            ))}
          </ul>
        )}
      </section>

      <button
        type="button"
        className="ghost danger"
        disabled={editingDisabled}
        title="把这个角色移出这个世界（角色卡会保留）"
        onClick={() => {
          if (window.confirm(`把「${instance.displayName}」移出这个世界？`)) {
            void saves.save('remove', () => onRemove(instance.id), false);
          }
        }}
      >
        移出这个世界
      </button>
    </Modal>
  );
}
