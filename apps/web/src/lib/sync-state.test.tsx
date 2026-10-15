import {
  createBackgroundRunner,
  createMemoryEntityStore,
  createMemorySyncTransport,
  createSpaceCredentials,
  createUsageLedger,
  encryptRecord,
  type RemoteSpaceMeta,
  Repository,
  type SyncTransport,
} from '@dramatis/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DramatisDb } from './db';
import { SYNC_CONFIG_META_KEY, type SyncApi, useSync } from './sync';
import { createTaskQueueExtras } from './task-queue';

const remote = vi.hoisted(() => ({
  meta: null as RemoteSpaceMeta | null,
  transports: new Map<string, SyncTransport>(),
}));
vi.mock('@dramatis/core', async (original) => ({
  ...(await original<typeof import('@dramatis/core')>()),
  fetchRemoteSpace: async () => remote.meta,
  createHttpSyncTransport: ({ endpoint }: { endpoint: string }) => {
    const transport = remote.transports.get(endpoint);
    if (!transport) throw new Error('Missing fixture transport');
    return transport;
  },
}));

// Reuse the repository's no-DOM hook harness pattern. Keep the actual sync loop,
// scheduler, crypto, repository and operation callbacks; only observe hook state.
const hooks = vi.hoisted(() => {
  let values: unknown[] = [];
  let effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = [];
  let cursor = 0;
  let effectCursor = 0;
  let pending: (() => void)[] = [];
  return {
    reset() {
      for (const effect of effects) effect.cleanup?.();
      values = [];
      effects = [];
      pending = [];
    },
    begin() {
      cursor = 0;
      effectCursor = 0;
    },
    flush() {
      const next = pending;
      pending = [];
      for (const action of next) action();
    },
    state(initial: unknown) {
      const index = cursor++;
      if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
      return [
        values[index],
        (next: unknown) => {
          values[index] = typeof next === 'function' ? next(values[index]) : next;
        },
      ];
    },
    memo(value: unknown, deps: readonly unknown[]) {
      const index = cursor++;
      const previous = values[index] as { value: unknown; deps: readonly unknown[] } | undefined;
      if (!previous || deps.some((item, i) => previous.deps[i] !== item)) values[index] = { value, deps };
      return (values[index] as { value: unknown }).value;
    },
    effect(action: () => (() => void) | undefined, deps?: readonly unknown[]) {
      const index = effectCursor++;
      const previous = effects[index];
      if (!previous || !deps || !previous.deps || deps.some((item, i) => previous.deps?.[i] !== item))
        pending.push(() => {
          previous?.cleanup?.();
          effects[index] = { deps, cleanup: action() };
        });
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: hooks.state,
  useEffect: hooks.effect,
  useCallback: hooks.memo,
  useMemo: (factory: () => unknown, deps: readonly unknown[]) => {
    const cached = hooks.memo({ factory }, deps) as { factory: () => unknown; value?: unknown };
    if (!('value' in cached)) cached.value = cached.factory();
    return cached.value;
  },
  useRef: (initial: unknown) => {
    const [ref] = hooks.state(() => ({ current: initial }));
    return ref;
  },
}));

const endpoint = 'http://fixture.invalid/sync';
const password = 'fixture-sync-password';
let auth: Awaited<ReturnType<typeof createSpaceCredentials>>;
let values: Map<string, string>;

beforeAll(async () => {
  auth = await createSpaceCredentials({ userId: 'fixture-sync-account', password });
});
beforeEach(() => {
  hooks.reset();
  values = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('document', { visibilityState: 'visible' });
  vi.stubGlobal('window', { setInterval, clearInterval });
  remote.transports.clear();
  remote.meta = {
    spaceHandle: auth.spaceHandle,
    keyWraps: { password: auth.passwordWrap, recovery: auth.recoveryWrap },
    createdAt: '2026-10-10T00:00:00Z',
  };
});
afterEach(() => {
  hooks.reset();
  vi.unstubAllGlobals();
});

function database(): DramatisDb {
  const store = createMemoryEntityStore();
  return {
    backendKind: store.kind,
    store,
    repository: new Repository(store),
    queue: createBackgroundRunner(store),
    ledger: createUsageLedger(store),
    tasks: createTaskQueueExtras(store),
  };
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(onChanged: () => void = () => {}) {
  let db = database();
  let changed = onChanged;
  const server = createMemorySyncTransport(auth);
  let transport: SyncTransport = server.transport;
  remote.transports.set(endpoint, {
    head: (input) => transport.head(input),
    pull: (input) => transport.pull(input),
    push: (input) => transport.push(input),
  });
  const render = () => {
    hooks.begin();
    useSync(db, { onChanged: changed });
    hooks.flush();
    hooks.begin();
    const result = useSync(db, { onChanged: changed });
    hooks.flush();
    return result;
  };
  await render().connect({ endpoint, userId: 'fixture-sync-account', secret: password, keyMode: 'session' });
  return {
    db,
    server,
    render,
    setTransport(next: SyncTransport) {
      transport = next;
    },
    changeAccount(next: DramatisDb, nextChanged: () => void) {
      db = next;
      changed = nextChanged;
      return render();
    },
  };
}
async function finished(render: () => SyncApi) {
  await vi.waitFor(() => expect(render().autoSyncPending).toBe(false), { timeout: 5000, interval: 5 });
}

describe('同步状态与失败后的本地刷新', () => {
  it('已保存连接启动时远端空间不存在，保留404供恢复指引识别', async () => {
    const f = await fixture();
    await f.render().connect({ endpoint, userId: 'fixture-sync-account', secret: password, keyMode: 'device' });
    remote.meta = null;
    hooks.reset();
    f.render();
    await vi.waitFor(() => expect(f.render().status).toBe('error'));
    expect(f.render().errorStatus).toBe(404);
    expect(f.render().config?.spaceHandle).toBe(auth.spaceHandle);
  });
  it('手动失败后自动补推成功，状态与错误一起恢复', async () => {
    const f = await fixture();
    f.setTransport({
      ...f.server.transport,
      head: async () => {
        throw new Error('fixture offline');
      },
    });
    await expect(f.render().syncNow()).rejects.toThrow('fixture offline');
    expect(f.render().status).toBe('error');
    f.setTransport(f.server.transport);
    f.render().requestAutoSync();
    await finished(f.render);
    expect(f.render().error).toBeNull();
    expect(f.render().status).toBe('ready');
  });

  it('自动失败发布错误状态并保留上一次成功报告', async () => {
    const f = await fixture();
    const previous = f.render().config?.lastReport;
    f.setTransport({
      ...f.server.transport,
      head: async () => {
        throw new Error('fixture outbox failure');
      },
    });
    f.render().requestAutoSync();
    await finished(f.render);
    expect(f.render().error).toBe('fixture outbox failure');
    expect(f.render().status).toBe('error');
    expect(f.render().config?.lastReport).toEqual(previous);
  });

  it('成功报告持久化失败时保留旧配置并仍通知刷新', async () => {
    let changed = 0;
    const f = await fixture(() => changed++);
    changed = 0;
    const previous = f.render().config;
    const write = f.db.repository.setMeta.bind(f.db.repository);
    const failure = new Error('fixture report persistence failure');
    vi.spyOn(f.db.repository, 'setMeta').mockImplementation(async (key, value) => {
      if (key === SYNC_CONFIG_META_KEY) throw failure;
      await write(key, value);
    });
    await expect(f.render().syncNow()).rejects.toBe(failure);
    expect(f.render().config).toBe(previous);
    expect(f.render().status).toBe('error');
    expect(f.render().error).toBe(failure.message);
    expect(changed).toBe(1);
  });

  it('拉取已落盘后下一页失败仍刷新，刷新自身失败不替换原同步错误', async () => {
    let changed = 0;
    let refreshThrows = false;
    const f = await fixture(() => {
      changed++;
      if (refreshThrows) throw new Error('fixture refresh failure');
    });
    changed = 0;
    refreshThrows = true;
    const id = 'fixture-remote-card';
    const updatedAt = '2026-10-10T00:00:00.000Z';
    await f.server.transport.push({
      ...auth,
      records: [
        {
          collection: 'cards',
          id,
          updatedAt,
          deletedAt: null,
          sealed: await encryptRecord(
            auth.encKey,
            { spaceHandle: auth.spaceHandle, collection: 'cards', id, updatedAt },
            { id, name: 'new remote card', updatedAt, deletedAt: null },
          ),
        },
      ],
    });
    const failure = new Error('fixture next-page failure');
    let pages = 0;
    f.setTransport({
      ...f.server.transport,
      pull: async (input) => {
        if (pages++ > 0) throw failure;
        return { ...(await f.server.transport.pull(input)), hasMore: true };
      },
    });
    const previous = f.render().config?.lastReport;
    await expect(f.render().syncNow()).rejects.toBe(failure);
    expect((await f.db.repository.getSyncRecord('cards', id))?.value).toMatchObject({ name: 'new remote card' });
    expect(changed).toBe(1);
    expect(f.render().error).toBe(failure.message);
    expect(f.render().status).toBe('error');
    expect(f.render().config?.lastReport).toEqual(previous);
  });

  it.each(['success', 'failure'] as const)('断开后旧自动同步迟到%s不会复活配置或错误', async (outcome) => {
    let changed = 0;
    const f = await fixture(() => changed++);
    changed = 0;
    const started = deferred();
    const release = deferred();
    f.setTransport({
      ...f.server.transport,
      head: async (input) => {
        started.resolve();
        await release.promise;
        if (outcome === 'failure') throw new Error('fixture late failure');
        return f.server.transport.head(input);
      },
    });
    f.render().requestAutoSync();
    await started.promise;
    await f.render().disconnect();
    release.resolve();
    await finished(f.render);
    expect(f.render().config).toBeNull();
    expect(f.render().status).toBe('off');
    expect(f.render().error).toBeNull();
    expect(await f.db.repository.getMeta(SYNC_CONFIG_META_KEY)).toBeNull();
    expect(changed).toBe(0);
  });

  it('切换账户后旧手动同步完成不覆盖新账户状态或调用新账户刷新', async () => {
    const f = await fixture();
    const started = deferred();
    const release = deferred();
    f.setTransport({
      ...f.server.transport,
      head: async (input) => {
        started.resolve();
        await release.promise;
        return f.server.transport.head(input);
      },
    });
    const running = f.render().syncNow();
    await started.promise;
    const nextDb = database();
    let newAccountRefreshes = 0;
    f.changeAccount(nextDb, () => newAccountRefreshes++);
    release.resolve();
    await running;
    expect(f.render().config).toBeNull();
    expect(f.render().status).toBe('off');
    expect(f.render().error).toBeNull();
    expect(newAccountRefreshes).toBe(0);
    expect(await nextDb.repository.getMeta(SYNC_CONFIG_META_KEY)).toBeNull();
  });

  it('旧自动成功不能清除较新连接操作的错误', async () => {
    const f = await fixture();
    const started = deferred();
    const release = deferred();
    f.setTransport({
      ...f.server.transport,
      head: async (input) => {
        started.resolve();
        await release.promise;
        return f.server.transport.head(input);
      },
    });
    f.render().requestAutoSync();
    await started.promise;
    await expect(
      f
        .render()
        .connect({ endpoint: 'http://other.fixture.invalid/sync', userId: 'other', secret: '', keyMode: 'session' }),
    ).rejects.toThrow('请填同步密码');
    const newerError = f.render().error;
    release.resolve();
    await finished(f.render);
    expect(f.render().error).toBe(newerError);
    expect(f.render().status).toBe('error');
  });

  it.each(['success', 'failure'] as const)('改连新服务端后旧自动同步迟到%s不会覆盖新连接', async (outcome) => {
    let changed = 0;
    const f = await fixture(() => changed++);
    changed = 0;
    const started = deferred();
    const release = deferred();
    f.setTransport({
      ...f.server.transport,
      head: async (input) => {
        started.resolve();
        await release.promise;
        if (outcome === 'failure') throw new Error('fixture old endpoint failure');
        return f.server.transport.head(input);
      },
    });
    f.render().requestAutoSync();
    await started.promise;
    const nextEndpoint = 'http://next.fixture.invalid/sync';
    const nextServer = createMemorySyncTransport(auth);
    const nextStarted = deferred();
    const nextRelease = deferred();
    remote.transports.set(nextEndpoint, {
      ...nextServer.transport,
      head: async (input) => {
        nextStarted.resolve();
        await nextRelease.promise;
        return nextServer.transport.head(input);
      },
    });
    const connecting = f.render().connect({
      endpoint: nextEndpoint,
      userId: 'fixture-sync-account',
      secret: password,
      keyMode: 'session',
    });
    await vi.waitFor(() => expect(f.render().config?.endpoint).toBe(nextEndpoint));
    release.resolve();
    await nextStarted.promise;
    expect(f.render().config?.endpoint).toBe(nextEndpoint);
    expect(f.render().error).toBeNull();
    expect(f.render().status).toBe('ready');
    expect(changed).toBe(0);
    nextRelease.resolve();
    await connecting;
    expect(f.render().config?.endpoint).toBe(nextEndpoint);
    expect(f.render().status).toBe('ready');
    expect(changed).toBe(1);
  });
});
