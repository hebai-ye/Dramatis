import { roomId, type Scene, sceneId } from '@dramatis/core';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScenePanel } from '../components/ScenePanel';
import { flushDraftFields, useDraftField } from './useDraftField';

// Invoke the real hook handlers with controlled hook storage and browser timers.
const host = vi.hoisted(() => {
  let values: unknown[] = [],
    cursor = 0,
    effectCursor = 0;
  let effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = [];
  let pending: (() => void)[] = [];
  return {
    begin() {
      cursor = 0;
      effectCursor = 0;
    },
    flush() {
      const runs = pending;
      pending = [];
      for (const run of runs) run();
    },
    reset() {
      for (const effect of effects) effect.cleanup?.();
      values = [];
      effects = [];
      pending = [];
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
    effect(run: () => (() => void) | undefined, deps?: readonly unknown[]) {
      const index = effectCursor++,
        previous = effects[index];
      if (
        previous?.deps &&
        deps &&
        deps.length === previous.deps.length &&
        deps.every((value, i) => Object.is(value, previous.deps?.[i]))
      )
        return;
      pending.push(() => {
        previous?.cleanup?.();
        effects[index] = { deps, cleanup: run() };
      });
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: host.state,
  useRef: (initial: unknown) => host.state(() => ({ current: initial }))[0],
  useEffect: host.effect,
  useCallback: (callback: unknown) => callback,
}));

function gate() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function render(options: Parameters<typeof useDraftField>[0]) {
  host.begin();
  // biome-ignore lint/correctness/useHookAtTopLevel: Controlled hook host invokes the real hook handlers without jsdom.
  const field = useDraftField(options);
  host.flush();
  return field;
}
function change(field: ReturnType<typeof useDraftField>, value: string) {
  field.bind.onChange({ target: { value }, nativeEvent: {} } as Parameters<typeof field.bind.onChange>[0]);
}
beforeEach(() => {
  host.reset();
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
});
afterEach(() => {
  host.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ordinary automatic edit saves', () => {
  it('shows pending until the actual write settles and retains a failed draft on blur', async () => {
    const deferred = gate();
    const options = { value: '旧地点', commit: () => deferred.promise, scope: 'scene-a' };
    let field = render(options);
    field.bind.onFocus();
    change(field, '新地点');
    field = render(options);
    expect(field.status).toBe('pending');
    field.bind.onBlur();
    field = render(options);
    expect(field.status).toBe('saving');
    deferred.reject(new Error('磁盘写入失败'));
    await vi.runAllTimersAsync();
    field = render(options);
    expect(field.status).toBe('error');
    expect(field.error).toBe('磁盘写入失败');
    expect(field.bind.value).toBe('新地点');
    expect(field.dirty).toBe(true);
  });

  it('serializes a slow write and commits only the latest queued text', async () => {
    const first = gate(),
      second = gate();
    const writes: string[] = [],
      stored: string[] = [];
    const options = {
      value: '原稿',
      scope: 'scene-a',
      commit: async (next: string) => {
        writes.push(next);
        await (writes.length === 1 ? first.promise : second.promise);
        stored.push(next);
      },
    };
    let field = render(options);
    change(field, '稿一');
    const saving = field.flush();
    change(field, '稿二');
    change(field, '最终稿');
    await vi.advanceTimersByTimeAsync(300);
    expect(writes).toEqual(['稿一']);
    expect(render(options).bind.value).toBe('最终稿');
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual(['稿一', '最终稿']);
    second.resolve();
    await saving;
    field = render(options);
    expect(stored).toEqual(['稿一', '最终稿']);
    expect(field.status).toBe('saved');
    expect(field.dirty).toBe(false);
  });

  it('retries the identical failed value instead of treating it as saved', async () => {
    let attempts = 0,
      stored = '原稿';
    const options = {
      value: '原稿',
      scope: 'scene-a',
      commit: (next: string) => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error('无法保存'));
        stored = next;
      },
    };
    let field = render(options);
    change(field, '保留稿');
    expect(await field.flush()).toBe(false);
    field = render(options);
    expect(field.bind.value).toBe('保留稿');
    expect(await field.flush()).toBe(true);
    expect(stored).toBe('保留稿');
    expect(render(options).status).toBe('saved');
  });

  it('does not leave a synchronously rejected write stuck in saving', async () => {
    let attempts = 0;
    const options = {
      value: '旧名',
      scope: 'cast-a',
      commit: () => {
        attempts++;
        if (attempts === 1) throw new Error('显示名不能为空');
      },
    };
    const field = render(options);
    change(field, '新名');
    expect(await field.flush()).toBe(false);
    expect(render(options).status).toBe('error');
    expect(await render(options).flush()).toBe(true);
    expect(render(options).status).toBe('saved');
  });

  it('never sends a queued old-scope draft through the new target callback', async () => {
    const deferred = gate(),
      writes: string[] = [];
    const options = {
      value: 'A',
      scope: 'scene-a',
      commit: async (next: string) => {
        writes.push(`A:${next}`);
        await deferred.promise;
      },
    };
    let field = render(options);
    change(field, 'A第一稿');
    const saving = field.flush();
    change(field, 'A后续稿');
    await vi.advanceTimersByTimeAsync(300);
    field = render({
      value: 'B',
      scope: 'scene-b',
      commit: (next) => {
        writes.push(`B:${next}`);
      },
    });
    expect(field.bind.value).toBe('B');
    deferred.resolve();
    await saving;
    expect(writes).toEqual(['A:A第一稿']);
    expect(render({ value: 'B', scope: 'scene-b', commit: () => {} }).status).toBe('saved');
  });

  it('does not save during IME composition and flush reports that leaving is blocked', async () => {
    let stored = '原稿';
    const options = {
      value: '原稿',
      scope: 'scene-a',
      commit: (next: string) => {
        stored = next;
      },
    };
    const field = render(options);
    field.bind.onCompositionStart();
    change(field, '组字');
    await vi.advanceTimersByTimeAsync(1000);
    expect(stored).toBe('原稿');
    expect(await field.flush()).toBe(false);
    field.bind.onCompositionEnd();
    expect(await field.flush()).toBe(true);
    expect(stored).toBe('组字');
  });

  it('also blocks blur saves when the browser only marks native composing events', async () => {
    let stored = '原稿';
    const options = {
      value: '原稿',
      scope: 'scene-a',
      commit: (next: string) => {
        stored = next;
      },
    };
    const field = render(options);
    field.bind.onChange({
      target: { value: '未完成的组字' },
      nativeEvent: { isComposing: true },
    } as unknown as Parameters<typeof field.bind.onChange>[0]);
    field.bind.onBlur();
    expect(await field.flush()).toBe(false);
    expect(stored).toBe('原稿');
    field.bind.onChange({
      target: { value: '完成的文字' },
      nativeEvent: { isComposing: false },
    } as unknown as Parameters<typeof field.bind.onChange>[0]);
    expect(await field.flush()).toBe(true);
    expect(stored).toBe('完成的文字');
  });

  it('settles the leave guard when an unsaved target disappears', async () => {
    const field = render({ value: '原稿', scope: 'cast-a', commit: () => {} });
    change(field, '未保存的稿');
    host.reset();
    const realFlush = field.flush;
    let attempts = 0;
    field.flush = () => {
      if (++attempts > 2) throw new Error('An inactive target must not be retried indefinitely');
      return realFlush();
    };
    expect(await flushDraftFields([field], async () => true)).toBe(false);
  });
});

