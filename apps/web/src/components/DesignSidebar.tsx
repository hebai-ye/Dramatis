import type { Card, CardId, Persona, WorldBook, WorldBookId } from '@dramatis/core';
import { useRef, useState } from 'react';
import type { ProvidersApi } from '../lib/providers';
import { CardDesigner } from './CardDesigner';
import { PersonaLibrary } from './PersonaLibrary';
import { ProviderPanel } from './ProviderPanel';
import { WorldDesigner } from './WorldDesigner';

type Section = 'cards' | 'world' | 'personas' | 'models';

interface Props {
  cards: Card[];
  worldBooks: WorldBook[];
  attachedWorldBookIds: string[];
  personas: Persona[];
  activePersonaId: string | null;
  providers: ProvidersApi;
  disabled: boolean;
  onSaveCard: (card: Card) => void;
  onDeleteCard: (id: CardId) => void;
  onSaveWorldBook: (book: WorldBook) => void;
  onDeleteWorldBook: (id: WorldBookId) => void;
  onAttachWorldBook: (book: WorldBook) => void;
  onSelectPersona: (persona: Persona) => void;
  onSavePersona: (persona: Persona) => void;
  onDeletePersona: (id: string) => void;
  /** 导入角色卡或世界书（按 JSON 结构自动分辨）。 */
  onImportFile: (file: File) => void;
  /** 导入提示与错误，显示在侧边栏顶部。 */
  notice: { warnings: string[]; error: string | null };
}

const SECTIONS: Array<{ id: Section; label: string; hint: string }> = [
  { id: 'cards', label: '角色卡', hint: '写角色的模板' },
  { id: 'world', label: '世界书', hint: '补世界的设定' },
  { id: 'personas', label: '玩家身份', hint: '你是谁' },
  { id: 'models', label: '模型接入', hint: '接口与 Key' },
];

/**
 * 设定侧边栏。
 *
 * 只放与对话无关的东西：写卡、补设定、身份、模型接入。对话相关的一切
 * （阵容、场景、记忆、prompt）都在主区，因为它们回答的是「正在发生什么」，
 * 而侧边栏回答的是「这个东西是什么」。两者混在一起时，用户每次想改设定
 * 都要在一堆运行时状态里找入口。
 */
export function DesignSidebar(props: Props) {
  const [section, setSection] = useState<Section>('cards');
  const [expanded, setExpanded] = useState(true);
  const current = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0];
  const fileRef = useRef<HTMLInputElement | null>(null);

  if (!expanded) {
    return (
      <aside className="sidebar design-sidebar collapsed">
        <button type="button" className="ghost" title="展开设定面板" onClick={() => setExpanded(true)}>
          ≫
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar design-sidebar">
      <header className="brand">
        <div>
          <h1>设定</h1>
          <span>{current?.hint}</span>
        </div>
        <div className="inline">
          <button type="button" className="ghost" disabled={props.disabled} onClick={() => fileRef.current?.click()}>
            导入
          </button>
          <button
            type="button"
            className="ghost"
            title="折叠设定面板，把空间留给对话"
            onClick={() => setExpanded(false)}
          >
            ≪
          </button>
        </div>
      </header>

      <input
        ref={fileRef}
        type="file"
        accept=".json,.png,application/json,image/png"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) props.onImportFile(file);
          event.target.value = '';
        }}
      />

      {props.notice.error !== null ? (
        <div className="notice error">
          <strong>出错了</strong>
          <p>{props.notice.error}</p>
        </div>
      ) : null}

      {props.notice.warnings.length > 0 ? (
        <div className="notice warn">
          <strong>导入提示</strong>
          <ul>
            {props.notice.warnings.map((message, index) => (
              <li key={`${String(index)}-${message.slice(0, 12)}`}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <nav className="design-tabs">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === section ? 'tab active' : 'tab'}
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <section className="panel">
        {section === 'cards' ? (
          <CardDesigner
            cards={props.cards}
            disabled={props.disabled}
            onSave={props.onSaveCard}
            onDelete={props.onDeleteCard}
          />
        ) : null}

        {section === 'world' ? (
          <WorldDesigner
            books={props.worldBooks}
            attachedIds={props.attachedWorldBookIds}
            disabled={props.disabled}
            onSave={props.onSaveWorldBook}
            onDelete={props.onDeleteWorldBook}
            onAttach={props.onAttachWorldBook}
          />
        ) : null}

        {section === 'personas' ? (
          <PersonaLibrary
            personas={props.personas}
            activeId={props.activePersonaId}
            disabled={props.disabled}
            onSelect={props.onSelectPersona}
            onSave={props.onSavePersona}
            onDelete={props.onDeletePersona}
          />
        ) : null}

        {section === 'models' ? <ProviderPanel api={props.providers} disabled={props.disabled} /> : null}
      </section>
    </aside>
  );
}
