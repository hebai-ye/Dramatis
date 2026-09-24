import type {
  Card,
  ChapterSummary,
  CharacterInstance,
  Conversation,
  ConversationId,
  EventId,
  MemoryEvent,
} from '@dramatis/core';
import {
  ALL,
  countByConversation,
  filterMemories,
  groupMemoriesByTurn,
  isImpressionMemory,
  OBJECTIVE,
  readAttachment,
  renderAttachment,
  resolveMemorySources,
} from '@dramatis/core';
import { useEffect, useMemo, useState } from 'react';
import { useDraftField } from '../lib/useDraftField';

/**
 * 记忆正文的编辑框（客观经过 / 角色感受）。
 *
 * 抽成组件是因为草稿 hook 必须在组件顶层调用，而这些输入框在 `memories.map(...)` 里。
 * 以前它们每敲一个字就 `onUpdate` 写一次库（顺序 63 统一成防抖 + 失焦提交）。
 */
function MemoryDraftArea({
  value,
  disabled,
  label,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  label: string;
  onCommit: (next: string) => void;
}) {
  const field = useDraftField({ value, commit: onCommit });
  return <textarea rows={2} disabled={disabled} aria-label={label} {...field.bind} />;
}

interface Props {
  memories: MemoryEvent[];
  instances: CharacterInstance[];
  /**
   * 这个世界的对话，用来给记忆面板加**对话维度**（T11）。
   *
   * 记忆是世界的，对话是多条的：不过滤的话，三条线的记忆混在一起，
   * 用户看不出「这条是哪条线里的」。
   */
  conversations: Conversation[];
  activeConversationId: ConversationId | null;
  pending: number;
  /**
   * 生成之外的调用次数（意图判断 + 后台分析），来自落盘的账单。
   *
   * 以前这里记的是「本次会话」的次数，刷新就归零；长跑中途重载两次就把全程
   * 账单冲没了（T7）。现在读的是流水，跨刷新、跨重启都对得上。
   */
  extraCalls: number;
  /**
   * 已经滚成章节的前情（P1-5）。
   */
  chapters: ChapterSummary[];
  /** 当前世界里的角色卡；附件预览从它们的 extensions 读取。 */
  cards: Card[];
  workerError: string | null;
  disabled: boolean;
  onUpdate: (id: EventId, patch: Partial<MemoryEvent>) => void;
  onDelete: (id: EventId) => void;
  /** 跳回这条记忆产生的原句所在的对话（T11 的「点回当时的对话」）。 */
  onLocate?: (turnId: string) => void;
}

