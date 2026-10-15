import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDialogController, type DialogGuard } from '../lib/dialog-controller';
import type { SyncApi } from '../lib/sync';
import { SyncPanel } from './SyncPanel';

const dialog = vi.hoisted(() => ({
  requestAction: (_action: () => void) => {},
  setGuard: (_guard: DialogGuard | null) => {},
}));
vi.mock('./DialogShell', () => ({ useDialogActions: () => dialog }));

// No DOM runtime is installed. Keep real component handlers and the dialog
// controller; control only React hook scheduling to test async scope changes.
const host = vi.hoisted(() => {
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
      const tasks = pending;
      pending = [];
      for (const task of tasks) task();
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
    effect(action: () => (() => void) | undefined, deps?: readonly unknown[]) {
      const index = effectCursor++;
      const previous = effects[index];
      if (!previous || !deps || !previous.deps || deps.some((value, i) => value !== previous.deps?.[i])) {
        pending.push(() => {
          previous?.cleanup?.();
          effects[index] = { deps, cleanup: action() };
        });
      }
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: host.state,
  useEffect: host.effect,
  useRef: (initial: unknown) => {
    const [ref] = host.state(() => ({ current: initial }));
    return ref;
  },
}));

function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as ReactElement<Record<string, unknown>>;
  return [element, ...nodes(element.props.children as ReactNode)];
}
function textOf(tree: ReactNode): string {
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (tree === null || tree === undefined || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  return textOf((tree as ReactElement<{ children: ReactNode }>).props.children);
}
function render(api: SyncApi, flush = true): ReactNode {
  host.begin();
  const tree = SyncPanel({ api, disabled: false });
  if (flush) host.flush();
  return tree;
}
function click(tree: ReactNode, label: string): void {
  const found = nodes(tree).find((node) => node.type === 'button' && textOf(node) === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  expect(found.props.disabled).toBe(false);
  (found.props.onClick as () => void)();
}
function change(tree: ReactNode, id: string, value: string): void {
  const input = nodes(tree).find((node) => node.type === 'input' && node.props.id === id);
  if (!input) throw new Error(`Missing input: ${id}`);
  (input.props.onChange as (event: unknown) => void)({ target: { value } });
}
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const deviceResult = {
  devices: [{ deviceId: 'old-phone-000', records: 7, lastWriteAt: '2026-10-01T00:00:00Z' }],
  localDeviceId: 'local-browser',
};
function fixtureApi(): SyncApi {
  return {
    config: {
      endpoint: 'https://fixture.invalid/sync',
      userId: 'fixture-account',
      spaceHandle: 'fixture-space',
      keyMode: 'device',
      createdAt: '2026-10-01T00:00:00Z',
      lastSyncAt: null,
      lastReport: null,
    },
    status: 'ready',
    busy: false,
    error: null,
    errorStatus: null,
    recoveryCode: null,
    autoSyncPending: false,
    spaceFull: false,
    dismissRecoveryCode: () => {},
    connect: async () => {},
    syncNow: async () => {},
    resync: async () => {},
    requestAutoSync: () => {},
    disconnect: async () => {},
    setKeyMode: async () => {},
    listDevices: async () => deviceResult,
    rotatePassword: async () => {},
    exportSnapshot: async () => null,
    restoreSnapshot: async () => ({ pushed: 0, head: 0 }),
    sealSecret: async () => null,
    openSecret: async () => null,
  };
}
let controller: ReturnType<typeof createDialogController>;
beforeEach(() => {
  host.reset();
  controller = createDialogController();
  dialog.requestAction = controller.request;
  dialog.setGuard = controller.setGuard;
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { origin: 'https://fixture.invalid' } }));
  vi.stubGlobal('navigator', {});
});
afterEach(() => {
  host.reset();
  vi.unstubAllGlobals();
});

