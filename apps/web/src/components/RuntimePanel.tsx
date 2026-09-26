import type {
  AssembledPrompt,
  BudgetLimits,
  BudgetState,
  Card,
  ChapterSummary,
  CharacterInstance,
  Conversation,
  ConversationId,
  EventId,
  InstanceId,
  MemoryEvent,
  Persona,
  Presence,
  Scene,
  UsageSummary,
  WorldBook,
  WorldBookId,
} from '@dramatis/core';
import { memo, useEffect, useRef, useState } from 'react';
import { countRender } from '../lib/render-count';
import { CastPanel } from './CastPanel';
import { MemoryPanel } from './MemoryPanel';
import { PromptInspector } from './PromptInspector';
import { ScenePanel } from './ScenePanel';
import { UsagePanel } from './UsagePanel';

type Tab = 'scene' | 'memory' | 'usage' | 'prompt';

interface Props {
  open: boolean;
  focusOnOpen: boolean;
  onClose: () => void;
  scene: Scene | null;
  instances: CharacterInstance[];
  memories: MemoryEvent[];
  /** 这个世界的对话：记忆面板的对话维度要用（T11）。 */
  conversations: Conversation[];
  activeConversationId: ConversationId | null;
  personas: Persona[];
  personaId: string | null;
  playerName: string;
  /** 已滚成章节的前情（P1-5）。 */
  chapters: ChapterSummary[];
  attachedWorldBooks: WorldBook[];
  /** 全素材库，场景面板用它加入新角色。 */
  libraryCards: Card[];
  /** 当前世界的角色卡，记忆面板用它显示附件。 */
  worldCards: Card[];
  prompt: AssembledPrompt | null;
  pending: number;
  /** 生成之外的调用次数（意图判断 + 后台分析），来自落盘的账单。 */
  extraCalls: number;
  /** 账单：整个世界与当前对话各一份。 */
  usage: { world: UsageSummary | null; conversation: UsageSummary | null };
  /** 本局的调用预算与熔断状态（P1-9）。 */
  budget: BudgetState;
  /** 已经保存的上限（草稿初值）。 */
  budgetLimits: BudgetLimits | null;
  onSaveBudget: (limits: BudgetLimits | null) => void;
  /** 当前对话名，给用量面板做标题。 */
  conversationTitle: string;
  workerError: string | null;
  failedTasks?: number;
  onRetryFailed?: () => void;
  disabled: boolean;
  onSceneChange: (patch: Partial<Scene>) => void;
  onStartNewScene: (title: string) => void;
  onSetPresence: (id: InstanceId, presence: Presence) => void;
  onSelectPersona: (persona: Persona) => void;
  onRenameInstance: (id: InstanceId, name: string) => void;
  onRemoveInstance: (id: InstanceId) => void;
  onAddInstance: (card: Card) => void;
  onDetachWorldBook: (id: WorldBookId) => void;
  onUpdateMemory: (id: EventId, patch: Partial<MemoryEvent>) => void;
  onDeleteMemory: (id: EventId) => void;
  /** 跳回这条记忆产生的原句所在的对话（T11）。 */
  onLocateMemory: (turnId: string) => void;
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'scene', label: '场景与阵容' },
  { id: 'memory', label: '记忆' },
  { id: 'usage', label: '用量' },
  { id: 'prompt', label: 'Prompt' },
];

/**
 * 运行时面板。
 *
 * 装的是「正在发生什么」：谁在场、发生了什么事、这一轮实际发了什么给模型。
 * 与侧边栏的「这个东西是什么」严格分开——这条界线是这次改版的核心。
 */
