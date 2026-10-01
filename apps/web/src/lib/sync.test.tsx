import {
  createBackgroundRunner,
  createMemoryEntityStore,
  createSpaceCredentials,
  createUsageLedger,
  type RemoteSpaceMeta,
  Repository,
} from '@dramatis/core';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DramatisDb } from './db';
import { type SyncApi, useSync } from './sync';
import { createTaskQueueExtras } from './task-queue';

const server = vi.hoisted(() => ({
  meta: null as RemoteSpaceMeta | null,
  hash: '',
  insideLock: false,
  enforceLock: false,
  rejectRotation: false,
  rotateGate: null as Promise<void> | null,
  rotationStarted: null as (() => void) | null,
}));

vi.mock('@dramatis/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@dramatis/core')>();
  async function authenticate(input: { credential: string }) {
    if (!(await core.verifyCredential(input.credential, server.hash))) throw new Error('测试服务端凭证失效');
  }
  return {
    ...core,
    fetchRemoteSpace: async () => server.meta,
    createRemoteSpace: async (
      _options: unknown,
      input: { spaceHandle: string; credentialHash: string; keyWraps: Record<string, unknown> },
    ) => {
      server.hash = input.credentialHash;
      server.meta = { spaceHandle: input.spaceHandle, keyWraps: input.keyWraps, createdAt: '2026-10-01' };
      return 'created';
    },
    createHttpSyncTransport: () => ({
      async head(input: { credential: string }) {
        await authenticate(input);
        return { head: 0 };
      },
      async pull(input: { credential: string }) {
        await authenticate(input);
        return { head: 0, records: [], hasMore: false };
      },
      async push(input: { credential: string }) {
        await authenticate(input);
        return { head: 0, accepted: [] };
      },
      async rotate(input: { credential: string; credentialHash: string; passwordWrap: unknown }) {
        if (server.enforceLock && !server.insideLock) throw new Error('换密码没有进入同步互斥锁');
        await authenticate(input);
        server.rotationStarted?.();
        if (server.rotateGate !== null) await server.rotateGate;
        if (server.rejectRotation) throw new Error('测试服务端拒绝换密码');
        server.hash = input.credentialHash;
        if (server.meta !== null) server.meta.keyWraps.password = input.passwordWrap;
      },
    }),
  };
});

const oldPassword = 'test-old-password';
const newPassword = 'test-new-password';
let initial: Awaited<ReturnType<typeof createSpaceCredentials>>;
let values: Map<string, string>;

beforeAll(async () => {
  initial = await createSpaceCredentials({ userId: 'test-account', password: oldPassword });
});

beforeEach(() => {
  values = new Map();
  values.set(
    'dramatis.accounts.v2',
    JSON.stringify({
      version: 2,
      activeId: 'test-storage',
      accounts: [
        {
          id: 'test-storage',
          accountId: 'test-account',
          name: '测试账户',
          dbName: 'dramatis:acct:test-storage',
        },
      ],
    }),
  );
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal('navigator', {
    locks: {
      async request(_name: string, callback: () => Promise<unknown>) {
        server.insideLock = true;
        try {
          return await callback();
        } finally {
          server.insideLock = false;
        }
      },
    },
  });
  server.meta = {
    spaceHandle: initial.spaceHandle,
    keyWraps: { password: initial.passwordWrap, recovery: initial.recoveryWrap },
    createdAt: '2026-10-01',
  };
  server.hash = initial.credentialHash;
  server.insideLock = false;
  server.enforceLock = false;
  server.rejectRotation = false;
  server.rotateGate = null;
  server.rotationStarted = null;
});

afterEach(() => vi.unstubAllGlobals());

async function connectedApi(freshSpace = true): Promise<SyncApi> {
  const store = createMemoryEntityStore();
  const db: DramatisDb = {
    backendKind: store.kind,
    store,
    repository: new Repository(store),
    queue: createBackgroundRunner(store),
    ledger: createUsageLedger(store),
    tasks: createTaskQueueExtras(store),
  };
  let api: SyncApi | null = null;
  function Harness() {
    api = useSync(db);
    return null;
  }
  renderToString(createElement(Harness));
  const result = api as unknown as SyncApi;
  if (freshSpace) server.meta = null;
  await result.connect({
    endpoint: 'http://localhost/sync',
    userId: 'test-account',
    secret: oldPassword,
    keyMode: 'device',
  });
  return result;
}

describe('账户换密码复用同步互斥保护', () => {
  it('登录已有账户后可换密码并使用新凭证继续同步', async () => {
    const api = await connectedApi(false);
    await expect(api.rotatePassword(newPassword)).resolves.toBeUndefined();
    await expect(api.syncNow()).resolves.toBeUndefined();
    expect(JSON.parse(values.get('dramatis.keys.v1') ?? '{}')).toEqual({ 'sync:password:test-storage': newPassword });
  });

  it('换密码进入既有跨标签页锁，新凭证可继续同步且只保存新密码', async () => {
    const api = await connectedApi();
    server.enforceLock = true;
    await api.rotatePassword(newPassword);
    await expect(api.syncNow()).resolves.toBeUndefined();
    expect(JSON.parse(values.get('dramatis.keys.v1') ?? '{}')).toEqual({ 'sync:password:test-storage': newPassword });
  });

  it('换密码忙碌期间拒绝重复操作', async () => {
    const api = await connectedApi();
    let release: () => void = () => {};
    server.rotateGate = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      server.rotationStarted = resolve;
    });
    const first = api.rotatePassword(newPassword);
    await started;
    const second = api.rotatePassword('test-second-password');
    try {
      await expect(
        Promise.race([second, new Promise((resolve) => setTimeout(() => resolve('重复请求未拒绝'), 100))]),
      ).rejects.toThrow(/正在|忙/);
    } finally {
      release();
      await first;
      await second.catch(() => undefined);
    }
  });

  it('换密码期间排队的同步使用更新后的凭证', async () => {
    const api = await connectedApi(false);
    let release: () => void = () => {};
    server.rotateGate = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      server.rotationStarted = resolve;
    });
    const rotation = api.rotatePassword(newPassword);
    await started;
    const sync = api.syncNow();
    release();
    await rotation;
    await expect(sync).resolves.toBeUndefined();
  });

  it('服务端失败保持旧密码和凭证，之后可再次换密码', async () => {
    const api = await connectedApi();
    server.rejectRotation = true;
    await expect(api.rotatePassword(newPassword)).rejects.toThrow('拒绝换密码');
    expect(JSON.parse(values.get('dramatis.keys.v1') ?? '{}')).toEqual({ 'sync:password:test-storage': oldPassword });
    await expect(api.syncNow()).resolves.toBeUndefined();
    server.rejectRotation = false;
    await expect(api.rotatePassword(newPassword)).resolves.toBeUndefined();
    await expect(api.syncNow()).resolves.toBeUndefined();
  });
});
