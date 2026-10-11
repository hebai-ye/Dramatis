import { createConversation, messageId, roomId } from '@dramatis/core';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ChatControls } from './ChatControls';
import { LeftRail } from './LeftRail';
import { type FocusRequest, MainChat } from './MainChat';
import { RuntimePanel } from './RuntimePanel';
import { TopBar } from './TopBar';
import { WorldTree } from './WorldTree';

const runtime = vi.hoisted(() => {
  let narrow = false;
  let values: unknown[] = [];
  let setters: Array<(next: unknown) => void> = [];
  let effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = [];
  let cursor = 0;
  let effectCursor = 0;
  let pending: (() => void)[] = [];
  return {
    currentWorld: null as Record<string, unknown> | null,
    currentConversation: null as ReturnType<typeof createConversation> | null,
    hit: null as { messageId: string; conversationId: string } | null,
    openConversation: vi.fn(async (_id: string) => {}),
    get narrow() {
      return narrow;
    },
    set narrow(next: boolean) {
      narrow = next;
    },
    reset() {
      narrow = false;
      values = [];
      setters = [];
      effects = [];
      pending = [];
      this.currentWorld = null;
      this.currentConversation = null;
      this.hit = null;
      this.openConversation.mockClear();
    },
    begin() {
      cursor = 0;
      effectCursor = 0;
    },
    flush() {
      const next = pending;
      pending = [];
      for (const run of next) run();
    },
    state(initial: unknown) {
      const index = cursor++;
      if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
      setters[index] ??= (next: unknown) => {
        values[index] = typeof next === 'function' ? (next as (old: unknown) => unknown)(values[index]) : next;
      };
      return [values[index], setters[index]];
    },
    ref(initial: unknown) {
      const [value] = this.state(() => ({ current: initial }));
      return value;
    },
    memo(value: unknown, deps: readonly unknown[]) {
      const index = cursor++;
      const previous = values[index] as { value: unknown; deps: readonly unknown[] } | undefined;
      if (!previous || deps.some((item, i) => previous.deps[i] !== item)) values[index] = { value, deps };
      return (values[index] as { value: unknown }).value;
    },
    effect(run: () => (() => void) | undefined, deps?: readonly unknown[]) {
      const index = effectCursor++;
      const previous = effects[index];
      if (!previous || !deps || !previous.deps || deps.some((item, i) => item !== previous.deps?.[i])) {
        pending.push(() => {
          previous?.cleanup?.();
          effects[index] = { deps, cleanup: run() };
        });
      }
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: runtime.state,
  useRef: (initial: unknown) => runtime.ref(initial),
  useMemo: (factory: () => unknown, deps: readonly unknown[]) => runtime.memo(factory(), deps),
  useCallback: (callback: unknown, deps: readonly unknown[]) => runtime.memo(callback, deps),
  useEffect: runtime.effect,
  useLayoutEffect: runtime.effect,
}));
vi.mock('../lib/viewport', () => ({
  NARROW_SCREEN_QUERY: '(max-width: 640px)',
  useNarrowScreen: () => runtime.narrow,
}));
vi.mock('../lib/session', () => ({
  useDatabase: () => ({ db: null, boot: null, error: null }),
  useSession: () => ({
    world: runtime.currentWorld,
    conversation: runtime.currentConversation,
    scene: null,
    messages: [],
    instances: [],
    personas: [],
    worldBooks: [],
    cards: [],
    memories: [],
    chapters: [],
    worlds: [],
    conversations: [],
    library: { cards: [], worldBooks: [] },
    ready: false,
    error: null,
    locateTurn: () => runtime.hit,
    openConversation: runtime.openConversation,
  }),
}));
// The rail harness controls navigation completion itself; repository existence is covered by library-view tests.
vi.mock('../hooks/useLibraryWorkspace', async (importOriginal) => {
  const original = await importOriginal<typeof import('../hooks/useLibraryWorkspace')>();
  return {
    ...original,
    useLibraryNavigation: (...args: Parameters<typeof original.useLibraryNavigation>) => ({
      ...original.useLibraryNavigation(...args),
      openConversation: async (id: Parameters<typeof runtime.openConversation>[0]) => {
        await args[0].openConversation(id as Parameters<(typeof args)[0]['openConversation']>[0]);
        return true;
      },
    }),
  };
});
vi.mock('../lib/usage', () => ({
  useUsage: () => ({ world: { promptTokens: 0, completionTokens: 0 }, conversation: null, latestTurn: null }),
  extraCalls: () => 0,
}));
vi.mock('../lib/sync', () => ({ useSync: () => ({ requestAutoSync() {} }) }));
vi.mock('../lib/providers', () => ({ useProviders: () => ({ apiKey: '', background: null }) }));
vi.mock('../lib/worker', () => ({ useBackgroundWorker: () => ({ pending: false, failed: [], lastError: null }) }));
vi.mock('../lib/admin', () => ({ useAdminChat: () => ({ busy: false, bridge: null, error: null }) }));
vi.mock('../lib/archive', () => ({ useArchive: () => ({}) }));
vi.mock('../lib/storage', () => ({ useStorageStatus: () => ({ ratio: null }) }));
vi.mock('../lib/appearance', () => ({
  useAppearance: () => ({ value: { background: '', backgroundOpacity: 0, showIntent: false } }),
}));
vi.mock('../hooks/useNotices', () => ({
  useNotices: () => ({
    error: null,
    setError() {},
    warnings: [],
    setWarnings() {},
    installHint: false,
    dismissInstallHint() {},
  }),
}));
vi.mock('../hooks/useWebBridge', () => ({ useWebBridge: () => ({ bridge: null, setBridge() {} }) }));
vi.mock('../hooks/useTurnRunner', () => ({
  useTurnRunner: () => ({
    makeCharacterLine() {},
    enqueueSceneSummary() {},
    handleSend() {},
    prepareBridgeReply() {},
    handleRegenerate() {},
    handleReassignMessage() {},
    stop() {},
  }),
}));
vi.mock('../hooks/useImport', () => ({ useImport: () => ({ handleImport() {} }) }));
vi.mock('@dramatis/core', async (original) => ({
  ...(await original<typeof import('@dramatis/core')>()),
  evaluateBudget: () => ({ burned: false, reason: '' }),
}));

function render(): ReactElement<Record<string, unknown>> {
  runtime.begin();
  App();
  runtime.flush();
  runtime.begin();
  const tree = App() as ReactElement<Record<string, unknown>>;
  runtime.flush();
  return tree;
}
function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as ReactElement<Record<string, unknown>>;
  return [element, ...nodes(element.props.children as ReactNode)];
}
function appClass(tree: ReactNode): string {
  const app = nodes(tree).find(
    (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('app'),
  );
  if (!app) throw new Error('App container missing');
  return app.props.className as string;
}
function requiredNode(tree: ReactNode, type: unknown): ReactElement<Record<string, unknown>> {
  const found = nodes(tree).find((node) => node.type === type);
  if (!found) throw new Error(`Expected component ${String(type)}`);
  return found;
}
function controls(tree: ReactElement<Record<string, unknown>>) {
  const topbar = nodes(tree).find((node) => node.type === TopBar);
  if (!topbar) throw new Error('TopBar missing');
  const panel = nodes(topbar.props.chatControls as ReactNode).find((node) => node.type === ChatControls);
  if (!panel) throw new Error('ChatControls missing');
  return { topbar, panel };
}
function click(node: ReactElement<Record<string, unknown>>, key: string): void {
  (node.props[key] as () => void)();
}

beforeEach(() => {
  runtime.reset();
  vi.stubGlobal('window', { matchMedia: () => ({ matches: runtime.narrow }) });
});

describe('focus request sequencing in App', () => {
  it('consumes only the current seq and leaves a newer request intact', () => {
    runtime.narrow = true;
    const id = roomId('room-1');
    const conversation = createConversation({ roomId: id, title: 'Main' });
    runtime.currentWorld = { id, title: 'World', playerName: 'Player', budget: null, worldBookIds: [] };
    runtime.currentConversation = conversation;
    runtime.hit = { messageId: messageId('message-1'), conversationId: conversation.id };
    let tree = render();
    const locate = requiredNode(tree, RuntimePanel).props.onLocateMemory as (turnId: string) => void;
    locate('turn-1');
    tree = render();
    const first = requiredNode(tree, MainChat);
    const oldRequest = first.props.focus as FocusRequest;
    expect(oldRequest.seq).toBe(1);
    runtime.hit = { messageId: messageId('message-2'), conversationId: conversation.id };
    locate('turn-2');
    tree = render();
    const second = requiredNode(tree, MainChat);
    expect((second.props.focus as FocusRequest).seq).toBe(2);
    (first.props.onFocusConsumed as (request: FocusRequest) => void)(oldRequest);
    tree = render();
    expect((requiredNode(tree, MainChat).props.focus as FocusRequest).seq).toBe(2);
    (second.props.onFocusConsumed as (request: FocusRequest) => void)(second.props.focus as FocusRequest);
    tree = render();
    expect(nodes(tree).find((node) => node.type === MainChat)?.props.focus).toBeNull();
  });

  it('does not restore an older cross-conversation focus when its navigation finishes late', async () => {
    runtime.narrow = true;
    const id = roomId('room-1');
    const current = createConversation({ roomId: id, title: 'Current' });
    const firstTarget = createConversation({ roomId: id, title: 'First target' });
    const secondTarget = createConversation({ roomId: id, title: 'Second target' });
    runtime.currentWorld = { id, title: 'World', playerName: 'Player', budget: null, worldBookIds: [] };
    runtime.currentConversation = current;
    const resolve: Array<() => void> = [];
    runtime.openConversation.mockImplementation(
      (targetId) =>
        new Promise<void>((done) =>
          resolve.push(() => {
            runtime.currentConversation = targetId === firstTarget.id ? firstTarget : secondTarget;
            done();
          }),
        ),
    );
    let tree = render();
    const locate = requiredNode(tree, RuntimePanel).props.onLocateMemory as (turnId: string) => void;
    runtime.hit = { messageId: messageId('message-1'), conversationId: firstTarget.id };
    locate('turn-1');
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(runtime.openConversation).toHaveBeenCalledTimes(1);
    runtime.hit = { messageId: messageId('message-2'), conversationId: secondTarget.id };
    locate('turn-2');
    resolve[0]?.();
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    tree = render();
    const focus = requiredNode(tree, MainChat).props.focus as FocusRequest;
    expect(focus.seq).toBe(2);
    expect(focus.conversationId).toBe(secondTarget.id);
    expect(runtime.openConversation).toHaveBeenCalledTimes(2);
    resolve[1]?.();
    await Promise.resolve();
    tree = render();
    expect(runtime.currentConversation?.id).toBe(secondTarget.id);
    expect((requiredNode(tree, MainChat).props.focus as FocusRequest).seq).toBe(2);
  });

  it('cancels a pending locate when the user selects another conversation', async () => {
    runtime.narrow = true;
    const id = roomId('room-1');
    const current = createConversation({ roomId: id, title: 'Current' });
    const oldTarget = createConversation({ roomId: id, title: 'Old target' });
    const selected = createConversation({ roomId: id, title: 'Selected' });
    runtime.currentWorld = { id, title: 'World', playerName: 'Player', budget: null, worldBookIds: [] };
    runtime.currentConversation = current;
    runtime.hit = { messageId: messageId('old-message'), conversationId: oldTarget.id };
    let resolveOld: (() => void) | undefined;
    runtime.openConversation.mockImplementation((targetId) => {
      if (targetId === oldTarget.id)
        return new Promise<void>((done) => {
          resolveOld = () => {
            runtime.currentConversation = oldTarget;
            done();
          };
        });
      runtime.currentConversation = selected;
      return Promise.resolve();
    });
    let tree = render();
    const locate = requiredNode(tree, RuntimePanel).props.onLocateMemory as (turnId: string) => void;
    locate('turn-old');
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    tree = render();
    const rail = requiredNode(tree, LeftRail);
    const worldTree = requiredNode(rail.props.list as ReactNode, WorldTree);
    (worldTree.props.onOpenConversation as (id: string) => void)(selected.id);
    tree = render();
    expect(nodes(tree).find((node) => node.type === MainChat)?.props.focus).toBeNull();
    resolveOld?.();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    tree = render();
    expect(nodes(tree).find((node) => node.type === MainChat)?.props.focus).toBeNull();
  });
});

describe('rail navigation across viewport sizes', () => {
  it('opens the left rail by closing the right panel on narrow screens', () => {
    runtime.narrow = true;
    let tree = render();
    click(controls(tree).panel, 'onTogglePanel');
    tree = render();
    expect(appClass(tree)).toContain('panel-open');
    click(controls(tree).topbar, 'onToggleCollapsed');
    tree = render();
    expect(appClass(tree)).toContain('rail-open');
    expect(appClass(tree)).not.toContain('panel-open');
  });

  it('keeps desktop rails independent and prefers the left when shrinking with both open', () => {
    let tree = render();
    click(controls(tree).panel, 'onTogglePanel');
    tree = render();
    expect(controls(tree).panel.props.panelOpen).toBe(true);
    runtime.narrow = true;
    tree = render();
    expect(appClass(tree)).toContain('rail-open');
    expect(appClass(tree)).not.toContain('panel-open');
  });

  it('closing the left rail leaves an already open right panel alone', () => {
    let tree = render();
    click(controls(tree).panel, 'onTogglePanel');
    render();
    runtime.narrow = true;
    // Exercise the close callback before the shrink layout effect reconciles the artificial double-open state.
    runtime.begin();
    tree = App() as ReactElement<Record<string, unknown>>;
    click(controls(tree).topbar, 'onToggleCollapsed');
    runtime.begin();
    tree = App() as ReactElement<Record<string, unknown>>;
    expect(appClass(tree)).not.toContain('rail-open');
    expect(appClass(tree)).toContain('panel-open');
  });
});