type View = 'list' | 'contrast';

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
  conversations,
  activeConversationId,
  pending,
  extraCalls,
  chapters,
  cards,
  workerError,
  disabled,
  onUpdate,
  onDelete,
  onLocate,
}: Props) {
  /**
   * 两个筛选维度：**哪条对话** × **谁的视角**。
   *
   * 对话维度默认停在当前打开的那条线——用户在看主线时想知道的多半是「这条线里
   * 发生了什么」；要横向看整个世界就切到「全部对话」，那时每条记忆会带上归属标签。
   */
  const [conversationFilter, setConversationFilter] = useState<string>(activeConversationId ?? ALL);
  const [observerFilter, setObserverFilter] = useState<string>(ALL);
  const [view, setView] = useState<View>('list');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // 换对话时筛选跟着走，否则会停在另一条线上而看起来像「记忆没了」
  useEffect(() => {
    setConversationFilter(activeConversationId ?? ALL);
  }, [activeConversationId]);

  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const instance of instances) map.set(instance.id, instance.displayName);
    return map;
  }, [instances]);

  /**
   * 对话标题。副对话没有剧情记忆，但仍然列出来——列出来才知道「这里一条都没有」
   * 是因为管理员不做剧情，而不是因为数据丢了。
   */
  const titleOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const conversation of conversations) {
      map.set(conversation.id, conversation.kind === 'side' ? `⚙ ${conversation.title}` : conversation.title);
    }
    return map;
  }, [conversations]);

  const counts = useMemo(() => countByConversation(memories), [memories]);

  const filtered = useMemo(
    () =>
      filterMemories(memories, {
        conversationId: conversationFilter === ALL ? ALL : (conversationFilter as ConversationId),
        observerId: observerFilter === ALL || observerFilter === OBJECTIVE ? observerFilter : observerFilter,
      }),
    [conversationFilter, memories, observerFilter],
  );

  const groups = useMemo(() => (view === 'contrast' ? groupMemoriesByTurn(filtered) : []), [filtered, view]);
  const attachments = useMemo(
    () =>
      cards.flatMap((card) => {
        const attachment = readAttachment(card);
        return attachment === null ? [] : [{ card, attachment }];
      }),
    [cards],
  );

  const renderSourceChain = (memory: MemoryEvent) => {
    if (!isImpressionMemory(memory)) return null;
    const chain = resolveMemorySources(memory, memories);
    return (
      <details className="memory-source-chain">
        <summary>
          来源原文：解析到 {chain.sources.length} / {memory.supersedes?.length ?? 0} 条
          {chain.missingIds.length === 0 ? '' : `（${chain.missingIds.length} 条当前不可见）`}
        </summary>
        {chain.sources.length === 0 ? (
          <p className="hint">来源原文当前不可见；可能已经随原对话归档，但印象本身仍在。</p>
        ) : (
          <ul>
            {chain.sources.map((source) => (
              <li key={source.id}>
                <p className="memory-summary">{source.summary}</p>
                {source.perception.trim() === '' ? null : (
                  <p className="memory-perception">当时的感受：{source.perception}</p>
                )}
                {onLocate === undefined || source.sourceTurnIds[0] === undefined ? null : (
                  <button
                    type="button"
                    className="ghost"
                    disabled={disabled}
                    onClick={() => onLocate(source.sourceTurnIds[0] as string)}
                  >
                    跳到原句
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </details>
    );
  };

  /** 这条记忆属于哪条线——「全部对话」时才显示，只看一条线时它是废话。 */
  const conversationTag = (memory: MemoryEvent): string | null => {
    if (conversationFilter !== ALL) return null;
    const key = memory.conversationId ?? '';
    if (key === '') return '未归属';
    return titleOf.get(key) ?? '已删除的对话';
  };

  return (
    <section className="panel">
      <header className="memory-header">
        <h2>记忆</h2>
        <span className="hint">
          {memories.length} 条{pending > 0 ? ` · 排队 ${pending}` : ''}
          {extraCalls > 0 ? ` · 额外调用 ${extraCalls} 次` : ''}
        </span>
      </header>

      {workerError !== null ? (
        <div className="notice error">
          <strong>记忆抽取失败</strong>
          <p>{workerError}</p>
          <p className="hint">失败的批次会自动重试，超过上限后停在失败状态。</p>
        </div>
      ) : null}

      {attachments.length > 0 ? (
        <section className="attachment-block">
          <h3>记忆附件</h3>
          <p className="hint">挂在角色卡上的跨对话索引。正文只在对话命中关键词或问起过去时按需展开。</p>
          {attachments.map(({ card, attachment }) => {
            const dropped = attachment.stats.dropped.timeline + attachment.stats.dropped.memories;
            return (
              <details key={card.id} className="attachment-preview">
                <summary>
                  {card.name} · 来自《{attachment.fromConversationTitle}》· {attachment.stats.impressions} 条印象 /{' '}
                  {attachment.stats.chapters} 章{dropped === 0 ? '' : ` · 已丢 ${dropped} 条`}
                </summary>
                <div className="attachment-preview-body">
                  <p className="hint">
                    构建于 {formatTime(attachment.builtAt)} · 索引 {attachment.stats.chars} 字
                  </p>
                  <pre>{renderAttachment(attachment)}</pre>
                </div>
              </details>
            );
          })}
        </section>
      ) : null}
      {/*
        两个筛选维度（T11）：**哪条对话** × **谁的视角**。分开的两个下拉比
        「一个长得像 `主线 × 秦娘` 的复合选项」更好用——用户想换的是其中一维。
      */}
      <div className="memory-filters">
        <label>
          对话
          <select
            value={conversationFilter}
            disabled={disabled}
            onChange={(event) => setConversationFilter(event.target.value)}
          >
            <option value={ALL}>全部对话（{memories.length}）</option>
            {conversations.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.kind === 'side' ? `⚙ ${conversation.title}` : conversation.title}（
                {counts.get(conversation.id) ?? 0}）
              </option>
            ))}
          </select>
        </label>

        <label>
          视角
          <select
            value={observerFilter}
            disabled={disabled}
            onChange={(event) => setObserverFilter(event.target.value)}
          >
            <option value={ALL}>全部</option>
            <option value={OBJECTIVE}>客观经过</option>
            {instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.displayName} 眼中的事
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="memory-view-toggle">
        <button
          type="button"
          className={view === 'list' ? 'ghost active' : 'ghost'}
          disabled={disabled}
          onClick={() => setView('list')}
        >
          逐条
        </button>
        <button
          type="button"
          className={view === 'contrast' ? 'ghost active' : 'ghost'}
          disabled={disabled}
          title="同一件事：客观经过与各角色的视角摆在一起"
          onClick={() => setView('contrast')}
        >
          对照
        </button>
      </div>

      {chapters.length === 0 ? null : (
        <section className="chapter-block">
          <h3>前情提要</h3>
          <p className="hint">几场戏滚成的一章。原文一条都没删，只是不再占着 prompt 的位置。</p>
          <ul className="chapter-list">
            {chapters.map((chapter) => (
              <li key={chapter.id}>
                <div className="memory-head">
                  <span className="tag accent">{chapter.title}</span>
                  <span className="hint">{formatTime(chapter.createdAt)}</span>
                </div>
                <p className="memory-summary">{chapter.summary}</p>
                {chapter.keyFacts.length === 0 ? null : (
                  <p className="memory-perception">要点：{chapter.keyFacts.join('；')}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {filtered.length === 0 ? (
        <p className="hint">
          {memories.length === 0
            ? '还没有记忆。聊过一轮之后，后台会自动抽取；需要配置好模型与 Key。'
            : conversationFilter !== ALL && (counts.get(conversationFilter) ?? 0) === 0
              ? '这条对话下还没有记忆——副对话只有起草，不会产生剧情记忆；要横向看整个世界，把「对话」切到全部。'
              : '这个筛选下没有条目。'}
        </p>
      ) : view === 'contrast' ? (
        /*
          对照视图（T11）：一次抽取产出的就是「1 条客观 + N 条视角」，
          它们本来就是同一件事的不同说法。平铺着看，这两种条目隔着几十条互相找不着；
          摆进一张卡里，「各人记成什么样」才一眼可辨。
        */
        <ul className="memory-list contrast">
          {groups.map((group) => (
            <li key={group.key}>
              <div className="memory-head">
                <span className="tag accent">同一轮</span>
                <span className="hint">{formatTime(group.at)}</span>
                {(() => {
                  const sample = group.objective ?? group.observations[0] ?? null;
                  const tag = sample === null ? null : conversationTag(sample);
                  return tag === null ? null : <span className="tag">{tag}</span>;
                })()}
                {group.turnId === null || onLocate === undefined ? null : (
                  <button type="button" className="ghost" onClick={() => onLocate(group.turnId as string)}>
                    跳到原句
                  </button>
                )}
              </div>

              {group.objective === null ? (
                <p className="hint">这一轮没有客观条目（抽取时只写了视角）。</p>
              ) : (
                <div className="contrast-row">
                  <span className="tag">客观经过</span>
                  <p className="memory-summary">{group.objective.summary}</p>
                </div>
              )}

              {group.observations.map((memory) => (
                <div className="contrast-row" key={memory.id}>
                  <span className="tag">
                    {memory.observerId === null ? '客观经过' : `${nameOf.get(memory.observerId) ?? '未知角色'} 眼中的`}
                  </span>
                  <div>
                    {memory.observerId !== null && memory.summary !== group.objective?.summary ? (
                      <p className="memory-summary">{memory.summary}</p>
                    ) : null}
                    {memory.perception === '' ? null : <p className="memory-perception">{memory.perception}</p>}
                  </div>
                </div>
              ))}

              <div className="memory-actions">
                {(group.objective === null ? [] : [group.objective, ...group.observations])
                  .slice(0, 6)
                  .map((memory) => (
                    <button
                      key={memory.id}
                      type="button"
                      className="ghost"
                      disabled={disabled}
                      title={memory.observerId === null ? '编辑客观经过' : '编辑这个角色的视角'}
                      onClick={() => {
                        setView('list');
                        setExpandedId(memory.id);
                      }}
                    >
                      改{memory.observerId === null ? '客观' : (nameOf.get(memory.observerId) ?? '视角')}
                    </button>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="memory-list">
          {filtered.map((memory) => (
            <li key={memory.id} className={memory.pinned ? 'pinned' : ''}>
              <div className="memory-head">
                <span className="tag">
                  {memory.observerId === null ? '客观经过' : `${nameOf.get(memory.observerId) ?? '未知角色'} 眼中的事`}
                </span>
                {conversationTag(memory) === null ? null : <span className="tag">{conversationTag(memory)}</span>}
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
                  onClick={() => setExpandedId(expandedId === memory.id ? null : memory.id)}
                >
                  {expandedId === memory.id ? '收起' : '编辑'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={disabled}
                  onClick={() => onUpdate(memory.id, { pinned: !memory.pinned })}
                >
                  {memory.pinned ? '取消置顶' : '置顶'}
                </button>
                <button type="button" className="ghost danger" disabled={disabled} onClick={() => onDelete(memory.id)}>
                  删除
                </button>
                {onLocate === undefined || memory.sourceTurnIds[0] === undefined ? null : (
                  <button
                    type="button"
                    className="ghost"
                    disabled={disabled}
                    title="切回产生这条记忆的那条对话，并跳到原句"
                    onClick={() => onLocate(memory.sourceTurnIds[0] as string)}
                  >
                    跳到原句
                  </button>
                )}
                <span className="hint">重要度 {memory.importance.toFixed(2)}</span>
                {memory.recallCount > 0 ? <span className="hint">回想 {memory.recallCount} 次</span> : null}
              </div>

              {renderSourceChain(memory)}

              {expandedId === memory.id ? (
                <div className="memory-editor">
                  <div className="field">
                    客观经过
                    <MemoryDraftArea
                      value={memory.summary}
                      disabled={disabled}
                      label="客观经过"
                      onCommit={(next) => onUpdate(memory.id, { summary: next })}
                    />
                  </div>
                  {memory.observerId !== null ? (
                    <div className="field">
                      这个角色的感受
                      <MemoryDraftArea
                        value={memory.perception}
                        disabled={disabled}
                        label="这个角色的感受"
                        onCommit={(next) => onUpdate(memory.id, { perception: next })}
                      />
                    </div>
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
                  <p className="hint">产生这条记忆的对话：{titleOf.get(memory.conversationId ?? '') ?? '未归属'}</p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
