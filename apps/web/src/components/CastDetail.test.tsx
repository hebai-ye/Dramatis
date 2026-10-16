import { type CharacterInstance, createBlankCard, createInstanceFor, instanceId, roomId } from '@dramatis/core';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CastDetail } from './CastDetail';

// Handler-tree checks with real component logic and controlled hook lifetimes; not browser/DOM acceptance.
const host = vi.hoisted(() => {
  let values: unknown[] = [],
    cursor = 0,
    effectCursor = 0;
  let effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = [];
  let pending: (() => void)[] = [];
  const writes: unknown[] = [];
  return {
    writes,
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
      this.unmount();
      writes.length = 0;
    },
    unmount() {
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
          writes.push(values[index]);
        },
      ];
    },
    ref(initial: unknown) {
      return this.state(() => ({ current: initial }))[0];
    },
    effect(run: () => (() => void) | undefined, deps?: readonly unknown[]) {
      const index = effectCursor++,
        previous = effects[index];
      if (
        previous &&
        deps &&
        previous.deps &&
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
  useState: host.state.bind(host),
  useRef: host.ref.bind(host),
  useEffect: host.effect.bind(host),
  useLayoutEffect: host.effect.bind(host),
  useCallback: (callback: unknown) => callback,
  useMemo: (callback: () => unknown) => callback(),
}));
beforeEach(() => {
  host.reset();
  vi.stubGlobal('window', { clearTimeout, setTimeout });
});
afterEach(() => {
  host.unmount();
  vi.unstubAllGlobals();
});

function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as ReactElement<Record<string, unknown>>;
  return [element, ...nodes(element.props.children as ReactNode)];
}
function text(tree: ReactNode): string {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree === null || tree === undefined || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  return text((tree as ReactElement<{ children: ReactNode }>).props.children);
}
function button(tree: ReactNode, label = '撤销这条影响') {
  const found = nodes(tree).find((item) => item.type === 'button' && text(item.props.children as ReactNode) === label);
  if (!found) throw new Error(`missing ${label}`);
  return found;
}
function click(element: ReactElement<Record<string, unknown>>) {
  return (element.props.onClick as () => unknown)();
}
function gate() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const card = createBlankCard({ name: 'Synthetic' });
  const base = createInstanceFor(card, roomId('cast-feedback-world'));
  const instance: CharacterInstance = {
    ...base,
    affect: {
      ...base.affect,
      valence: 0.3,
      history: [
        {
          id: 'change-a',
          at: '2026-01-01T00:00:00.000Z',
          turnId: 'turn-a',
          beforeValence: 0,
          afterValence: 0.3,
          beforeArousal: 0,
          afterArousal: 0,
          deltaValence: 0.3,
          deltaArousal: 0,
          reason: 'Synthetic effect',
          sourceMemoryIds: [],
          reversionOf: null,
        },
      ],
    },
  };
  const props = {
    instance,
    card,
    memories: [],
    disabled: false,
    onClose: () => {},
    onRename: () => {},
    onSetPresence: () => {},
    onSetRelationship: () => {},
    onRemove: () => {},
    onRevertChange: async () => {},
  };
  const render = () => {
    host.begin();
    const tree = CastDetail(props);
    host.flush();
    return tree;
  };
  return { props, render };
}
async function drain() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('single-affect reversion feedback', () => {
  it('blocks duplicate clicks synchronously and displays pending until the real save finishes', async () => {
    const h = fixture(),
      wait = gate();
    let saves = 0;
    h.props.onRevertChange = async () => {
      saves++;
      await wait.promise;
    };
    const undo = button(h.render());
    click(undo);
    click(undo);
    expect(saves).toBe(1);
    const tree = h.render();
    expect(
      nodes(tree).some(
        (item) =>
          item.type === 'button' &&
          item.props.disabled === true &&
          text(item.props.children as ReactNode).includes('撤销'),
      ),
    ).toBe(true);
    expect(
      nodes(tree).some(
        (item) => item.props.role === 'status' && text(item.props.children as ReactNode).includes('正在'),
      ),
    ).toBe(true);
    wait.resolve();
    await drain();
    expect(text(h.render())).not.toContain('正在撤销');
  });
  it('shows save rejection inline and permits retry without claiming an optimistic reversion', async () => {
    const h = fixture(),
      wait = gate();
    h.props.onRevertChange = () => wait.promise;
    click(button(h.render()));
    wait.reject(new Error('Synthetic disk refusal'));
    await drain();
    const tree = h.render();
    expect(
      nodes(tree).some(
        (item) =>
          item.props.role === 'alert' && text(item.props.children as ReactNode).includes('Synthetic disk refusal'),
      ),
    ).toBe(true);
    expect(button(tree).props.disabled).toBe(false);
    expect(text(tree)).not.toContain('已撤销');
    h.props.onRevertChange = async () => {};
    click(button(h.render()));
    await drain();
    expect(text(h.render())).not.toContain('Synthetic disk refusal');
  });
  it('does not mark a record reverted merely because its callback resolves', async () => {
    const h = fixture();
    click(button(h.render()));
    await drain();
    expect(text(h.render())).not.toContain('已撤销');
    const change = h.props.instance.affect.history[0];
    if (!change) throw new Error('history missing');
    h.props.instance = {
      ...h.props.instance,
      affect: {
        ...h.props.instance.affect,
        history: [...h.props.instance.affect.history, { ...change, id: 'undo-a', reversionOf: change.id }],
      },
    };
    expect(text(h.render())).toContain('已撤销');
  });
  it.each(['role', 'world'] as const)('ignores late failures when the visible %s changes', async (scope) => {
    const h = fixture(),
      old = gate();
    h.props.onRevertChange = () => old.promise;
    click(button(h.render()));
    h.props.instance =
      scope === 'role'
        ? { ...h.props.instance, id: instanceId('cast-other') }
        : { ...h.props.instance, roomId: roomId('cast-other-world') };
    const tree = h.render();
    expect(button(tree).props.disabled).toBe(false);
    old.reject(new Error('Old request failure'));
    await drain();
    expect(text(h.render())).not.toContain('Old request failure');
  });
  it('does not update feedback after unmount', async () => {
    const h = fixture(),
      wait = gate();
    h.props.onRevertChange = () => wait.promise;
    click(button(h.render()));
    host.unmount();
    const before = host.writes.length;
    wait.resolve();
    await drain();
    expect(host.writes).toHaveLength(before);
  });
  it('does not restore pending feedback when returning to the original role while its old request remains in flight', async () => {
    const h = fixture(),
      wait = gate(),
      original = h.props.instance;
    h.props.onRevertChange = () => wait.promise;
    click(button(h.render()));
    h.props.instance = { ...original, id: instanceId('cast-other') };
    h.render();
    h.props.instance = original;
    expect(button(h.render()).props.disabled).toBe(false);
    wait.resolve();
    await drain();
  });
});
