import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageReadFeedback } from './UsagePanel';

// Controlled hook host for this small feedback component; no browser or ledger is substituted.
const host = vi.hoisted(() => {
  const cells: unknown[] = [];
  let cursor = 0;
  const effects: Array<() => void> = [];
  const cleanups: Array<() => void> = [];
  return {
    state(initial: unknown) {
      const slot = cursor++;
      if (!(slot in cells)) cells[slot] = initial;
      return [
        cells[slot],
        (next: unknown) => {
          cells[slot] = typeof next === 'function' ? next(cells[slot]) : next;
        },
      ];
    },
    ref(initial: unknown) {
      const slot = cursor++;
      if (!(slot in cells)) cells[slot] = { current: initial };
      return cells[slot];
    },
    effect(run: () => undefined | (() => void), deps: readonly unknown[]) {
      const slot = cursor++;
      const previous = cells[slot] as readonly unknown[] | undefined;
      if (previous?.length === deps.length && previous.every((value, index) => Object.is(value, deps[index]))) return;
      cells[slot] = deps;
      effects.push(() => {
        const cleanup = run();
        if (cleanup) cleanups.push(cleanup);
      });
    },
    render<T>(run: () => T): T {
      cursor = 0;
      const tree = run();
      for (const effect of effects.splice(0)) effect();
      return tree;
    },
    reset() {
      for (const cleanup of cleanups.splice(0)) cleanup();
      cells.length = 0;
      effects.length = 0;
    },
    unmount() {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
});

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: host.state,
  useRef: host.ref,
  useEffect: host.effect,
  useLayoutEffect: host.effect,
}));

beforeEach(() => host.reset());
afterEach(() => host.reset());

function visit(
  tree: unknown,
  match: (element: { type: unknown; props: Record<string, unknown> }) => boolean,
): Record<string, unknown> | null {
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = visit(child, match);
      if (found) return found;
    }
  } else if (tree && typeof tree === 'object' && 'type' in tree && 'props' in tree) {
    const element = tree as { type: unknown; props: Record<string, unknown> };
    if (match(element)) return element.props;
    return visit(element.props.children, match);
  }
  return null;
}

function textOf(tree: unknown): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (tree && typeof tree === 'object' && 'props' in tree) {
    return textOf((tree as { props: Record<string, unknown> }).props.children);
  }
  return '';
}

async function drain() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function click(button: Record<string, unknown> | null) {
  if (button === null || typeof button.onClick !== 'function') throw new Error('Missing retry button');
  button.onClick();
}

describe('账单重试反馈交互', () => {
  it('切换读取范围后允许新重试，并忽略旧范围的延迟失败', async () => {
    let rejectOld!: (failure: Error) => void;
    const oldRetry = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectOld = reject;
        }),
    );
    const newRetry = vi.fn(async () => {});
    let onRetry = oldRetry;
    let error = '旧范围读取失败';
    const render = () => host.render(() => UsageReadFeedback({ error, hasData: true, onRetry }));
    click(visit(render(), (element) => element.type === 'button'));
    onRetry = newRetry;
    error = '新范围读取失败';
    render();
    const current = render();
    expect(visit(current, (element) => element.type === 'button')?.disabled).toBe(false);
    click(visit(current, (element) => element.type === 'button'));
    expect(newRetry).toHaveBeenCalledTimes(1);
    await drain();
    rejectOld(new Error('旧范围的延迟失败'));
    await drain();
    expect(textOf(render())).toContain('新范围读取失败');
    expect(textOf(render())).not.toContain('旧范围的延迟失败');
  });

  it('连续点击只发一个读取，失败后显示最新错误并恢复可重试状态', async () => {
    let reject!: (failure: Error) => void;
    const pending = new Promise<void>((_, no) => {
      reject = no;
    });
    const onRetry = vi.fn(() => pending);
    const render = () => host.render(() => UsageReadFeedback({ error: '首次失败', hasData: true, onRetry }));
    const button = visit(render(), (element) => element.type === 'button');
    click(button);
    click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(visit(render(), (element) => element.type === 'button')?.disabled).toBe(true);
    reject(new Error('再次读取失败'));
    await drain();
    const failed = render();
    expect(textOf(failed)).toContain('再次读取失败');
    expect(textOf(failed)).toContain('上次成功读取');
    expect(visit(failed, (element) => element.type === 'button')?.disabled).toBe(false);
  });

  it('读取恢复后旧错误消失', async () => {
    const onRetry = async () => {};
    let error: string | null = '首次失败';
    const render = () => host.render(() => UsageReadFeedback({ error, hasData: true, onRetry }));
    const button = visit(render(), (element) => element.type === 'button');
    click(button);
    await drain();
    error = null;
    render();
    expect(render()).toBeNull();
  });
});
