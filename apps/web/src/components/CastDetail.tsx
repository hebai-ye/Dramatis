import type { Card, CharacterInstance, InstanceId, MemoryEvent, Presence } from '@dramatis/core';
import { useDraftField } from '../lib/useDraftField';
import { Avatar } from './MessageBody';

interface Props {
  instance: CharacterInstance;
  card: Card | null;
  memories: MemoryEvent[];
  disabled: boolean;
  onClose: () => void;
  onRename: (id: InstanceId, name: string) => void;
  onSetPresence: (id: InstanceId, presence: Presence) => void;
  onRemove: (id: InstanceId) => void;
  /** 按一条状态历史撤销影响（顺序 27d）。 */
  onRevertChange: (id: InstanceId, changeId: string) => void;
}

const PRESENCE_OPTIONS: Array<{ value: Presence; label: string; note: string }> = [
  { value: 'onstage', label: '在场', note: '会说话，也会记得发生的事' },
  { value: 'muted', label: '沉默', note: '在场但不发言，仍然记得' },
  { value: 'offscreen', label: '在幕后', note: '不在这个场景，但时间仍在流逝' },
  { value: 'absent', label: '已离场', note: '暂时不参与这条世界线' },
];

function signed(value: number): string {
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(2)}`;
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
  onRemove,
  onRevertChange,
}: Props) {
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
      onRename(instance.id, next);
    },
  });

  return (
    <div className="modal-backdrop">
      <button type="button" className="modal-scrim" aria-label="关闭角色详情" onClick={onClose} />
      <section className="modal" role="dialog" aria-label="角色详情">
        <header className="modal-head">
          <Avatar name={instance.displayName} size={40} />
          <input className="conversation-name" disabled={disabled} aria-label="显示名" {...nameField.bind} />
          <div className="topbar-spacer" />
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="modal-body">
          <section className="panel">
            <h2>在场状态</h2>
            <select
              value={instance.presence}
              disabled={disabled}
              onChange={(event) => onSetPresence(instance.id, event.target.value as Presence)}
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
            <p className="hint">
              情绪：{signed(instance.affect.valence)} / 激动 {instance.affect.arousal.toFixed(2)}
            </p>
            {towardPlayer ? (
              <p className="hint">
                对玩家：信任 {signed(towardPlayer.trust)}、好感 {signed(towardPlayer.affinity)}、畏惧{' '}
                {signed(towardPlayer.fear)}、敬重 {signed(towardPlayer.respect)}、紧张 {signed(towardPlayer.tension)}
              </p>
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
                          disabled={disabled}
                          title="追加一条反向记录，不改原记录"
                          onClick={() => onRevertChange(instance.id, change.id)}
                        >
                          撤销这条影响
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
                {card.scenario.trim() !== '' ? <p className="hint">场景：{card.scenario}</p> : null}
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
            disabled={disabled}
            title="把这个角色移出这个世界（角色卡会保留）"
            onClick={() => {
              if (window.confirm(`把「${instance.displayName}」移出这个世界？`)) onRemove(instance.id);
            }}
          >
            移出这个世界
          </button>
        </div>
      </section>
    </div>
  );
}
