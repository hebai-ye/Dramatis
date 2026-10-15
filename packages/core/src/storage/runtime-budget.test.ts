import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as React from '../../../../apps/web/node_modules/@types/react/index.js';
import type { createLazyModule, LazyModuleAddress } from '../../../../apps/web/src/lib/lazy-module.js';
import type { BudgetLimits, BudgetState } from './budget.js';
import type { UsageSummary } from './usage.js';

// Vitest/Vite transpiles and executes the real TSX modules; no source-text assertions.
// Core has no React/JSX runtime of its own: use the existing web installation, as usage-hook.test.ts does.
// RuntimePanel, LazyPanel, the budget/serial-save hooks, and createLazyModule execute from real source.
// The Core barrel is narrowed to its real budget-editor exports; unrelated Core modules are outside
// this UI wiring fixture. Only hooks, sibling panels, URL metadata, and transport are controlled.
// Failed per-URL module promises and
// stale HTTP responses survive recovery; the production loader must actually bypass/refresh them.
// This is NOT native DOM/StrictMode, browser fault-injection evidence, or a production chunk-size test.
const paths = {
  budgetEditor: './budget-editor.js',
  react: '../../../../apps/web/node_modules/react/index.js',
  server: '../../../../apps/web/node_modules/react-dom/server.node.js',
  runtime: '../../../../apps/web/src/components/RuntimePanel.tsx',
  lazy: '../../../../apps/web/src/components/LazyPanel.tsx',
  loader: '../../../../apps/web/src/lib/lazy-module.ts',
  address: '../../../../apps/web/src/components/UsagePanel.tsx?lazy-module-url',
  usage: '../../../../apps/web/src/components/UsagePanel.tsx',
  counter: '../../../../apps/web/src/lib/render-count.ts',
  cast: '../../../../apps/web/src/components/CastPanel.tsx',
  icons: '../../../../apps/web/src/components/Icons.tsx',
  memory: '../../../../apps/web/src/components/MemoryPanel.tsx',
  prompt: '../../../../apps/web/src/components/PromptInspector.tsx',
  scene: '../../../../apps/web/src/components/ScenePanel.tsx',
};
const mockedPaths = [
  '@dramatis/core',
  paths.react,
  paths.loader,
  paths.address,
  paths.usage,
  paths.counter,
  paths.cast,
  paths.icons,
  paths.memory,
  paths.prompt,
  paths.scene,
];

type Tree = React.ReactNode;
type Element = React.ReactElement<Record<string, unknown>>;
type Save = (limits: BudgetLimits | null) => void | Promise<void>;

const dependencyUrl = 'https://runtime-budget.invalid/assets/budget-editor-shared.js';
const moduleAddress: LazyModuleAddress = {
  url: 'https://runtime-budget.invalid/assets/UsagePanel-hash.js?v=build#usage',
  dependencies: [dependencyUrl],
};
const retryUrl = 'https://runtime-budget.invalid/assets/UsagePanel-hash.js?v=build&dramatis-retry=1#usage';
const secondRetryUrl = 'https://runtime-budget.invalid/assets/UsagePanel-hash.js?v=build&dramatis-retry=2#usage';