function RuntimePanelImpl(props: Props) {
  countRender('RuntimePanel');
  const [tab, setTab] = useState<Tab>('scene');
  const firstTabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!props.open || !props.focusOnOpen) return;
    const previousFocus = document.activeElement;
    firstTabRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [props.open, props.focusOnOpen]);

  const available = props.libraryCards.filter(
    (card) => !props.instances.some((instance) => instance.cardId === card.id),
  );

  return (
    <aside
      className="sidebar runtime-panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && props.open && props.focusOnOpen) {
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      <nav className="design-tabs" aria-label="运行时内容">
        {TABS.map((item) => (
          <button
            key={item.id}
            ref={item.id === 'scene' ? firstTabRef : undefined}
            type="button"
            className={item.id === tab ? 'tab active' : 'tab'}
            aria-pressed={item.id === tab}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.id === 'memory' && props.memories.length > 0 ? ` ${props.memories.length}` : ''}
          </button>
        ))}
      </nav>

      {tab === 'scene' ? (
        <>
          <section className="panel">
            <h2>我的身份</h2>
            <select
              value={props.personaId ?? ''}
              disabled={props.disabled}
              aria-label="这条对话使用的身份"
              onChange={(event) => {
                const persona = props.personas.find((item) => item.id === event.target.value);
                if (persona) props.onSelectPersona(persona);
              }}
            >
              <option value="">{props.playerName || '未选择身份'}</option>
              {props.personas.map((persona) => (
                <option key={persona.id} value={persona.id}>
                  {persona.name}
                </option>
              ))}
            </select>
            <p className="hint">只影响当前对话怎么称呼你；切换对话后可以选另一个身份。</p>
          </section>

          {props.scene ? (
            <ScenePanel
              scene={props.scene}
              disabled={props.disabled}
              onChange={props.onSceneChange}
              onStartNewScene={props.onStartNewScene}
            />
          ) : null}

          {props.scene ? (
            <CastPanel
              instances={props.instances}
              scene={props.scene}
              disabled={props.disabled}
              onSetPresence={props.onSetPresence}
              onRename={props.onRenameInstance}
              onRemove={props.onRemoveInstance}
            />
          ) : null}

          {available.length > 0 ? (
            <section className="panel">
              <h2>从素材库加入</h2>
              <ul className="room-list">
                {available.map((card) => (
                  <li key={card.id}>
                    <span className="room-title">{card.name}</span>
                    <button
                      type="button"
                      className="ghost"
                      disabled={props.disabled || props.scene === null}
                      onClick={() => props.onAddInstance(card)}
                    >
                      加入场景
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="panel">
            <h2>世界设定</h2>
            {props.attachedWorldBooks.length === 0 ? (
              <p className="hint">当前世界没有挂载世界书。可以在左侧「世界书」里新建或挂载。</p>
            ) : (
              <ul className="room-list">
                {props.attachedWorldBooks.map((book) => (
                  <li key={book.id}>
                    <span className="room-title">{book.name || '未命名世界书'}</span>
                    <span className="hint">{book.entries.length} 条</span>
                    <button
                      type="button"
                      className="ghost danger"
                      disabled={props.disabled}
                      title="解绑，不会删除世界书本身"
                      onClick={() => props.onDetachWorldBook(book.id)}
                    >
                      解绑
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="hint">关键词命中时才会插入 prompt；常驻条目每轮都在。</p>
          </section>
        </>
      ) : null}

      {tab === 'memory' ? (
        <MemoryPanel
          memories={props.memories}
          chapters={props.chapters}
          cards={props.worldCards}
          instances={props.instances}
          conversations={props.conversations}
          activeConversationId={props.activeConversationId}
          pending={props.pending}
          extraCalls={props.extraCalls}
          workerError={props.workerError}
          {...(props.failedTasks === undefined ? {} : { failedTasks: props.failedTasks })}
          {...(props.onRetryFailed === undefined ? {} : { onRetryFailed: props.onRetryFailed })}
          disabled={props.disabled}
          onUpdate={props.onUpdateMemory}
          onDelete={props.onDeleteMemory}
          onLocate={props.onLocateMemory}
        />
      ) : null}

      {tab === 'usage' ? (
        <UsagePanel
          world={props.usage.world}
          conversation={props.usage.conversation}
          conversationTitle={props.conversationTitle}
          budget={props.budget}
          limits={props.budgetLimits}
          onSaveBudget={props.onSaveBudget}
        />
      ) : null}

      {tab === 'prompt' ? <PromptInspector prompt={props.prompt} /> : null}
    </aside>
  );
}

/**
 * memo（顺序 59）。App 传给它的回调目前还是内联的，所以 App 因数据变化重渲染时它也会跟着；
 * 真正的收益在流式与打字那两条路上——它们已经不再经过 App。回调稳定化留给顺序 66 拆 App 时一起做。
 */
export const RuntimePanel = memo(RuntimePanelImpl);
