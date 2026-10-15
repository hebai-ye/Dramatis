import { type BudgetLimits, evaluateBudget } from '@dramatis/core';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UsagePanel } from '../components/UsagePanel';

// Controlled React lifecycle: the production editor, inputs and reconciliation remain real.
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
      for (const run of pending.splice(0)) run();
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
        previous &&
        deps &&
        previous.deps &&
        deps.length === previous.deps.length &&
        deps.every((v, i) => Object.is(v, previous.deps?.[i]))
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
  useEffect: host.effect.bind(host),
  useLayoutEffect: host.effect.bind(host),
  useRef: (initial: unknown) => host.state(() => ({ current: initial }))[0],
  useCallback: (callback: unknown) => callback,
  useId: () => 'synthetic-budget-currencies',
}));
function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as ReactElement<Record<string, unknown>>;
  return [node, ...nodes(node.props.children as ReactNode)];
}
function text(tree: ReactNode): string {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree == null || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  return text((tree as ReactElement<{ children: ReactNode }>).props.children);
}
function find(tree: ReactNode, predicate: (node: ReactElement<Record<string, unknown>>) => boolean) {
  const node = nodes(tree).find(predicate);
  if (!node) throw new Error('Missing fixture');
  return node;
}
function callsField(tree: ReactNode) {
  return find(
    find(tree, (node) => node.type === 'label' && text(node.props.children as ReactNode).startsWith('额外调用上限')),
    (node) => node.type === 'input',
  );
}
function change(tree: ReactNode, value: string) {
  (callsField(tree).props.onChange as (event: unknown) => void)({ target: { value } });
}
let memory = new Map();
let worldId: string | null = 'world-a';
let limits: BudgetLimits | null = { maxExtraCalls: 10 };
let onSave = async (_limits: BudgetLimits | null) => {};
function render() {
  const run = () => {
    const tree = UsagePanel({
      worldId,
      world: null,
      conversation: null,
      latestTurn: null,
      conversationTitle: 'Synthetic',
      budget: evaluateBudget(null, limits),
      limits,
      onSaveBudget: onSave,
      budgetDrafts: memory,
    });
    const editor = find(tree, (node) => typeof node.type === 'function' && node.props.onSave === onSave);
    return (editor.type as (props: Record<string, unknown>) => ReactNode)(editor.props);
  };
  host.begin();
  run();
  host.flush();
  host.begin();
  const tree = run();
  host.flush();
  return tree;
}
beforeEach(() => {
  host.reset();
  memory.clear();
  worldId = 'world-a';
  limits = { maxExtraCalls: 10 };
  onSave = async () => {};
});
afterEach(() => host.reset());
it('retains unsaved budget text after the usage tab unmounts and remounts in the same world', () => {
  change(render(), '12.');
  host.reset();
  expect(callsField(render()).props.value).toBe('12.');
});
it('keeps equal-budget worlds separate and restores each world draft', () => {
  change(render(), '27');
  host.reset();
  worldId = 'world-b';
  expect(callsField(render()).props.value).toBe('10');
  change(render(), '38');
  host.reset();
  worldId = 'world-a';
  expect(callsField(render()).props.value).toBe('27');
  host.reset();
  worldId = 'world-b';
  expect(callsField(render()).props.value).toBe('38');
});
it('preserves a dirty draft against external configuration changes after leaving the tab', () => {
  change(render(), '27');
  host.reset();
  limits = { maxExtraCalls: 20 };
  const tree = render();
  expect(callsField(tree).props.value).toBe('27');
  expect(text(tree)).toContain('已在别处改变');
  expect(
    find(tree, (node) => node.type === 'button' && text(node.props.children as ReactNode).startsWith('保存上限')).props
      .disabled,
  ).toBe(true);
});
it('refreshes a clean draft from current configuration on remount', () => {
  render();
  host.reset();
  limits = { maxExtraCalls: 20 };
  expect(callsField(render()).props.value).toBe('20');
});
it('does not retain a draft for an unidentified world', () => {
  worldId = null;
  change(render(), '27');
  host.reset();
  expect(callsField(render()).props.value).toBe('10');
  expect(memory.size).toBe(0);
});
it('preserves failed-save text across tab unmount without writing while remounting', async () => {
  let writes = 0;
  onSave = async () => {
    writes++;
    throw new Error('Synthetic disk full');
  };
  change(render(), '27');
  const tree = render();
  (
    find(tree, (node) => node.type === 'button' && text(node.props.children as ReactNode).startsWith('保存上限')).props
      .onClick as () => void
  )();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(text(render())).toContain('Synthetic disk full');
  host.reset();
  expect(callsField(render()).props.value).toBe('27');
  expect(writes).toBe(1);
});
it('does not share drafts with a second caller-owned store', () => {
  change(render(), '27');
  host.reset();
  const first = memory;
  memory = new Map();
  expect(callsField(render()).props.value).toBe('10');
  host.reset();
  memory = first;
  expect(callsField(render()).props.value).toBe('27');
});
it('does not let a delayed save completion overwrite a newly remounted draft', async () => {
  let resolve!: () => void;
  onSave = () =>
    new Promise<void>((done) => {
      resolve = done;
    });
  change(render(), '27');
  (
    find(render(), (node) => node.type === 'button' && text(node.props.children as ReactNode).startsWith('保存上限'))
      .props.onClick as () => void
  )();
  host.reset();
  change(render(), '38');
  resolve();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  host.reset();
  expect(callsField(render()).props.value).toBe('38');
});