function createHookHost() {
  type Deps = readonly unknown[] | undefined;
  type Slot =
    | { kind: 'state'; value: unknown; set: (next: unknown) => void }
    | { kind: 'ref'; value: { current: unknown } }
    | { kind: 'memo'; value: unknown; deps: Deps }
    | { kind: 'effect' };
  const stores = new Map<string, Slot[]>();
  let active: { slots: Slot[]; cursor: number } | null = null;
  const frame = () => {
    if (active === null) throw new Error('hook called outside controlled render');
    return active;
  };
  return {
    unmount(name: string) {
      if (active !== null) throw new Error('cannot unmount during controlled render');
      stores.delete(name);
    },
    render<T>(name: string, render: () => T): T {
      if (active !== null) throw new Error('nested controlled render');
      const slots = stores.get(name) ?? [];
      stores.set(name, slots);
      active = { slots, cursor: 0 };
      try {
        return render();
      } finally {
        active = null;
      }
    },
    state(initial: unknown) {
      const { slots } = frame();
      const index = frame().cursor++;
      let slot = slots[index];
      if (slot && slot.kind !== 'state') throw new Error('state hook order changed');
      if (!slot) {
        const cell: Extract<Slot, { kind: 'state' }> = {
          kind: 'state',
          value: typeof initial === 'function' ? initial() : initial,
          set(next: unknown) {
            cell.value = typeof next === 'function' ? next(cell.value) : next;
          },
        };
        slot = cell;
        slots[index] = cell;
      }
      return [slot.value, slot.set];
    },
    ref(initial: unknown) {
      const { slots } = frame();
      const index = frame().cursor++;
      let slot = slots[index];
      if (slot && slot.kind !== 'ref') throw new Error('ref hook order changed');
      if (!slot) slots[index] = slot = { kind: 'ref', value: { current: initial } };
      return slot.value;
    },
    memo(create: () => unknown, deps?: readonly unknown[]) {
      const { slots } = frame();
      const index = frame().cursor++;
      const previous = slots[index];
      if (previous && previous.kind !== 'memo') throw new Error('memo hook order changed');
      if (
        previous?.deps !== undefined &&
        deps !== undefined &&
        previous.deps.length === deps.length &&
        deps.every((value, i) => Object.is(value, previous.deps?.[i]))
      )
        return previous.value;
      const value = create();
      slots[index] = { kind: 'memo', value, deps: deps?.slice() };
      return value;
    },
    effect() {
      // Focus effects are deliberately outside this harness; do not access a document/database.
      const { slots } = frame();
      const index = frame().cursor++;
      if (slots[index] && slots[index]?.kind !== 'effect') throw new Error('effect hook order changed');
      slots[index] = { kind: 'effect' };
    },
  };
}

function summary(): UsageSummary {
  return {
    total: {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      tokens: 0,
      cost: null,
      pricedCalls: 0,
      currency: null,
      costs: [],
      calibration: { calls: 0, estimated: 0, actual: 0 },
    },
    byCategory: [],
    bySpeaker: [],
    byModel: [],
    firstAt: null,
    lastAt: null,
  };
}

function fixtureProps() {
  const noop = () => {};
  const budget: BudgetState = {
    extraCalls: 0,
    cost: null,
    remainingCalls: null,
    remainingCost: null,
    burned: false,
    reason: null,
  };
  const budgetLimits: BudgetLimits = { maxExtraCalls: 5, maxCostByCurrency: { USD: 10 } };
  const onSaveBudget: Save = noop;
  return {
    open: true,
    focusOnOpen: false,
    onClose: noop,
    scene: null,
    instances: [],
    memories: [],
    conversations: [],
    activeConversationId: null,
    personas: [],
    personaId: null,
    playerName: 'Test player',
    chapters: [],
    attachedWorldBooks: [],
    libraryCards: [],
    worldCards: [],
    prompt: null,
    pending: 0,
    extraCalls: 0,
    usage: { world: summary(), conversation: summary(), latestTurn: summary() },
    budget,
    budgetLimits,
    onSaveBudget,
    conversationTitle: 'Test conversation',
    workerError: null,
    disabled: false,
    onSceneChange: noop,
    onStartNewScene: noop,
    onSetPresence: noop,
    onSelectPersona: noop,
    onRenameInstance: noop,
    onRemoveInstance: noop,
    onAddInstance: noop,
    onDetachWorldBook: noop,
    onUpdateMemory: noop,
    onDeleteMemory: noop,
    onLocateMemory: noop,
  };
}