function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as ReactElement<Record<string, unknown>>;
  return [node, ...nodes(node.props.children as ReactNode)];
}
function requireNode(node: ReactElement<Record<string, unknown>> | undefined) {
  if (!node) throw new Error('Missing field fixture');
  return node;
}
function panel(props: Parameters<typeof ScenePanel>[0]) {
  host.begin();
  const tree = ScenePanel(props);
  host.flush();
  return tree;
}
const scene: Scene = {
  id: sceneId('scene-a'),
  roomId: roomId('world-a'),
  conversationId: null,
  title: '原场景',
  location: '原地点',
  worldTime: '原时间',
  summary: '原设定',
  castPolicy: 'locked',
  cast: [],
  createdAt: '',
  updatedAt: '',
  endedAt: null,
  deletedAt: null,
};

describe('scene edits share a serial write queue and leave guard', () => {
  it('does not let different fields concurrently overwrite their shared snapshot', async () => {
    const first = gate(),
      calls: Partial<Scene>[] = [];
    let stored = scene;
    const props = {
      scene,
      disabled: false,
      onStartNewScene: () => {},
      onChange: async (patch: Partial<Scene>) => {
        calls.push(patch);
        const next = { ...stored, ...patch };
        if (calls.length === 1) await first.promise;
        stored = next;
      },
    };
    const fields = nodes(panel(props)).filter((node) => node.type === 'input');
    (requireNode(fields[0]).props.onChange as (event: unknown) => void)({
      target: { value: '最新地点' },
      nativeEvent: {},
    });
    (requireNode(fields[1]).props.onChange as (event: unknown) => void)({
      target: { value: '最新时间' },
      nativeEvent: {},
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toEqual([{ location: '最新地点' }]);
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(stored.location).toBe('最新地点');
    expect(stored.worldTime).toBe('最新时间');
  });

  it('flushes the last debounced text before leaving and blocks leaving on failure', async () => {
    let beforeLeave: (() => Promise<boolean>) | null = null;
    const deferred = gate();
    const props = {
      scene,
      disabled: false,
      onStartNewScene: () => {},
      onChange: () => deferred.promise,
      onRegisterFlush: (flush: (() => Promise<boolean>) | null) => {
        beforeLeave = flush;
      },
    };
    const textarea = nodes(panel(props)).find((node) => node.type === 'textarea');
    (requireNode(textarea).props.onChange as (event: unknown) => void)({
      target: { value: '尚未到点的新设定' },
      nativeEvent: {},
    });
    expect(beforeLeave).not.toBeNull();
    const leaving = (beforeLeave as unknown as () => Promise<boolean>)();
    deferred.reject(new Error('存储暂不可用'));
    expect(await leaving).toBe(false);
    const retained = nodes(panel(props)).find((node) => node.type === 'textarea');
    expect(retained?.props.value).toBe('尚未到点的新设定');
    expect(nodes(panel(props)).some((node) => node.props.role === 'alert')).toBe(true);
  });

  it('also waits for a pending scene switch operation before allowing navigation', async () => {
    let beforeLeave: (() => Promise<boolean>) | null = null;
    const deferred = gate();
    vi.stubGlobal('window', { setTimeout, clearTimeout, prompt: () => '下一场' });
    const props = {
      scene,
      disabled: false,
      onChange: () => {},
      onStartNewScene: () => deferred.promise,
      onRegisterFlush: (flush: (() => Promise<boolean>) | null) => {
        beforeLeave = flush;
      },
    };
    const start = nodes(panel(props)).find((node) => node.type === 'button');
    const switching = (requireNode(start).props.onClick as () => Promise<void>)();
    await vi.advanceTimersByTimeAsync(0);
    const leaving = (beforeLeave as unknown as () => Promise<boolean>)();
    deferred.reject(new Error('切场失败'));
    await switching;
    expect(await leaving).toBe(false);
  });

  it('flushes text entered in an initially clean field while another field is saving', async () => {
    const first = gate();
    let beforeLeave: (() => Promise<boolean>) | null = null;
    const stored = { ...scene };
    const props = {
      scene,
      disabled: false,
      onStartNewScene: () => {},
      onChange: async (patch: Partial<Scene>) => {
        if (patch.location) await first.promise;
        Object.assign(stored, patch);
      },
      onRegisterFlush: (flush: (() => Promise<boolean>) | null) => {
        beforeLeave = flush;
      },
    };
    const fields = nodes(panel(props)).filter((node) => node.type === 'input');
    (requireNode(fields[0]).props.onChange as (event: unknown) => void)({
      target: { value: '新地点' },
      nativeEvent: {},
    });
    const leaving = (beforeLeave as unknown as () => Promise<boolean>)();
    await vi.advanceTimersByTimeAsync(0);
    (requireNode(fields[1]).props.onChange as (event: unknown) => void)({
      target: { value: '保存中补的时间' },
      nativeEvent: {},
    });
    first.resolve();
    expect(await leaving).toBe(true);
    expect(stored.worldTime).toBe('保存中补的时间');
  });
});