describe('同步面板范围与恢复流程', () => {
  it.each(['endpoint', 'spaceHandle'] as const)('切换%s立即隐藏旧设备，即使effects尚未执行', async (field) => {
    const api = fixtureApi();
    click(render(api), '看有哪些设备');
    await settle();
    expect(textOf(render(api))).toContain('设备 old-phon');
    api.config = { ...api.config!, [field]: `other-${field}` };
    const tree = render(api, false);
    expect(textOf(tree)).not.toContain('设备 old-phon');
    expect(textOf(tree)).toContain('尚未读取当前空间的设备列表');
  });

  it.each([false, true])('A读取迟到不能进入B，返回A=%s也不能复用上一代结果', async (returnToA) => {
    const api = fixtureApi();
    const pending = deferred<typeof deviceResult>();
    api.listDevices = () => pending.promise;
    click(render(api), '看有哪些设备');
    const configA = api.config;
    api.config = { ...configA!, spaceHandle: 'space-b' };
    render(api);
    if (returnToA) {
      api.config = configA;
      render(api);
    }
    pending.resolve(deviceResult);
    await settle();
    expect(textOf(render(api))).not.toContain('设备 old-phon');
    expect(textOf(render(api))).toContain('尚未读取当前空间的设备列表');
  });

  it('切换后旧请求失败不把失败说明带入新空间', async () => {
    const api = fixtureApi();
    const pending = deferred<typeof deviceResult>();
    api.listDevices = () => pending.promise;
    click(render(api), '看有哪些设备');
    api.config = { ...api.config!, spaceHandle: 'space-b' };
    render(api);
    pending.reject(new Error('old-scope-failure'));
    await settle();
    const tree = render(api);
    expect(textOf(tree)).not.toContain('old-scope-failure');
    expect(textOf(tree)).toContain('尚未读取当前空间的设备列表');
  });

  it('同空间刷新失败保留上次设备，同时明确本次读取失败', async () => {
    const api = fixtureApi();
    click(render(api), '看有哪些设备');
    await settle();
    const pending = deferred<typeof deviceResult>();
    api.listDevices = () => pending.promise;
    click(render(api), '刷新设备列表');
    expect(textOf(render(api))).toContain('正在读取当前空间的设备列表');
    pending.reject(new Error('device-network-failure'));
    await settle();
    const tree = render(api);
    expect(textOf(tree)).toContain('设备 old-phon');
    expect(textOf(tree)).toContain('读取失败，保留上次读取的设备列表');
    expect(
      nodes(tree).filter((node) => node.props.role === 'alert' && textOf(node).includes('device-network-failure')),
    ).toHaveLength(1);
  });

  it('未读取和成功读到空列表有不同状态', async () => {
    const api = fixtureApi();
    api.listDevices = async () => ({ devices: [], localDeviceId: 'local-browser' });
    expect(textOf(render(api))).toContain('尚未读取当前空间的设备列表');
    click(render(api), '看有哪些设备');
    await settle();
    const tree = render(api);
    expect(textOf(tree)).not.toContain('尚未读取当前空间的设备列表');
    expect(textOf(tree)).toContain('设备列表已读取');
    expect(textOf(tree)).toContain('服务端还没记下任何设备');
  });

  it('404指引靠近主错误，并能经高级断开与原ID开通进入恢复码守卫', async () => {
    const api = fixtureApi();
    api.error = 'fixture remote space missing';
    api.errorStatus = 404;
    api.status = 'error';
    const originalConfig = api.config!;
    api.disconnect = async () => {
      api.config = null;
      api.error = null;
      api.errorStatus = null;
      api.status = 'off';
    };
    api.connect = async (input) => {
      expect(input).toEqual({
        endpoint: originalConfig.endpoint,
        userId: originalConfig.userId,
        secret: 'fixture-new-password',
        keyMode: 'device',
      });
      api.config = originalConfig;
      api.recoveryCode = 'new-fixture-recovery';
      api.status = 'ready';
    };
    api.dismissRecoveryCode = () => {
      api.recoveryCode = null;
    };
    let tree = render(api);
    const alert = nodes(tree).find((node) => node.props.role === 'alert' && textOf(node).includes(api.error!));
    expect(textOf(alert)).toContain('高级');
    expect(textOf(alert)).toContain('断开同步');
    expect(textOf(alert)).toContain('原账户 ID');
    expect(textOf(alert)).toContain('新恢复码');
    expect(textOf(alert)).not.toContain('添加账户');
    click(tree, '断开同步（不影响本机数据，也不会删除服务端的数据）');
    await settle();
    tree = render(api);
    change(tree, 'sync-secret', 'fixture-new-password');
    click(render(api), '开通 / 加入并同步');
    await settle();
    tree = render(api);
    expect(textOf(tree)).toContain('new-fixture-recovery');
    let closed = false;
    controller.request(() => {
      closed = true;
    });
    expect(closed).toBe(false);
    expect(controller.state().pending?.guard.kind).toBe('recovery');
    controller.cancel();
    click(tree, '我已安全保存');
    controller.request(() => {
      closed = true;
    });
    expect(closed).toBe(true);
  });

  it('同一次错误只在主区播报一次', async () => {
    const api = fixtureApi();
    api.syncNow = async () => {
      api.error = 'fixture-sync-failure';
      throw new Error(api.error);
    };
    click(render(api), '立即同步');
    await settle();
    const tree = render(api);
    expect(
      nodes(tree).filter((node) => textOf(node.props.children as ReactNode) === 'fixture-sync-failure'),
    ).toHaveLength(1);
  });

  it('说明用React强调元素展示，不暴露裸Markdown', () => {
    const api = fixtureApi();
    expect(textOf(render(api))).not.toContain('**');
    api.config = null;
    expect(textOf(render(api))).not.toContain('**');
  });
});
