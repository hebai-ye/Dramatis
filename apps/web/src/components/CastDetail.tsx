import type { Card, CharacterInstance, InstanceId, MemoryEvent, Presence } from '@dramatis/core';
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
export function CastDetail({ instance, card, memories, disabled, onClose, onRename, onSetPresence, onRemove }: Props) {
  const own = memories.filter((memory) => memory.observerId === instance.id);
  const towardPlayer = instance.relationships.find((edge) => edge.target === 'player');

  return (
    <div className="modal-backdrop">
      <button type="button" className="modal-scrim" aria-label="关闭角色详情" onClick={onClose} />
      <section className="modal" role="dialog" aria-label="角色详情">
        <header className="modal-head">
          <Avatar name={instance.displayName} size={40} />
          <input
            className="conversation-name"
            value={instance.displayName}
            disabled={disabled}
            aria-label="显示名"
            onChange={(event) => onRename(instance.id, event.target.value)}
          />
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
            {instance.affect.history.length > 0 ? (
              <details>
                <summary>最近的状态变化</summary>
                <ul className="hint">
                  {instance.affect.history
                    .slice(-3)
                    .reverse()
                    .map((change, index) => (
                      <li key={`${change.turnId}-${String(index)}`}>
                        {change.reason || '未记录原因'}（情绪 {signed(change.deltaValence)} /{' '}
                        {signed(change.deltaArousal)}）
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
