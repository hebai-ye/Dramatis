import type { Card, CardId, Persona, WorldBook, WorldBookId } from '@dramatis/core';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LibraryImportResult } from '../hooks/useImport';
import { createLazyModule } from '../lib/lazy-module';
import {
  countAttachedIds,
  filterCards,
  filterPersonas,
  filterWorldBooks,
  type LibrarySort,
} from '../lib/library-query';
import { serializeLibraryItem } from '../lib/library-transfer';
import { LIBRARY_VIEWS, type LibraryView, useLibraryView } from '../lib/library-view';
import { NARROW_SCREEN_QUERY } from '../lib/viewport';
import cardsModule from './CardDesigner?lazy-module-url';
import { LazyPanel } from './LazyPanel';
import personasModule from './PersonaLibrary?lazy-module-url';
import booksModule from './WorldDesigner?lazy-module-url';

const loadPersonas = createLazyModule(
  personasModule,
  (module: typeof import('./PersonaLibrary')) => module.PersonaLibrary,
);
const loadCards = createLazyModule(cardsModule, (module: typeof import('./CardDesigner')) => module.CardDesigner);
const loadBooks = createLazyModule(booksModule, (module: typeof import('./WorldDesigner')) => module.WorldDesigner);

export interface LibrarySurfaceProps {
  personas: Persona[];
  cards: Card[];
  books: WorldBook[];
  counts: Record<LibraryView, number>;
  ready: boolean;
  mutationDisabled: boolean;
  world: { id: string; title: string; attachedIds: WorldBookId[] } | null;
  onSavePersona: (item: Persona) => Promise<void>;
  onDeletePersona: (id: string) => Promise<void>;
  onSaveCard: (item: Card) => Promise<void>;
  onDeleteCard: (id: CardId) => Promise<void>;
  onSaveBook: (item: WorldBook) => Promise<void>;
  onDeleteBook: (id: WorldBookId) => Promise<void>;
  onAttach: (item: WorldBook) => Promise<void>;
  onDetach: (id: WorldBookId) => Promise<void>;
  onImport: (file: File) => Promise<LibraryImportResult>;
}

