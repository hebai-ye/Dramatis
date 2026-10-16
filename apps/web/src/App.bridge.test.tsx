import {
  type CharacterInstance,
  createBackgroundRunner,
  createBlankCard,
  createCharacterMessage,
  createMemoryEntityStore,
  createPersona,
  createProviderProfile,
  createUsageLedger,
  createWorldFromCard,
  type Message,
  Repository,
  sceneId,
} from '@dramatis/core';
import { type ComponentProps, isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { DeepSeekKeyDialog } from './components/DeepSeekKeyDialog';
import { LibraryWorkspaceProvider } from './components/LibraryWorkspace';
import { MainChat } from './components/MainChat';
import type { WebBridgeState } from './components/WebBridgePanel';
import type { Notice } from './hooks/useNotices';
import type { TurnRunnerApi, TurnRunnerOptions } from './hooks/useTurnRunner';
import { loadBridge, prepareBridgeAnalysis, saveBridge } from './lib/bridge-store';
import type { DramatisDb } from './lib/db';
import type { LibraryViewActions } from './lib/library-view';
import type { ProvidersApi } from './lib/providers';
import type { SessionApi } from './lib/session';
import { createTaskQueueExtras } from './lib/task-queue';

type FixtureSession = Pick<
  SessionApi,
  | 'ready'
  | 'error'
  | 'world'
  | 'worlds'
  | 'conversation'
  | 'conversations'
  | 'scene'
  | 'scenes'
  | 'messages'
  | 'instances'
  | 'cards'
  | 'worldBooks'
  | 'memories'
  | 'chapters'
  | 'personas'
  | 'library'
  | 'appendMessages'
  | 'reloadWorld'
  | 'refreshAll'
>;
type Gate = { promise: Promise<void>; resolve: () => void };
type CaptureDelay = { started: Gate; release: Gate; finished: Gate };

// Run the actual App callbacks and bridge hook without a DOM. External application
// services are idle fixtures; bridge capture, source fingerprints and writes stay real.
const model = vi.hoisted(() => ({
  db: null as DramatisDb | null,
  providers: null as ProvidersApi | null,
  session: null as FixtureSession | null,
  runnerOptions: null as TurnRunnerOptions | null,
  runnerApi: null as TurnRunnerApi | null,
  accountKey: 'app-bridge-account-a',
  captureDelay: null as CaptureDelay | null,
  errors: [] as (string | null)[],
  requestAutoSync: vi.fn(),
  libraryNavigation: { current: null as LibraryViewActions | null },
}));
const host = vi.hoisted(() => {
  const createHost = () => {
    type Slot = {
      value: unknown;
      deps?: readonly unknown[];
      cleanup?: () => void;
      setter?: (value: unknown) => void;
    };
    let slots: Slot[] = [];
    let cursor = 0;
    let changed = false;
    let layouts: (() => void)[] = [];
    let effects: (() => void)[] = [];
    const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
      a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
    const state = (initial: unknown) => {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      const cell = slots[index];
      if (!cell) throw new Error('Missing hook cell');
      cell.setter ??= (next) => {
        const value = typeof next === 'function' ? next(cell.value) : next;
        if (!Object.is(value, cell.value)) changed = true;
        cell.value = value;
      };
      return [cell.value, cell.setter];
    };
    const memo = <T,>(run: () => T, deps?: readonly unknown[]): T => {
      const index = cursor++;
      if (!slots[index] || !same(slots[index]?.deps, deps)) slots[index] = { value: run(), deps };
      return slots[index]?.value as T;
    };
    const effect = (run: () => (() => void) | undefined, deps?: readonly unknown[], layout = false) => {
      const index = cursor++;
      const previous = slots[index];
      if (previous && same(previous.deps, deps)) return;
      (layout ? layouts : effects).push(() => {
        previous?.cleanup?.();
        slots[index] = { value: null, deps, cleanup: run() };
      });
    };
    return {
      state,
      memo,
      effect,
      ref: (initial: unknown) => state(() => ({ current: initial }))[0],
      callback: <T,>(callback: T, deps?: readonly unknown[]) => memo(() => callback, deps),
      begin() {
        cursor = 0;
        changed = false;
      },
      flush() {
        const currentLayouts = layouts;
        const currentEffects = effects;
        layouts = [];
        effects = [];
        for (const run of currentLayouts) run();
        for (const run of currentEffects) run();
        return changed;
      },
      pending: () => changed,
      reset() {
        for (const slot of slots) slot.cleanup?.();
        slots = [];
        layouts = [];
        effects = [];
      },
    };
  };
  const app = createHost();
  const library = createHost();
  let current = app;
  return {
    ...app,
    state: (initial: unknown) => current.state(initial),
    memo: <T,>(run: () => T, deps?: readonly unknown[]) => current.memo(run, deps),
    effect: (run: () => (() => void) | undefined, deps?: readonly unknown[], layout = false) =>
      current.effect(run, deps, layout),
    ref: (initial: unknown) => current.ref(initial),
    callback: <T,>(callback: T, deps?: readonly unknown[]) => current.callback(callback, deps),
    library,
    inLibrary<T>(run: () => T): T {
      const previous = current;
      current = library;
      try {
        return run();
      } finally {
        current = previous;
      }
    },
    reset() {
      app.reset();
      library.reset();
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: host.state,
  useRef: host.ref,
  useMemo: host.memo,
  useCallback: host.callback,
  useEffect: host.effect,
  useLayoutEffect: (run: () => (() => void) | undefined, deps?: readonly unknown[]) => host.effect(run, deps, true),
}));
vi.mock('@dramatis/core', async (original) => {
  const core = await original<typeof import('@dramatis/core')>();
  return {
    ...core,
    captureTurnAnalysis: async (...args: Parameters<typeof core.captureTurnAnalysis>) => {
      const delay = model.captureDelay;
      model.captureDelay = null;
      if (delay) {
        delay.started.resolve();
        await delay.release.promise;
      }
      try {
        return await core.captureTurnAnalysis(...args);
      } finally {
        delay?.finished.resolve();
      }
    },
  };
});
vi.mock('./lib/session', () => ({
  useDatabase: () => ({ db: model.db, boot: null, error: null }),
  useSession: () => model.session,
}));
vi.mock('./lib/db', async (original) => ({
  ...(await original<typeof import('./lib/db')>()),
  activeDbName: () => model.accountKey,
}));
vi.mock('./hooks/useTurnRunner', () => ({
  useTurnRunner: (options: TurnRunnerOptions) => {
    model.runnerOptions = options;
    return model.runnerApi;
  },
}));
vi.mock('./hooks/useNotices', () => ({
  useNotices: () => {
    const [error, setError] = host.state(null) as [string | null, (error: string | null) => void];
    const [warnings, setWarnings] = host.state([]) as [Notice[], (next: unknown) => void];
    const reportError = host.memo(
      () => (next: string | null) => {
        model.errors.push(next);
        setError(next);
      },
      [setError],
    );
    return { error, setError: reportError, warnings, setWarnings, installHint: false, dismissInstallHint: () => {} };
  },
}));
vi.mock('./hooks/useImport', () => ({ useImport: () => ({ handleImport: vi.fn() }) }));
vi.mock('./hooks/useLibraryWorkspace', () => ({
  useLibraryNavigation: () => ({
    libraryNavigation: model.libraryNavigation,
    enterLibrary: () => {},
    returnFromLibrary: () => {},
  }),
  useLibrarySurface: () => ({ libraryCounts: {}, librarySurface: {} }),
}));
vi.mock('./lib/admin', () => ({ useAdminChat: () => ({ busy: false }) }));
vi.mock('./lib/appearance', () => ({
  useAppearance: () => ({ value: { background: '', backgroundOpacity: 0, showIntent: false } }),
}));
vi.mock('./lib/archive', () => ({ useArchive: () => ({}) }));
vi.mock('./lib/providers', () => ({ useProviders: () => model.providers ?? { apiKey: '', active: null } }));
vi.mock('./lib/storage', () => ({ useStorageStatus: () => ({ ratio: null }) }));
vi.mock('./lib/sync', () => ({ useSync: () => ({ requestAutoSync: model.requestAutoSync }) }));
vi.mock('./lib/usage', async (original) => ({
  ...(await original<typeof import('./lib/usage')>()),
  useUsage: () => ({ world: null, conversation: null, latestTurn: null }),
}));
vi.mock('./lib/viewport', async (original) => ({
  ...(await original<typeof import('./lib/viewport')>()),
  useNarrowScreen: () => false,
}));
vi.mock('./lib/worker', () => ({ useBackgroundWorker: () => ({ pending: 0 }) }));

function gate(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function delayCapture(): CaptureDelay {
  const delay = { started: gate(), release: gate(), finished: gate() };
  model.captureDelay = delay;
  return delay;
}
async function finishCapture(delay: CaptureDelay) {
  delay.release.resolve();
  await delay.finished.promise;
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
function findMainChat(node: ReactNode): ComponentProps<typeof MainChat> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findMainChat(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  if (node.type === MainChat) return node.props as ComponentProps<typeof MainChat>;
  return findMainChat(node.props.children);
}
let appTree: ReactNode;
function renderApp() {
  let node: ReactNode;
  for (let i = 0; i < 10; i++) {
    host.begin();
    node = App();
    appTree = node;
    if (!host.flush()) {
      const props = findMainChat(node);
      if (!props) throw new Error('App did not provide MainChat');
      return props;
    }
  }
  throw new Error('App hook updates did not settle');
}
function runnerBridge(next: WebBridgeState | null) {
  if (!model.runnerOptions) throw new Error('Runner was not connected');
  model.runnerOptions.setBridge(next);
}
async function fixture() {
  const store = createMemoryEntityStore();
  const repository = new Repository(store);
  const card = createBlankCard({ name: '阿青' });
  const persona = createPersona({ name: '旅人' });
  const world = createWorldFromCard(card, persona);
  await repository.saveSnapshot({
    room: world.room,
    conversations: [world.conversation],
    scenes: [world.scene],
    instances: [world.instance],
  });
  model.db = {
    backendKind: store.kind,
    store,
    repository,
    queue: createBackgroundRunner(store),
    ledger: createUsageLedger(store),
    tasks: createTaskQueueExtras(store),
  };
  model.session = {
    ready: true,
    error: null,
    world: world.room,
    worlds: [],
    conversation: world.conversation,
    conversations: [world.conversation],
    scene: world.scene,
    scenes: [world.scene],
    messages: [],
    instances: [world.instance],
    cards: [card],
    worldBooks: [],
    memories: [],
    chapters: [],
    personas: [persona],
    library: { cards: [card], worldBooks: [] },
    appendMessages: async (messages) => {
      await repository.appendMessages(world.room.id, messages);
      if (model.session) model.session = { ...model.session, messages: await repository.listMessages(world.room.id) };
    },
    reloadWorld: vi.fn(async () => {}),
    refreshAll: vi.fn(async () => {}),
  };
  model.runnerApi = {
    makeCharacterLine: (speaker: CharacterInstance, content, turnId, scene) =>
      createCharacterMessage({
        roomId: world.room.id,
        conversationId: world.conversation.id,
        sceneId: scene.id,
        turnId,
        speakerInstanceId: speaker.id,
        speakerName: speaker.displayName,
        audience: scene.cast,
        content,
      }),
    enqueueSceneSummary: vi.fn(async () => {}),
    handleSend: vi.fn(async () => ({ status: 'accepted' as const })),
    prepareBridgeReply: vi.fn(async () => '下一位提示词'),
    handleRegenerate: vi.fn(async () => {}),
    handleReassignMessage: vi.fn(async () => {}),
    stop: vi.fn(),
  };
  const scope = {
    roomId: world.room.id,
    conversationId: world.conversation.id,
    sceneId: world.scene.id,
    turnId: 'app-bridge-turn-a',
  };
  const message = createCharacterMessage({
    ...scope,
    speakerInstanceId: world.instance.id,
    speakerName: world.instance.displayName,
    audience: world.scene.cast,
    content: '「落盘的原始回复。」',
  });
  const saveTurn = async () => {
    await model.session?.appendMessages([message]);
  };
  return { repository, world, scope, message, saveTurn };
}

const analysis = JSON.stringify({
  summary: '这一轮发生了交谈',
  importance: 0.6,
  observations: [{ speaker: '阿青', perception: '旅人值得信任' }],
  updates: [{ observer: '阿青', deltaValence: 0.1 }],
});

beforeEach(() => {
  host.reset();
  model.db = null;
  model.providers = null;
  model.session = null;
  model.runnerOptions = null;
  model.runnerApi = null;
  model.accountKey = 'app-bridge-account-a';
  model.captureDelay = null;
  model.errors.length = 0;
  model.requestAutoSync.mockClear();
  model.libraryNavigation.current = null;
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => {
  host.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('App bridge publication and operation ownership', () => {
  function setupProviders(key = '') {
    const active = createProviderProfile({ name: 'fixture', baseUrl: 'https://api.deepseek.com', model: 'fixture' });
    model.providers = {
      active,
      activeId: active.id,
      keyMode: 'device',
      apiKey: key,
      keyLoading: false,
      keyError: null,
      vaultLocked: false,
      setupOwner: { profileId: active.id, keyMode: 'device', context: {}, token: {} },
    } as ProvidersApi;
  }
  function findSetup(node: ReactNode): ComponentProps<typeof DeepSeekKeyDialog> | null {
    if (Array.isArray(node)) return node.map(findSetup).find((item) => item !== null) ?? null;
    if (!isValidElement<{ children?: ReactNode }>(node)) return null;
    return node.type === DeepSeekKeyDialog
      ? (node.props as ComponentProps<typeof DeepSeekKeyDialog>)
      : findSetup(node.props.children);
  }
  function findLibrary(node: ReactNode): ComponentProps<typeof LibraryWorkspaceProvider> | null {
    if (Array.isArray(node)) return node.map(findLibrary).find((item) => item !== null) ?? null;
    if (!isValidElement<{ children?: ReactNode }>(node)) return null;
    return node.type === LibraryWorkspaceProvider
      ? (node.props as ComponentProps<typeof LibraryWorkspaceProvider>)
      : findLibrary(node.props.children);
  }
  function renderLibrary() {
    const props = findLibrary(appTree);
    if (!props) throw new Error('App did not provide LibraryWorkspaceProvider');
    host.inLibrary(() => {
      host.library.begin();
      LibraryWorkspaceProvider(props);
      host.library.flush();
    });
  }
  it('shows queued key setup when only the library child closes', async () => {
    await fixture();
    setupProviders();
    if (!model.providers) throw new Error('Missing fixture providers');
    model.providers = { ...model.providers, keyLoading: true };
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    renderApp();
    renderLibrary();
    await model.libraryNavigation.current?.toggle('personas');
    renderLibrary();
    renderApp();
    model.providers = { ...model.providers, keyLoading: false };
    renderApp();
    expect(findSetup(appTree)).toBeNull();
    expect(host.pending()).toBe(false);

    await model.libraryNavigation.current?.close();
    renderLibrary();

    // A child-only library close must schedule App itself; unrelated renders are unnecessary.
    expect(host.pending()).toBe(true);
    renderApp();
    expect(findSetup(appTree)).not.toBeNull();
  });
  it('opens the key dialog for confirmed missing keys without replacing the current conversation', async () => {
    const f = await fixture();
    setupProviders();
    renderApp();
    expect(findSetup(appTree)).not.toBeNull();
    expect(renderApp().conversation.id).toBe(f.world.conversation.id);
    findSetup(appTree)?.onClose();
    renderApp();
    expect(findSetup(appTree)).toBeNull();
    renderApp().onConfigureDeepSeekKey?.();
    renderApp();
    expect(findSetup(appTree)).not.toBeNull();
  });
  it('keeps a pending manual reply ahead of an automatic key prompt', async () => {
    const f = await fixture();
    setupProviders();
    saveBridge('main', {
      stage: 'reply',
      turnId: f.scope.turnId,
      speakerInstanceId: f.world.instance.id,
      prompt: 'fixture pending',
    });
    renderApp();
    expect(findSetup(appTree)).toBeNull();
    expect(renderApp().bridge).not.toBeNull();
  });
  it('does not open setup over an existing readable key', async () => {
    await fixture();
    setupProviders('fixture-existing');
    renderApp();
    expect(findSetup(appTree)).toBeNull();
  });
  it('passes restored bridge waiting state to the central send entry', async () => {
    const f = await fixture();
    saveBridge('main', {
      stage: 'reply',
      turnId: f.scope.turnId,
      speakerInstanceId: f.world.instance.id,
      prompt: 'Synthetic waiting',
    });
    renderApp();
    expect(model.runnerOptions?.bridgeOpen).toBe(true);
    expect(model.runnerOptions?.accountKey).toBe(model.accountKey);
  });
  it('rejects an old account reply even when all world/conversation/scene IDs match', async () => {
    const f = await fixture();
    saveBridge('main', {
      stage: 'reply',
      turnId: f.scope.turnId,
      speakerInstanceId: f.world.instance.id,
      prompt: 'Synthetic account A',
      pendingTurn: {
        ...f.scope,
        accountKey: model.accountKey,
        playerText: 'A draft',
        speakerIds: [f.world.instance.id],
        nextIndex: 0,
      },
    });
    model.accountKey = 'app-bridge-account-b';
    await renderApp().onBridgeReply?.('「不应写入B。」');
    expect(await f.repository.listMessages(f.scope.roomId)).toHaveLength(0);
    expect(model.errors.join(' ')).toContain('账户');
  });
  it.each([false, true])(
    'rejects a restored reply without source metadata, changed account=%s',
    async (changedAccount) => {
      const f = await fixture();
      const legacyReply: WebBridgeState = {
        stage: 'reply',
        turnId: f.scope.turnId,
        speakerInstanceId: f.world.instance.id,
        prompt: '旧版未绑定来源的提示词',
      };
      saveBridge('main', legacyReply);
      if (changedAccount) model.accountKey = 'app-bridge-account-b';
      renderApp().onBridgeReply?.('「未绑定的旧回复不得写入当前世界。」');
      await vi.waitFor(() => expect(renderApp().busy).toBe(false));
      expect(await f.repository.listMessages(f.scope.roomId)).toEqual([]);
      expect(await f.repository.listMemories(f.scope.roomId)).toEqual([]);
      expect(model.errors.join(' ')).toMatch(/来源.*重新准备/);
      expect(renderApp().bridge).toEqual(legacyReply);
      expect(loadBridge('main')).toEqual(legacyReply);
    },
  );
  it('binds a runner analysis request to the persisted source before showing and saving it', async () => {
    const f = await fixture();
    await f.saveTurn();
    renderApp();
    const delay = delayCapture();
    runnerBridge({ stage: 'analysis', turnId: f.scope.turnId, prompt: '未绑定的 runner 提示词' });
    await delay.started.promise;
    expect(renderApp().bridge).toBeNull();
    await finishCapture(delay);
    const expected = await prepareBridgeAnalysis(f.repository, f.scope, model.accountKey);
    expect(renderApp().bridge).toEqual(expected);
    expect(expected.prompt).toContain('落盘的原始回复');
    expect(expected.analysisBinding).toMatchObject({ scope: f.scope, accountKey: model.accountKey });
    expect(expected.analysisBinding.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(loadBridge('main')).toEqual(expected);
    expect(model.errors).toEqual([]);
  });

  it.each(['analysis', 'clear'] as const)(
    'ignores an old runner %s callback without clearing the new bridge or cancelling its preparation',
    async (lateAction) => {
      const f = await fixture();
      await f.saveTurn();
      renderApp();
      const oldRunnerBridge = model.runnerOptions?.setBridge;
      if (!oldRunnerBridge || !model.session) throw new Error('Runner or session missing');
      const nextScene = { ...f.world.scene, id: sceneId('app-bridge-runner-owner-b'), title: '新场景' };
      await f.repository.saveScene(nextScene);
      const nextScope = { ...f.scope, sceneId: nextScene.id, turnId: 'app-bridge-runner-turn-b' };
      await model.session.appendMessages([
        createCharacterMessage({
          ...nextScope,
          speakerInstanceId: f.world.instance.id,
          speakerName: f.world.instance.displayName,
          audience: nextScene.cast,
          content: '「新场景落盘回复。」',
        }),
      ]);
      model.session = { ...model.session, scene: nextScene, scenes: [...model.session.scenes, nextScene] };
      renderApp();
      const newReply: WebBridgeState = {
        stage: 'reply',
        turnId: nextScope.turnId,
        speakerInstanceId: f.world.instance.id,
        prompt: '新场景桥接进度',
      };
      runnerBridge(newReply);
      renderApp();
      const delay = delayCapture();
      runnerBridge({ stage: 'analysis', turnId: nextScope.turnId, prompt: '新场景分析请求' });
      await delay.started.promise;
      oldRunnerBridge(
        lateAction === 'clear' ? null : { stage: 'analysis', turnId: f.scope.turnId, prompt: '迟到旧请求' },
      );
      const whilePending = renderApp().bridge;
      await finishCapture(delay);
      const expected = await prepareBridgeAnalysis(f.repository, nextScope, model.accountKey);
      expect(whilePending).toEqual(newReply);
      expect(renderApp().bridge).toEqual(expected);
      expect(loadBridge('main')).toEqual(expected);
      expect(model.errors).toEqual([]);
    },
  );

  it('releases analysis busy state immediately when its account owner changes during capture', async () => {
    const f = await fixture();
    await f.saveTurn();
    const bridge = await prepareBridgeAnalysis(f.repository, f.scope, model.accountKey);
    saveBridge('main', bridge);
    const chat = renderApp();
    const delay = delayCapture();
    chat.onBridgeAnalysis?.(analysis);
    await delay.started.promise;
    expect(renderApp().busy).toBe(true);
    model.accountKey = 'app-bridge-account-b';
    expect(renderApp().busy).toBe(false);
    await finishCapture(delay);
    expect(renderApp()).toMatchObject({ busy: false, bridge });
    expect(await f.repository.listMemories(f.scope.roomId)).toEqual([]);
    expect((await f.repository.listInstances(f.scope.roomId))[0]?.affect.history).toEqual([]);
    expect(model.session?.reloadWorld).not.toHaveBeenCalled();
    expect(model.requestAutoSync).not.toHaveBeenCalled();
    expect(model.errors).toEqual([]);
  });

  it('analyzes a reassigned historical scene turn while keeping the current view, then rejects it after another scene change', async () => {
    const f = await fixture();
    await f.saveTurn();
    const viewScene = { ...f.world.scene, id: sceneId('app-bridge-current-view'), title: '当前场景' };
    await f.repository.saveScene(viewScene);
    if (!model.session) throw new Error('Session missing');
    model.session = { ...model.session, scene: viewScene, scenes: [f.world.scene, viewScene] };
    renderApp();
    const preparation = delayCapture();
    runnerBridge({ stage: 'analysis', turnId: f.scope.turnId, prompt: '历史回合改归属后的提示词' });
    await preparation.started.promise;
    await finishCapture(preparation);
    const prepared = renderApp().bridge;
    expect(prepared).toMatchObject({
      stage: 'analysis',
      turnId: f.scope.turnId,
      analysisBinding: { scope: f.scope, viewSceneId: viewScene.id, accountKey: model.accountKey },
    });
    expect(prepared?.prompt).toContain('落盘的原始回复');
    expect(renderApp().scene?.id).toBe(viewScene.id);
    expect(model.errors).toEqual([]);

    renderApp().onBridgeAnalysis?.(analysis);
    await vi.waitFor(() => {
      expect(renderApp()).toMatchObject({ busy: false, bridge: null });
    });
    const memories = await f.repository.listMemories(f.scope.roomId);
    expect(memories.length).toBeGreaterThan(0);
    expect(
      memories.every((memory) => memory.sceneId === f.scope.sceneId && memory.sourceTurnIds.includes(f.scope.turnId)),
    ).toBe(true);
    const affected = (await f.repository.listInstances(f.scope.roomId))[0];
    expect(affected?.affect.history).toHaveLength(1);
    expect(renderApp().scene?.id).toBe(viewScene.id);
    expect(model.errors).toEqual([]);

    // Restoring this saved progress keeps its original view owner. A later scene
    // change must reject the old paste even though the source turn is unchanged.
    saveBridge('main', prepared);
    host.reset();
    renderApp();
    const otherScene = { ...viewScene, id: sceneId('app-bridge-next-view'), title: '再次切场' };
    await f.repository.saveScene(otherScene);
    if (!model.session) throw new Error('Session missing');
    model.session = { ...model.session, scene: otherScene, scenes: [...model.session.scenes, otherScene] };
    const changedChat = renderApp();
    changedChat.onBridgeAnalysis?.(analysis);
    await vi.waitFor(() => expect(model.errors.at(-1)).toContain('场景已变化'));
    expect(renderApp()).toMatchObject({ busy: false, bridge: prepared });
    expect(await f.repository.listMemories(f.scope.roomId)).toEqual(memories);
    expect((await f.repository.listInstances(f.scope.roomId))[0]?.affect.history).toEqual(affected?.affect.history);
  });

  it('keeps a new scene reply and its busy state when the previous reply preparation finishes late', async () => {
    const f = await fixture();
    const originalReply: WebBridgeState = {
      stage: 'reply',
      turnId: f.scope.turnId,
      speakerInstanceId: f.world.instance.id,
      prompt: '第一场回复提示词',
      pendingTurn: {
        ...f.scope,
        accountKey: model.accountKey,
        playerText: '第一场玩家发言',
        speakerIds: [f.world.instance.id],
        nextIndex: 0,
      },
    };
    saveBridge('main', originalReply);
    const originalChat = renderApp();
    const oldDelay = delayCapture();
    originalChat.onBridgeReply?.('「旧场景已保存回复。」');
    await oldDelay.started.promise;
    expect(renderApp().busy).toBe(true);
    const nextScene = { ...f.world.scene, id: sceneId('app-bridge-scene-b'), title: '另一场' };
    await f.repository.saveScene(nextScene);
    if (!model.session) throw new Error('Session missing');
    model.session = { ...model.session, scene: nextScene, scenes: [...model.session.scenes, nextScene] };
    expect(renderApp().busy).toBe(false);
    const newReply = {
      ...originalReply,
      turnId: 'app-bridge-turn-b',
      prompt: '新场景回复提示词',
      pendingTurn: {
        ...f.scope,
        sceneId: nextScene.id,
        turnId: 'app-bridge-turn-b',
        accountKey: model.accountKey,
        playerText: '新场景玩家发言',
        speakerIds: [f.world.instance.id],
        nextIndex: 0,
      },
    };
    runnerBridge(newReply);
    const newChat = renderApp();
    const newDelay = delayCapture();
    newChat.onBridgeReply?.('「新场景已保存回复。」');
    await newDelay.started.promise;
    expect(renderApp().busy).toBe(true);
    await finishCapture(oldDelay);
    expect(renderApp()).toMatchObject({ bridge: newReply, busy: true });
    expect(loadBridge('main')).toEqual(newReply);
    await finishCapture(newDelay);
    const expected = await prepareBridgeAnalysis(
      f.repository,
      { ...f.scope, sceneId: nextScene.id, turnId: newReply.turnId },
      model.accountKey,
    );
    expect(renderApp()).toMatchObject({ bridge: expected, busy: false });
    const replies: Message[] = await f.repository.listMessages(f.scope.roomId);
    expect(replies).toHaveLength(4);
    expect(replies.map((reply) => [reply.sceneId, reply.role, reply.content])).toEqual([
      [f.scope.sceneId, 'player', '第一场玩家发言'],
      [f.scope.sceneId, 'character', '「旧场景已保存回复。」'],
      [nextScene.id, 'player', '新场景玩家发言'],
      [nextScene.id, 'character', '「新场景已保存回复。」'],
    ]);
    expect(model.errors).toEqual([]);
  });
});
