import type {
  AssembledPrompt,
  Card,
  ChapterSummary,
  CharacterInstance,
  EventId,
  InstanceId,
  MemoryEvent,
  Presence,
  Scene,
  UsageSummary,
  WorldBook,
  WorldBookId,
} from '@dramatis/core';
import { useState } from 'react';
import { CastPanel } from './CastPanel';
import { MemoryPanel } from './MemoryPanel';
import { PromptInspector } from './PromptInspector';
import { ScenePanel } from './ScenePanel';
import { UsagePanel } from './UsagePanel';

type Tab = 'scene' | 'memory' | 'usage' | 'prompt';

interface Props {
  scene: Scene | null;
  instances: CharacterInstance[];
  memories: MemoryEvent[];
  /** 已滚成章节的前情（P1-5）。 */
  chapters: ChapterSummary[];
  attachedWorldBooks: WorldBook[];
  libraryCards: Card[];
  prompt: AssembledPrompt | null;
  pending: number;
  /** 生成之外的调用次数（意图判断 + 后台分析），来自落盘的账单。 */
  extraCalls: number;
  /** 账单：整个世界与当前对话各一份。 */
  usage: { world: UsageSummary | null; conversation: UsageSummary | null };
  /** 当前对话名，给用量面板做标题。 */
  conversationTitle: string;
  workerError: string | null;
  disabled: boolean;
  onSceneChange: (patch: Partial<Scene>) => void;
  onStartNewScene: (title: string) => void;
  onSetPresence: (id: InstanceId, presence: Presence) => void;
  onRenameInstance: (id: InstanceId, name: string) => void;
  onRemoveInstance: (id: InstanceId) => void;
  onAddInstance: (card: Card) => void;
  onDetachWorldBook: (id: WorldBookId) => void;
  onUpdateMemory: (id: EventId, patch: Partial<MemoryEvent>) => void;
  onDeleteMemory: (id: EventId) => void;
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
export function RuntimePanel(props: Props) {
  const [tab, setTab] = useState<Tab>('scene');

  const available = props.libraryCards.filter(
    (card) => !props.instances.some((instance) => instance.cardId === card.id),
  );

  return (
    <aside className="sidebar runtime-panel">
      <nav className="design-tabs">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === tab ? 'tab active' : 'tab'}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.id === 'memory' && props.memories.length > 0 ? ` ${props.memories.length}` : ''}
          </button>
        ))}
      </nav>

      {tab === 'scene' ? (
        <>
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
          instances={props.instances}
          pending={props.pending}
          extraCalls={props.extraCalls}
          workerError={props.workerError}
          disabled={props.disabled}
          onUpdate={props.onUpdateMemory}
          onDelete={props.onDeleteMemory}
        />
      ) : null}

      {tab === 'usage' ? (
        <UsagePanel
          world={props.usage.world}
          conversation={props.usage.conversation}
          conversationTitle={props.conversationTitle}
        />
      ) : null}

      {tab === 'prompt' ? <PromptInspector prompt={props.prompt} /> : null}
    </aside>
  );
}