type Material = Persona | Card | WorldBook;
function saveFile(view: LibraryView, item: Material) {
  const url = URL.createObjectURL(new Blob([serializeLibraryItem(view, item)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 文件名必须剔除所有控制字符
  link.download = `${item.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || '素材'}.dramatis.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Only visited libraries mount, while each visited editor retains its draft and query. */
export function LibrarySurface(props: LibrarySurfaceProps) {
  const library = useLibraryView();
  const visited = useRef(new Set<LibraryView>());
  if (library.activeView !== null) visited.current.add(library.activeView);
  return (
    <div className="library-content">
      {LIBRARY_VIEWS.filter((view) => visited.current.has(view.id)).map((view) => (
        <LibraryBrowser key={view.id} view={view.id} active={library.activeView === view.id} {...props} />
      ))}
    </div>
  );
}

function LibraryBrowser({ view, active, ...props }: LibrarySurfaceProps & { view: LibraryView; active: boolean }) {
  const library = useLibraryView();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<LibrarySort>('name');
  const [attachedOnly, setAttachedOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const browserRef = useRef<HTMLElement>(null);
  const listTitleRef = useRef<HTMLHeadingElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const previousDetail = useRef(mobileDetail);
  const latest = useRef(props);
  latest.current = props;
  const all: Material[] = view === 'personas' ? props.personas : view === 'cards' ? props.cards : props.books;
  const previousItems = useRef(all);
  const attached = new Set(props.world?.attachedIds ?? []);
  const filtered =
    view === 'personas'
      ? filterPersonas(props.personas, query, sort)
      : view === 'cards'
        ? filterCards(props.cards, query, sort)
        : filterWorldBooks(props.books, query, sort);
  const results =
    attachedOnly && view === 'worldbooks' ? filtered.filter((item) => attached.has(item.id as WorldBookId)) : filtered;
  const selected = all.find((item) => item.id === selectedId) ?? null;
  const writeDisabled = props.mutationDisabled || fileBusy || library.busy;
  useLayoutEffect(() => {
    const changed = previousDetail.current !== mobileDetail;
    previousDetail.current = mobileDetail;
    const browser = browserRef.current;
    if (
      !changed ||
      !active ||
      !window.matchMedia(NARROW_SCREEN_QUERY).matches ||
      browser === null ||
      browser.closest('[inert], .app.rail-open') !== null
    )
      return;
    if (mobileDetail) backRef.current?.focus();
    else (browser.querySelector<HTMLElement>('.library-item.active') ?? listTitleRef.current)?.focus();
  }, [active, mobileDetail]);
  useEffect(() => {
    const before = previousItems.current;
    previousItems.current = all;
    if (selectedId === null || all.some((item) => item.id === selectedId)) return;
    const index = before.findIndex((item) => item.id === selectedId);
    if (index >= 0) setSelectedId(all[Math.min(index, all.length - 1)]?.id ?? null);
  }, [all, selectedId]);
  const changeSelection = (id: string | null) => {
    if (id !== null) {
      setSelectedId(id);
      setMobileDetail(true);
      return;
    }
    // Deleted IDs are repaired once by the array-change effect. A late delete
    // completion must not delete the newly selected neighbour a second time.
  };
  const importFile = (file: File) => {
    void library.requestAction(async () => {
      setFileBusy(true);
      setFileNotice(null);
      try {
        const result = await latest.current.onImport(file);
        if (!result.ok) throw new Error(result.error);
        if (result.kind === view) {
          setSelectedId(result.id);
          setMobileDetail(true);
        }
        setFileNotice(`已导入${LIBRARY_VIEWS.find((item) => item.id === result.kind)?.label}，仅保存在素材库。`);
      } finally {
        setFileBusy(false);
      }
    });
  };
  const exportItem = () => {
    void library.requestAction(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const current = latest.current;
      const items: Material[] =
        view === 'personas' ? current.personas : view === 'cards' ? current.cards : current.books;
      const item = items.find((material) => material.id === selectedId);
      if (item) saveFile(view, item);
    });
  };
  const common = { selectedId, onSelectionChange: changeSelection, hideSelector: true, disabled: writeDisabled };
  return (
    <section
      ref={browserRef}
      className={`library-browser${mobileDetail ? ' showing-detail' : ''}`}
      hidden={!active}
      aria-label={`${LIBRARY_VIEWS.find((item) => item.id === view)?.label}内容`}
    >
      <div className="library-toolbar">
        <label className="library-search">
          搜索素材
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="名称或内容"
          />
        </label>
        <label>
          排序
          <select value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)}>
            <option value="name">名称</option>
            <option value="updated">最近修改</option>
          </select>
        </label>
        <button type="button" className="ghost" disabled={writeDisabled} onClick={() => fileRef.current?.click()}>
          导入素材
        </button>
        <button
          type="button"
          className="ghost"
          disabled={selected === null || fileBusy || library.busy}
          onClick={exportItem}
        >
          导出选中素材
        </button>
        <input
          ref={fileRef}
          type="file"
          className="hidden-file"
          accept=".json,.png,application/json,image/png"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) importFile(file);
          }}
        />
      </div>
      {fileNotice ? (
        <p role="status" className="notice">
          {fileNotice}
        </p>
      ) : null}
      {view === 'worldbooks' ? (
        <div className="library-world-summary">
          <div className="inline">
            <button
              type="button"
              className={!attachedOnly ? 'ghost active' : 'ghost'}
              aria-pressed={!attachedOnly}
              onClick={() => setAttachedOnly(false)}
            >
              全部 {props.books.length}
            </button>
            <button
              type="button"
              className={attachedOnly ? 'ghost active' : 'ghost'}
              aria-pressed={attachedOnly}
              onClick={() => setAttachedOnly(true)}
            >
              本世界已挂载 {countAttachedIds(props.world?.attachedIds ?? [], props.books)}
            </button>
          </div>
          <p className="hint">
            {props.world === null ? '请先选择世界，再挂载或解绑世界书。' : `挂载目标：${props.world.title}`}
          </p>
        </div>
      ) : null}
      <p className="hint library-result-count">
        找到 {results.length} / 共 {all.length}
        {selected !== null && !results.some((item) => item.id === selectedId) ? ' · 当前编辑项不在筛选结果中' : ''}
      </p>
      <div className="library-columns">
        <section className="library-list" aria-label="素材列表">
          <h2 ref={listTitleRef} className="library-list-title" tabIndex={-1}>
            素材列表
          </h2>
          {all.length === 0 ? (
            <div className="library-empty">
              <strong>素材库为空</strong>
              <p className="hint">可以导入素材，或在右侧新建。</p>
            </div>
          ) : results.length === 0 ? (
            <div className="library-empty">
              <strong>没有匹配的素材</strong>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setQuery('');
                  setAttachedOnly(false);
                }}
              >
                清除筛选
              </button>
            </div>
          ) : (
            results.map((item) => (
              <button
                type="button"
                key={item.id}
                className={item.id === selectedId ? 'library-item active' : 'library-item'}
                aria-pressed={item.id === selectedId}
                onClick={() => void library.requestAction(() => changeSelection(item.id))}
              >
                <strong>{item.name || '未命名'}</strong>
                <span className="hint">
                  {'entries' in item
                    ? `${item.entries.length} 条词条${attached.has(item.id) ? ' · 已挂载' : ''}`
                    : view === 'cards'
                      ? (item as Card).nickname || (item as Card).creator || '角色卡'
                      : item.description.slice(0, 60) || '玩家身份'}
                </span>
              </button>
            ))
          )}
          <button type="button" className="ghost library-mobile-create" onClick={() => setMobileDetail(true)}>
            前往编辑区 / 新建
          </button>
        </section>
        <div className="library-detail">
          <button
            ref={backRef}
            type="button"
            className="ghost library-mobile-back"
            onClick={() => setMobileDetail(false)}
          >
            返回素材列表
          </button>
          {selected === null ? (
            <p className="hint">请选择一项素材，或新建素材。</p>
          ) : (
            <h2 className="library-detail-title">
              {selected.name}
              {view === 'worldbooks' && attached.has(selected.id as WorldBookId) ? (
                <span className="tag">本世界已挂载</span>
              ) : null}
            </h2>
          )}
          {view === 'personas' ? (
            <LazyPanel
              load={loadPersonas}
              label="身份编辑器"
              panelProps={{
                ...common,
                personas: props.personas,
                onSave: props.onSavePersona,
                onDelete: props.onDeletePersona,
              }}
            />
          ) : view === 'cards' ? (
            <LazyPanel
              load={loadCards}
              label="角色卡编辑器"
              panelProps={{ ...common, cards: props.cards, onSave: props.onSaveCard, onDelete: props.onDeleteCard }}
            />
          ) : (
            <LazyPanel
              load={loadBooks}
              label="世界书编辑器"
              panelProps={{
                ...common,
                books: props.books,
                attachedIds: props.world?.attachedIds ?? [],
                canAttach: props.world !== null,
                onSave: props.onSaveBook,
                onDelete: props.onDeleteBook,
                onAttach: props.onAttach,
                onDetach: props.onDetach,
              }}
            />
          )}
        </div>
      </div>
    </section>
  );
}
