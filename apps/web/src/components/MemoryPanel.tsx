import type { CharacterInstance, EventId, MemoryEvent } from '@dramatis/core';
import { useMemo, useState } from 'react';

interface Props {
  memories: MemoryEvent[];
  instances: CharacterInstance[];
  pending: number;
  /** 本次会话完成的后台调用次数，用来观察真实开销。 */
  completed: number;
  /** 后台任务的真实 token 合计（服务商没返回时是 0）。 */
  usage: { promptTokens: number; completionTokens: number };
  workerError: string | null;
  disabled: boolean;
  onUpdate: (id: EventId, patch: Partial<MemoryEvent>) => void;
  onDelete: (id: EventId) => void;
}

type Filter = 'all' | 'objective' | string;

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * 记忆面板（ROADMAP P1-4）。
 *
 * 这是本项目相对 SillyTavern 最直观的差异：角色记错了，你能直接改，
 * 而不是重开一局。所以每条记忆都必须可见、可改、可删、可置顶。
 */
export function MemoryPanel({
  memories,
  instances,
  pending,
  completed,
  usage,
  workerError,
  disabled,
  onUpdate,
  onDelete,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const instance of instances) map.set(instance.id, instance.displayName);
    return map;
  }, [instances]);

  const filtered = useMemo(() => {
    if (filter === 'all') return memories;
    if (filter === 'objective') return memories.filter((memory) => memory.observerId === null);
    return memories.filter((memory) => memory.observerId === filter);
  }, [filter, memories]);

  return (
    <section className="panel">
      <header className="memory-header">
        <h2>记忆</h2>
        <span className="hint">
          {memories.length} 条{pending > 0 ? ` · 排队 ${pending}` : ''}
          {completed > 0 ? ` · 后台调用 ${completed} 次` : ''}
          {usage.promptTokens + usage.completionTokens > 0
            ? ` · ${String(usage.promptTokens + usage.completionTokens)} token`
            : ''}
        </span>
      </header>

      {workerError !== null ? (
        <div className="notice error">
          <strong>记忆抽取失败</strong>
          <p>{workerError}</p>
          <p className="hint">失败的批次会自动重试，超过上限后停在失败状态。</p>
        </div>
      ) : null}

      <label>
        筛选
        <select value={filter} disabled={disabled} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">全部</option>
          <option value="objective">客观经过</option>
          {instances.map((instance) => (
            <option key={instance.id} value={instance.id}>
              {instance.displayName} 眼中的事
            </option>
          ))}
        </select>
      </label>

      {filtered.length === 0 ? (
        <p className="hint">
          {memories.length === 0
            ? '还没有记忆。聊过一轮之后，后台会自动抽取；需要配置好模型与 Key。'
            : '这个筛选下没有条目。'}
        </p>
      ) : (
        <ul className="memory-list">
          {filtered.map((memory) => {
            const expanded = expandedId === memory.id;
            const owner =
              memory.observerId === null ? '客观经过' : `${nameOf.get(memory.observerId) ?? '未知角色'} 眼中的事`;

            return (
              <li key={memory.id} className={memory.pinned ? 'pinned' : ''}>
                <div className="memory-head">
                  <span className="tag">{owner}</span>
                  <span className="hint">{formatTime(memory.createdAt)}</span>
                  {memory.pinned ? <span className="tag accent">置顶</span> : null}
                </div>

                <p className="memory-summary">{memory.summary}</p>
                {memory.perception !== '' ? <p className="memory-perception">他的感受：{memory.perception}</p> : null}

                <div className="memory-actions">
                  <button
                    type="button"
                    className="ghost"
                    disabled={disabled}
                    onClick={() => setExpandedId(expanded ? null : memory.id)}
                  >
                    {expanded ? '收起' : '编辑'}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={disabled}
                    onClick={() => onUpdate(memory.id, { pinned: !memory.pinned })}
                  >
                    {memory.pinned ? '取消置顶' : '置顶'}
                  </button>
                  <button
                    type="button"
                    className="ghost danger"
                    disabled={disabled}
                    onClick={() => onDelete(memory.id)}
                  >
                    删除
                  </button>
                  <span className="hint">重要度 {memory.importance.toFixed(2)}</span>
                  {memory.recallCount > 0 ? <span className="hint">回想 {memory.recallCount} 次</span> : null}
                </div>

                {expanded ? (
                  <div className="memory-editor">
                    <label>
                      客观经过
                      <textarea
                        rows={2}
                        value={memory.summary}
                        disabled={disabled}
                        onChange={(event) => onUpdate(memory.id, { summary: event.target.value })}
                      />
                    </label>
                    {memory.observerId !== null ? (
                      <label>
                        这个角色的感受
                        <textarea
                          rows={2}
                          value={memory.perception}
                          disabled={disabled}
                          onChange={(event) => onUpdate(memory.id, { perception: event.target.value })}
                        />
                      </label>
                    ) : null}
                    <label>
                      重要度（改了之后不再自动衰减）
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        value={memory.importance}
                        disabled={disabled}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (!Number.isFinite(value)) return;
                          onUpdate(memory.id, {
                            importance: Math.max(0, Math.min(1, value)),
                            importanceLocked: true,
                          });
                        }}
                      />
                    </label>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