type RuntimeProps = ReturnType<typeof fixtureProps> & { worldId?: string | null };
type UsageProps = Pick<RuntimeProps, 'worldId' | 'budget' | 'onSaveBudget' | 'conversationTitle'> & {
  world: UsageSummary | null;
  conversation: UsageSummary | null;
  latestTurn: UsageSummary | null;
  limits: BudgetLimits | null;
};
type UsageModule = { UsagePanel: React.ComponentType<UsageProps> };
type LazyProps = {
  load: () => Promise<{ default: React.ComponentType<UsageProps> }>;
  panelProps: UsageProps;
  label: string;
};
type BoundaryProps = { label: string; retry: () => void; children: Tree };
type BoundaryClass = {
  new (props: BoundaryProps): React.Component<BoundaryProps, { failed: boolean }>;
  getDerivedStateFromError(error: unknown): { failed: boolean };
};
type BoundaryElement = React.ReactElement<BoundaryProps>;
type SuspenseElement = React.ReactElement<{ fallback: Tree; children: React.ReactElement<UsageProps> }>;

function nodes(tree: Tree): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as Element;
  return [element, ...nodes(element.props.children as Tree)];
}
function textOf(tree: Tree): string {
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (tree === null || tree === undefined || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  return textOf((tree as Element).props.children as Tree);
}
function click(tree: Tree, label: string) {
  const button = nodes(tree).find((node) => node.type === 'button' && textOf(node) === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  return (button.props.onClick as () => void | Promise<void>)();
}
function suspenseOf(boundary: BoundaryElement): SuspenseElement {
  return boundary.props.children as SuspenseElement;
}
function boundaryError(boundary: BoundaryElement, error: unknown): Tree {
  // Invoke the real state/error handler, not pretend SSR performs DOM error reconciliation.
  const Boundary = boundary.type as unknown as BoundaryClass;
  const instance = new Boundary(boundary.props);
  instance.state = { ...instance.state, ...Boundary.getDerivedStateFromError(error) };
  return instance.render();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Model transport/cache behavior only. Never clear a failed native-module entry on reconnect.
function cachedNetwork(module: UsageModule) {
  let importFailure: Error | null = null;
  let dependencyOnline = true;
  let dependencyBody: Promise<void> | null = null;
  const modules = new Map<string, Promise<UsageModule>>();
  const http = new Map<string, number>();
  const imported: string[] = [];
  const fetched: { url: string; cache: RequestCache | undefined }[] = [];
  const bodies: string[] = [];
  return {
    modules,
    http,
    imported,
    fetched,
    bodies,
    failImports(error: Error) {
      importFailure = error;
    },
    recoverImports() {
      importFailure = null;
    },
    failDependency() {
      dependencyOnline = false;
    },
    recoverDependency() {
      dependencyOnline = true;
    },
    holdDependencyBody(gate: Promise<void>) {
      dependencyBody = gate;
    },
    async fetch(url: string, options: Pick<RequestInit, 'cache'>) {
      fetched.push({ url, cache: options.cache });
      let status = http.get(url);
      if (status === undefined || options.cache === 'reload') {
        status = url === dependencyUrl && !dependencyOnline ? 503 : 200;
        http.set(url, status);
      }
      return {
        ok: status === 200,
        status,
        async arrayBuffer() {
          if (url === dependencyUrl && dependencyBody !== null) await dependencyBody;
          bodies.push(url);
          return new ArrayBuffer(0);
        },
      };
    },
    import(url: string) {
      imported.push(url);
      const cached = modules.get(url);
      if (cached) return cached;
      // Native static imports still use the original dependency URLs and their HTTP cache.
      const cold = [url, ...moduleAddress.dependencies].some(
        (request) => http.get(request) !== 200 || !bodies.includes(request),
      );
      const pending = cold
        ? Promise.reject(new Error('original dependency response/body is not ready'))
        : importFailure
          ? Promise.reject(importFailure)
          : Promise.resolve(module);
      modules.set(url, pending);
      return pending;
    },
  };
}

async function createHarness() {
  const react = await vi.importActual<typeof React>(paths.react);
  const server = await vi.importActual<{ renderToString(tree: Tree): string }>(paths.server);
  const actualLoader = await vi.importActual<{ createLazyModule: typeof createLazyModule }>(paths.loader);
  const hooks = createHookHost();
  const props: RuntimeProps = fixtureProps();
  const usage = vi.fn((received: UsageProps) =>
    react.createElement('div', { 'data-usage-ready': true }, received.conversationTitle),
  );
  const network = cachedNetwork({ UsagePanel: usage });
  const createLoader = vi.fn(
    (address: LazyModuleAddress, select: (module: UsageModule) => React.ComponentType<UsageProps>) =>
      actualLoader.createLazyModule(address, select, network),
  );
  // Keep the real budget hook while avoiding a cold transform of every Core barrel export per worker.
  vi.doMock('@dramatis/core', () => vi.importActual<typeof import('./budget-editor.js')>(paths.budgetEditor));
  // This adapter ONLY injects the real loader's supported network argument; no retry logic is mocked.
  vi.doMock(paths.loader, () => ({ createLazyModule: createLoader }));
  vi.doMock(paths.address, () => ({ default: moduleAddress }));
  vi.doMock(paths.usage, () => {
    throw new Error('RuntimePanel bypassed the retry-aware module loader');
  });
  vi.doMock(paths.react, () => ({
    ...react,
    useState: hooks.state,
    useRef: hooks.ref,
    useMemo: hooks.memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => hooks.memo(() => callback, deps),
    useEffect: hooks.effect,
  }));
  const empty = () => null;
  vi.doMock(paths.counter, () => ({ countRender: () => {} }));
  vi.doMock(paths.cast, () => ({ CastPanel: empty }));
  vi.doMock(paths.icons, () => ({ IconChart: empty, IconDocument: empty, IconMemory: empty, IconScene: empty }));
  vi.doMock(paths.memory, () => ({ MemoryPanel: empty }));
  vi.doMock(paths.prompt, () => ({ PromptInspector: empty }));
  vi.doMock(paths.scene, () => ({ ScenePanel: empty }));
  // String arguments keep core's no-JSX type configuration unchanged; Vite executes the real TSX.
  const { RuntimePanel } = await vi.importActual<{
    RuntimePanel: React.MemoExoticComponent<(props: RuntimeProps) => Tree>;
  }>(paths.runtime);
  const { LazyPanel } = await vi.importActual<{ LazyPanel(props: LazyProps): Tree }>(paths.lazy);
  const render = (overrides: Partial<RuntimeProps> = {}) =>
    hooks.render('runtime', () => RuntimePanel.type({ ...props, ...overrides }));
  const findPanel = (tree: Tree) =>
    nodes(tree).find((node) => node.type === LazyPanel) as React.ReactElement<LazyProps> | undefined;
  function renderUsage(overrides: Partial<RuntimeProps> = {}) {
    const tree = render(overrides);
    const panel = findPanel(tree);
    if (!panel) throw new Error('Usage tab did not mount the real LazyPanel');
    const boundary = hooks.render('lazy', () => LazyPanel(panel.props)) as BoundaryElement;
    const suspense = suspenseOf(boundary);
    return { tree, panel, boundary, suspense, html: server.renderToString(suspense) };
  }
  async function loaded(overrides: Partial<RuntimeProps> = {}) {
    await click(render(overrides), '用量');
    renderUsage(overrides);
    await vi.dynamicImportSettled();
    const view = renderUsage(overrides);
    expect(view.html).toContain('data-usage-ready');
    return view;
  }
  return {
    react,
    props,
    render,
    findPanel,
    renderUsage,
    loaded,
    usage,
    createLoader,
    network,
    unmountUsage: () => hooks.unmount('lazy'),
    imports: () => network.imported.length,
    received() {
      const received = usage.mock.lastCall?.[0];
      if (!received) throw new Error('Lazy UsagePanel has not rendered');
      return received;
    },
  };
}

let host: Awaited<ReturnType<typeof createHarness>>;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('fetch', () => {
    throw new Error('unexpected real network access in runtime-budget tests');
  });
  host = await createHarness();
});
afterEach(() => {
  for (const path of mockedPaths) vi.doUnmock(path);
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('RuntimePanel budget wiring through the real LazyPanel', () => {
  it('does not import UsagePanel at module initialization or on scene/memory/prompt tabs', async () => {
    expect(host.imports()).toBe(0);
    expect(host.createLoader).toHaveBeenCalledExactlyOnceWith(moduleAddress, expect.any(Function));
    expect(host.network.fetched).toEqual([]);
    let tree = host.render();
    for (const label of ['场景与阵容', '记忆', 'Prompt']) {
      await click(tree, label);
      tree = host.render();
      expect(host.findPanel(tree)).toBeUndefined();
    }
    await vi.dynamicImportSettled();
    expect(host.imports()).toBe(0);
    expect(host.network.fetched).toEqual([]);
    expect(host.usage).not.toHaveBeenCalled();
  });

  it('mounts the real LazyPanel on usage and displays its loading status before the dynamic module resolves', async () => {
    await click(host.render(), '用量');
    const panel = host.findPanel(host.render());
    expect(panel?.props.label).toBe('用量');
    expect(host.imports()).toBe(0);
    const pending = host.renderUsage();
    expect(pending.suspense.type).toBe(host.react.Suspense);
    const status = nodes(pending.suspense.props.fallback).find((node) => node.props.role === 'status');
    expect(status?.props.className).toBe('hint dialog-loading');
    expect(textOf(pending.suspense.props.fallback)).toContain('正在加载用量');
    expect(pending.html).not.toContain('data-usage-ready');
    await vi.dynamicImportSettled();
    expect(host.renderUsage().html).toContain('data-usage-ready');
    expect(host.imports()).toBe(1);
    expect(host.network.fetched).toEqual([
      { url: moduleAddress.url, cache: 'force-cache' },
      { url: dependencyUrl, cache: 'force-cache' },
    ]);
  });

  it('keeps the loader and mounted lazy component stable on unrelated RuntimePanel rerenders', async () => {
    const first = await host.loaded();
    const next = host.renderUsage({ playerName: 'Other player', conversationTitle: 'Renamed conversation' });
    expect(next.panel.props.load).toBe(first.panel.props.load);
    expect(next.suspense.props.children.type).toBe(first.suspense.props.children.type);
    expect(next.boundary.key).toBe(first.boundary.key);
    expect(host.received().conversationTitle).toBe('Renamed conversation');
    expect(host.createLoader).toHaveBeenCalledOnce();
    expect(host.imports()).toBe(1);
  });

  it.each([
    ['omitted', {}],
    ['null', { worldId: null }],
    ['explicit', { worldId: 'world-a' }],
  ] satisfies [string, Partial<RuntimeProps>][])(
    'forwards %s worldId without inferring identity from bills/limits',
    async (_label, overrides: Partial<RuntimeProps>) => {
      await host.loaded(overrides);
      expect(host.received().worldId).toBe(overrides.worldId);
      expect(host.received().world).toBe(host.props.usage.world);
      expect(host.received().limits).toBe(host.props.budgetLimits);
    },
  );

  it('forwards a world switch even when usage snapshots and budget limits keep the same references', async () => {
    const before = await host.loaded({ worldId: 'world-a' });
    expect(host.received().worldId).toBe('world-a');
    const after = host.renderUsage({ worldId: 'world-b' });
    expect(host.received().worldId).toBe('world-b');
    expect(host.received().world).toBe(host.props.usage.world);
    expect(host.received().limits).toBe(host.props.budgetLimits);
    expect(after.panel.props.load).toBe(before.panel.props.load);
    expect(host.imports()).toBe(1);
  });

  it('passes all usage and budget values through the two real wrappers by reference', async () => {
    await host.loaded();
    const received = host.received();
    expect(received.world).toBe(host.props.usage.world);
    expect(received.conversation).toBe(host.props.usage.conversation);
    expect(received.latestTurn).toBe(host.props.usage.latestTurn);
    expect(received.budget).toBe(host.props.budget);
    expect(received.limits).toBe(host.props.budgetLimits);
    expect(received.onSaveBudget).toBe(host.props.onSaveBudget);
  });

  it('returns the original pending save Promise and sends the original limits exactly once', async () => {
    const write = deferred<void>();
    const save = vi.fn<Save>(() => write.promise);
    await host.loaded({ worldId: 'world-a', onSaveBudget: save });
    const limits: BudgetLimits = { maxExtraCalls: 7, maxCostByCurrency: { USD: 12 } };
    expect(host.received().onSaveBudget).toBe(save);
    const completion = host.received().onSaveBudget(limits);
    expect(completion).toBe(write.promise);
    expect(save).toHaveBeenCalledExactlyOnceWith(limits);
    let settled = false;
    void write.promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    write.resolve();
    await expect(completion).resolves.toBeUndefined();
  });

  it('does not swallow or replace a rejected persistence Promise', async () => {
    const write = deferred<void>();
    const save = vi.fn<Save>(() => write.promise);
    await host.loaded({ worldId: 'world-a', onSaveBudget: save });
    const completion = host.received().onSaveBudget(null);
    expect(completion).toBe(write.promise);
    expect(host.received().onSaveBudget).toBe(save);
    expect(save).toHaveBeenCalledExactlyOnceWith(null);
    const failure = new Error('budget persistence rejected');
    const observed = expect(completion).rejects.toBe(failure);
    write.reject(failure);
    await observed;
  });

  it('preserves a legacy void callback and a null clearing request', async () => {
    const save = vi.fn<Save>(() => {});
    await host.loaded({ onSaveBudget: save });
    expect(host.received().onSaveBudget).toBe(save);
    expect(host.received().onSaveBudget(null)).toBeUndefined();
    expect(save).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('recovers through the real loader and retry button while the original module URL remains cached as failed', async () => {
    const failure = new Error('cached native module failure');
    host.network.failImports(failure);
    await click(host.render(), '用量');
    const failed = host.renderUsage({ worldId: 'world-a' });
    await vi.dynamicImportSettled();
    expect(host.renderUsage({ worldId: 'world-a' }).html).not.toContain('data-usage-ready');
    expect(host.network.imported).toEqual([moduleAddress.url]);
    const cachedFailure = host.network.modules.get(moduleAddress.url);
    await expect(cachedFailure).rejects.toBe(failure);
    expect(host.usage).not.toHaveBeenCalled();
    const Boundary = failed.boundary.type as unknown as BoundaryClass;
    expect(Boundary.prototype).toBeInstanceOf(host.react.Component);
    const errorTree = boundaryError(failed.boundary, failure);
    expect(nodes(errorTree).some((node) => node.props.role === 'alert')).toBe(true);
    expect(textOf(errorTree)).toContain('用量加载失败');
    expect(nodes(failed.tree).some((node) => node.type === 'nav')).toBe(true);

    host.network.recoverImports(); // Do not evict or replace the failed module promise.
    await expect(cachedFailure).rejects.toBe(failure);
    await click(errorTree, '重试加载');
    const retry = host.renderUsage({ worldId: 'world-a' });
    expect(retry.boundary.key).not.toBe(failed.boundary.key);
    expect(retry.suspense.props.children.type).not.toBe(failed.suspense.props.children.type);
    expect(retry.panel.props.load).toBe(failed.panel.props.load);
    expect(new Boundary(retry.boundary.props).state.failed).toBe(false);
    await vi.dynamicImportSettled();
    expect(host.renderUsage({ worldId: 'world-a' }).html).toContain('data-usage-ready');
    expect(host.network.imported).toEqual([moduleAddress.url, retryUrl]);
    expect(host.network.modules.get(moduleAddress.url)).toBe(cachedFailure);
    await expect(cachedFailure).rejects.toBe(failure);
    expect(host.network.fetched).toEqual([
      { url: moduleAddress.url, cache: 'force-cache' },
      { url: dependencyUrl, cache: 'force-cache' },
      { url: retryUrl, cache: 'reload' },
      { url: dependencyUrl, cache: 'reload' },
    ]);
    expect(host.received().worldId).toBe('world-a');
    expect(host.createLoader).toHaveBeenCalledOnce();
  });

  it('uses a third URL after two cached import failures without replacing the stable loader', async () => {
    const failure = new Error('module still unavailable');
    host.network.failImports(failure);
    await click(host.render(), '用量');
    const first = host.renderUsage();
    await vi.dynamicImportSettled();
    await click(boundaryError(first.boundary, failure), '重试加载');
    const second = host.renderUsage();
    await vi.dynamicImportSettled();
    expect(host.network.imported).toEqual([moduleAddress.url, retryUrl]);
    const originalFailure = host.network.modules.get(moduleAddress.url);
    const retryFailure = host.network.modules.get(retryUrl);
    host.network.recoverImports();
    await expect(originalFailure).rejects.toBe(failure);
    await expect(retryFailure).rejects.toBe(failure);
    await click(boundaryError(second.boundary, failure), '重试加载');
    const third = host.renderUsage();
    await vi.dynamicImportSettled();
    expect(host.renderUsage().html).toContain('data-usage-ready');
    expect(third.panel.props.load).toBe(first.panel.props.load);
    expect(host.network.imported).toEqual([moduleAddress.url, retryUrl, secondRetryUrl]);
    expect(host.network.modules.get(moduleAddress.url)).toBe(originalFailure);
    expect(host.network.modules.get(retryUrl)).toBe(retryFailure);
    expect(host.createLoader).toHaveBeenCalledOnce();
  });

  it('preflights dependencies and refreshes a cached 503 at its original URL before retrying native import', async () => {
    host.network.failDependency();
    await click(host.render(), '用量');
    const failed = host.renderUsage();
    await vi.dynamicImportSettled();
    expect(host.renderUsage().html).not.toContain('data-usage-ready');
    expect(host.network.imported).toEqual([]);
    expect(host.network.http.get(dependencyUrl)).toBe(503);
    host.network.recoverDependency();
    expect(host.network.http.get(dependencyUrl)).toBe(503); // Reconnect alone must not clear HTTP cache.
    await click(boundaryError(failed.boundary, new Error('dependency 503')), '重试加载');
    host.renderUsage();
    await vi.dynamicImportSettled();
    expect(host.renderUsage().html).toContain('data-usage-ready');
    expect(host.network.http.get(dependencyUrl)).toBe(200);
    expect(host.network.imported).toEqual([retryUrl]);
    expect(host.network.fetched).toEqual([
      { url: moduleAddress.url, cache: 'force-cache' },
      { url: dependencyUrl, cache: 'force-cache' },
      { url: retryUrl, cache: 'reload' },
      { url: dependencyUrl, cache: 'reload' },
    ]);
  });

  it('shares a pending loader Promise and waits for dependency bodies before importing the module', async () => {
    const body = deferred<void>();
    host.network.holdDependencyBody(body.promise);
    await click(host.render(), '用量');
    const panel = host.findPanel(host.render());
    if (!panel) throw new Error('Usage tab did not mount LazyPanel');
    const first = panel.props.load();
    const second = panel.props.load();
    try {
      expect(second).toBe(first);
      await vi.waitFor(() => expect(host.network.fetched).toHaveLength(2));
      expect(host.network.imported).toEqual([]);
      expect(host.network.bodies).not.toContain(dependencyUrl);
      body.resolve();
      await expect(first).resolves.toEqual({ default: host.usage });
      expect(host.network.bodies).toContain(dependencyUrl);
      expect(host.network.imported).toEqual([moduleAddress.url]);
      expect(panel.props.load()).toBe(first);
      expect(host.network.fetched).toHaveLength(2);
    } finally {
      body.resolve();
    }
  });

  it('does not render usage off-tab and reuses the successful module after unmount/reopen', async () => {
    const first = await host.loaded();
    host.usage.mockClear();
    let tree = host.render();
    for (const label of ['记忆', 'Prompt', '场景与阵容']) {
      await click(tree, label);
      tree = host.render();
      expect(host.findPanel(tree)).toBeUndefined();
    }
    host.unmountUsage(); // Only hook slots are discarded; this is not a native lifecycle/scheduling test.
    await vi.dynamicImportSettled();
    expect(host.usage).not.toHaveBeenCalled();
    const reopened = await host.loaded();
    expect(reopened.suspense.props.children.type).not.toBe(first.suspense.props.children.type);
    expect(reopened.panel.props.load).toBe(first.panel.props.load);
    expect(host.network.imported).toEqual([moduleAddress.url]);
    expect(host.network.fetched).toHaveLength(2);
    expect(host.createLoader).toHaveBeenCalledOnce();
  });
});
