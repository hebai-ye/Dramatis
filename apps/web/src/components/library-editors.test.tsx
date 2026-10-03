import { createBlankCard, createBlankWorldBook, createPersona, createWorldBookEntry } from '@dramatis/core';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardDesigner } from './CardDesigner';
import { PersonaLibrary } from './PersonaLibrary';
import { WorldDesigner } from './WorldDesigner';

const actions = vi.hoisted(() => ({
  handles: new Map<string, { flush: () => Promise<void>; pending: () => string | null; discard: () => void }>(),
  registerEditor(
    view: string,
    handle: { flush: () => Promise<void>; pending: () => string | null; discard: () => void },
  ) {
    this.handles.set(view, handle);
    return () => {
      this.handles.delete(view);
    };
  },
  async requestAction(action: () => void | Promise<void>) {
    for (const handle of this.handles.values()) {
      if (handle.pending()) return false;
      await handle.flush();
    }
    await action();
    return true;
  },
}));
vi.mock('../lib/library-view', () => ({ useLibraryActions: () => actions }));
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
      for (const run of next) run();
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
      const index = effectCursor++;
      const previous = effects[index];
      if (!previous || !deps || !previous.deps || deps.some((value, i) => value !== previous.deps?.[i])) {
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
  useState: hooks.state,
  useEffect: hooks.effect,
  useRef: (initial: unknown) => {
    const [ref] = hooks.state(() => ({ current: initial }));
    return ref;
  },
}));

function render(component: () => ReactNode): ReactNode {
  hooks.begin();
  component();
  hooks.flush();
  hooks.begin();
  const tree = component();
  hooks.flush();
  return tree;
}

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

function button(tree: ReactNode, label: string): ReactElement<Record<string, unknown>> {
  const found = nodes(tree).find(
    (node) => node.type === 'button' && textOf(node.props.children as ReactNode) === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function click(node: ReactElement<Record<string, unknown>>) {
  return (node.props.onClick as () => unknown)();
}

function changeValue(node: ReactElement<Record<string, unknown>> | undefined, value: string): void {
  if (!node) throw new Error('Missing input fixture');
  (node.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value },
    nativeEvent: { isComposing: false },
  } as { target: { value: string } });
}

beforeEach(() => {
  hooks.reset();
  actions.handles.clear();
  vi.stubGlobal('window', {
    confirm: () => true,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
});

describe('library editor handler trees (no DOM runtime)', () => {
  it.each(['personas', 'cards', 'worldbooks'] as const)(
    'keeps %s selector browseable while writes are disabled',
    (kind) => {
      const persona = createPersona({ name: 'Identity' });
      const card = createBlankCard();
      const book = { ...createBlankWorldBook(), entries: [createWorldBookEntry()] };
      const props = {
        disabled: true,
        onSave: () => {},
        onDelete: () => {},
        selectedId: kind === 'personas' ? persona.id : kind === 'cards' ? card.id : book.id,
      };
      const tree = render(() =>
        kind === 'personas'
          ? PersonaLibrary({ ...props, personas: [persona] })
          : kind === 'cards'
            ? CardDesigner({ ...props, cards: [card] })
            : WorldDesigner({ ...props, books: [book], attachedIds: [], onAttach: () => {} }),
      );
      expect(nodes(tree).find((node) => node.type === 'select')?.props.disabled).not.toBe(true);
      expect(button(tree, '＋ 新建').props.disabled).toBe(true);
      if (kind === 'worldbooks')
        expect(
          nodes(tree).find((node) => node.type === 'button' && node.props.className === 'room-open')?.props.disabled,
        ).not.toBe(true);
    },
  );

  it.each(['personas', 'cards', 'worldbooks'] as const)(
    'hides the %s selector but preserves creation and external selection',
    (kind) => {
      const persona = createPersona({ name: 'Identity' });
      const card = { ...createBlankCard(), name: 'Card' };
      const book = { ...createBlankWorldBook(), name: 'Book' };
      const props = {
        disabled: false,
        onSave: () => {},
        onDelete: () => {},
        hideSelector: true,
        selectedId: kind === 'personas' ? persona.id : kind === 'cards' ? card.id : book.id,
      };
      const tree = render(() =>
        kind === 'personas'
          ? PersonaLibrary({ ...props, personas: [persona] })
          : kind === 'cards'
            ? CardDesigner({ ...props, cards: [card] })
            : WorldDesigner({ ...props, books: [book], attachedIds: [], onAttach: () => {} }),
      );
      expect(nodes(tree).filter((node) => node.type === 'select')).toHaveLength(0);
      expect(button(tree, '＋ 新建')).toBeDefined();
      expect(nodes(tree).find((node) => node.type === 'input' && node.props.type === 'text')?.props.value).toBe(
        kind === 'personas' ? 'Identity' : kind === 'cards' ? 'Card' : 'Book',
      );
    },
  );

  it('world attachment is unavailable without a world and attached books can detach', async () => {
    const book = createBlankWorldBook();
    let detached = '';
    const props = {
      books: [book],
      selectedId: book.id,
      disabled: false,
      onSave: () => {},
      onDelete: () => {},
      onAttach: () => {},
      onDetach: (id: string) => {
        detached = id;
      },
    };
    const absent = render(() => WorldDesigner({ ...props, attachedIds: [], canAttach: false }));
    expect(button(absent, '挂到当前世界').props.disabled).toBe(true);
    expect(textOf(absent)).toMatch(/选择.*世界|没有.*世界/);
    const attached = render(() => WorldDesigner({ ...props, attachedIds: [book.id], canAttach: true }));
    await click(button(attached, '从当前世界解绑'));
    expect(detached).toBe(book.id);
  });

  it('persona leaves within debounce period only after newest fields save', async () => {
    const one = createPersona({ name: 'Old' });
    const two = createPersona({ name: 'Other' });
    const saved: string[] = [];
    const props = {
      personas: [one, two],
      disabled: false,
      onSave: (p: typeof one) => {
        saved.push(p.name);
      },
      onDelete: () => {},
    };
    const tree = render(() => PersonaLibrary(props));
    changeValue(
      nodes(tree).find((node) => node.type === 'input'),
      'Newest',
    );
    const selector = required(nodes(tree).find((node) => node.type === 'select'));
    await (selector.props.onChange as (event: { target: { value: string } }) => unknown)({ target: { value: two.id } });
    expect(saved).toEqual(['Newest']);
    expect(nodes(render(() => PersonaLibrary(props))).find((node) => node.type === 'input')?.props.value).toBe('Other');
  });
});

it('blocks repeated creation immediately and flush waits for the created selection', async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saved = 0;
  let selected: string | null = null;
  const props = {
    cards: [],
    disabled: false,
    onSave: async () => {
      saved += 1;
      await wait;
    },
    onDelete: () => {},
    onSelectionChange: (id: string | null) => {
      selected = id;
    },
  };
  const tree = render(() => CardDesigner(props));
  const creating = click(button(tree, '＋ 新建'));
  const pending = render(() => CardDesigner(props));
  expect(button(pending, '＋ 新建').props.disabled).toBe(true);
  expect(selected).toBe(null);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  let left = false;
  const leaving = required(actions.handles.get('cards'))
    .flush()
    .then(() => {
      left = true;
    });
  await Promise.resolve();
  expect(left).toBe(false);
  release();
  await Promise.all([creating, leaving]);
  expect(saved).toBe(1);
  expect(selected).toBeTypeOf('string');
});

it('failed card save keeps its text and retry commits it', async () => {
  const card = createBlankCard();
  let fail = true;
  const stored: string[] = [];
  const props = {
    cards: [card],
    selectedId: card.id,
    disabled: false,
    onSave: async (next: typeof card) => {
      if (fail) throw new Error('离线');
      stored.push(next.name);
    },
    onDelete: () => {},
  };
  let tree = render(() => CardDesigner(props));
  changeValue(
    nodes(tree).find((node) => node.type === 'input' && node.props.type === 'text'),
    '待保存',
  );
  await click(button(tree, '保存'));
  tree = render(() => CardDesigner(props));
  expect(textOf(tree)).toMatch(/离线/);
  expect(nodes(tree).find((node) => node.type === 'input' && node.props.type === 'text')?.props.value).toBe('待保存');
  fail = false;
  await click(button(tree, '重试保存'));
  expect(stored).toEqual(['待保存']);
});

it('unconfirmed crop blocks leaving and discard preserves the other edited fields', async () => {
  const one = createBlankCard();
  const two = createBlankCard();
  const stored: string[] = [];
  const props = {
    cards: [one, two],
    disabled: false,
    onSave: (next: typeof one) => {
      stored.push(next.name);
    },
    onDelete: () => {},
  };
  let tree = render(() => CardDesigner(props));
  await (
    required(nodes(tree).find((node) => node.type === 'select')).props.onChange as (event: {
      target: { value: string };
    }) => unknown
  )({ target: { value: one.id } });
  tree = render(() => CardDesigner(props));
  changeValue(
    nodes(tree).find((node) => node.type === 'input' && node.props.type === 'text'),
    '保留文字',
  );
  (
    required(nodes(tree).find((node) => node.type === 'input' && node.props.type === 'file')).props.onChange as (
      event: unknown,
    ) => void
  )({ target: { files: [{ type: 'image/png', size: 20 }], value: 'file' } });
  tree = render(() => CardDesigner(props));
  const handle = required(actions.handles.get('cards'));
  expect(handle.pending()).toMatch(/裁切/);
  await (
    required(nodes(tree).find((node) => node.type === 'select')).props.onChange as (event: {
      target: { value: string };
    }) => unknown
  )({ target: { value: two.id } });
  expect(
    nodes(render(() => CardDesigner(props))).find((node) => node.type === 'input' && node.props.type === 'text')?.props
      .value,
  ).toBe('保留文字');
  handle.discard();
  render(() => CardDesigner(props));
  expect(handle.pending()).toBe(null);
  await handle.flush();
  expect(stored).toEqual(['保留文字']);
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture');
  return value;
}

afterEach(() => {
  hooks.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('long IME composition neither saves partial text nor reports an autosave failure', async () => {
  vi.useFakeTimers();
  const card = createBlankCard();
  const stored: string[] = [];
  const props = {
    cards: [card],
    selectedId: card.id,
    disabled: false,
    onSave: (next: typeof card) => {
      stored.push(next.name);
    },
    onDelete: () => {},
  };
  let tree = render(() => CardDesigner(props));
  (required(nodes(tree)[0]).props.onCompositionStart as () => void)();
  changeValue(
    nodes(tree).find((node) => node.type === 'input' && node.props.type === 'text'),
    '组合中的字',
  );
  await vi.advanceTimersByTimeAsync(500);
  tree = render(() => CardDesigner(props));
  expect(stored).toEqual([]);
  expect(nodes(tree).find((node) => node.props.role === 'alert')).toBe(undefined);
  await expect(actions.handles.get('cards')?.flush()).rejects.toThrow(/输入/);
  (required(nodes(tree)[0]).props.onCompositionEnd as () => void)();
  await actions.handles.get('cards')?.flush();
  expect(stored).toEqual(['组合中的字']);
});

it('persona deletion clears queued autosave so timer cannot resurrect it', async () => {
  vi.useFakeTimers();
  const persona = createPersona({ name: 'To delete' });
  const events: string[] = [];
  const props = {
    personas: [persona],
    disabled: false,
    onSave: () => {
      events.push('save');
    },
    onDelete: () => {
      events.push('delete');
    },
  };
  const tree = render(() => PersonaLibrary(props));
  changeValue(
    nodes(tree).find((node) => node.type === 'input'),
    'Changed before delete',
  );
  await click(button(tree, '删除这个身份'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(events).toEqual(['save', 'delete']);
  expect(nodes(render(() => PersonaLibrary(props))).find((node) => node.type === 'input')).toBe(undefined);
});

it('applies a same-ID external refresh after a slow attachment becomes clean', async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const book = { ...createBlankWorldBook(), name: 'Initial' };
  let books = [book];
  const props = {
    selectedId: book.id,
    attachedIds: [],
    disabled: false,
    onSave: () => {},
    onDelete: () => {},
    onAttach: () => wait,
  };
  let tree = render(() => WorldDesigner({ ...props, books }));
  const attaching = click(button(tree, '挂到当前世界'));
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  books = [{ ...book, name: 'External update' }];
  tree = render(() => WorldDesigner({ ...props, books }));
  expect(nodes(tree).find((node) => node.type === 'input')?.props.value).toBe('Initial');
  release();
  await attaching;
  tree = render(() => WorldDesigner({ ...props, books }));
  expect(button(tree, '挂到当前世界').props.disabled).toBe(false);
  expect(nodes(tree).find((node) => node.type === 'input')?.props.value).toBe('External update');
});

it('does not replay stale external fields over its own successful save', async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const card = { ...createBlankCard(), name: 'Initial' };
  let cards = [card];
  const props = { selectedId: card.id, disabled: false, onSave: () => wait, onDelete: () => {} };
  let tree = render(() => CardDesigner({ ...props, cards }));
  changeValue(
    nodes(tree).find((node) => node.type === 'input' && node.props.type === 'text'),
    'Local save',
  );
  const saving = click(button(tree, '保存'));
  await Promise.resolve();
  cards = [{ ...card, updatedAt: 'external snapshot' }];
  render(() => CardDesigner({ ...props, cards }));
  release();
  await saving;
  tree = render(() => CardDesigner({ ...props, cards }));
  expect(nodes(tree).find((node) => node.type === 'input' && node.props.type === 'text')?.props.value).toBe(
    'Local save',
  );
});

it.each([false, true])(
  'external removal clears an uncontrolled selected persona without revival (dirty=%s)',
  async (dirty) => {
    const persona = createPersona({ name: 'Removed externally' });
    let personas = [persona];
    const saved: string[] = [];
    const selections: (string | null)[] = [];
    const props = {
      disabled: false,
      onSave: (next: typeof persona) => {
        saved.push(next.id);
      },
      onDelete: () => {},
      onSelectionChange: (id: string | null) => {
        selections.push(id);
      },
    };
    let tree = render(() => PersonaLibrary({ ...props, personas }));
    if (dirty)
      changeValue(
        nodes(tree).find((node) => node.type === 'input'),
        'Unsaved removal',
      );
    personas = [];
    tree = render(() => PersonaLibrary({ ...props, personas }));
    await actions.handles.get('personas')?.flush();
    expect(nodes(tree).find((node) => node.type === 'input')).toBe(undefined);
    expect(saved).toEqual([]);
    expect(selections).toEqual([null]);
  },
);

it('expires a created item grace period when the parent never confirms its presence', async () => {
  vi.useFakeTimers();
  const selections: (string | null)[] = [];
  const props = {
    cards: [],
    disabled: false,
    onSave: () => {},
    onDelete: () => {},
    onSelectionChange: (id: string | null) => {
      selections.push(id);
    },
  };
  let tree = render(() => CardDesigner(props));
  await click(button(tree, '＋ 新建'));
  tree = render(() => CardDesigner(props));
  expect(nodes(tree).find((node) => node.type === 'input' && node.props.type === 'text')).toBeDefined();
  await vi.advanceTimersByTimeAsync(301);
  tree = render(() => CardDesigner(props));
  expect(nodes(tree).find((node) => node.type === 'input' && node.props.type === 'text')).toBe(undefined);
  expect(selections).toHaveLength(2);
  expect(selections[1]).toBe(null);
});

it('keeps a created selection when the parent confirms it within the grace period', async () => {
  vi.useFakeTimers();
  let created: ReturnType<typeof createBlankCard> | undefined;
  let cards: ReturnType<typeof createBlankCard>[] = [];
  const props = {
    disabled: false,
    onSave: (next: ReturnType<typeof createBlankCard>) => {
      created = next;
    },
    onDelete: () => {},
  };
  let tree = render(() => CardDesigner({ ...props, cards }));
  await click(button(tree, '＋ 新建'));
  tree = render(() => CardDesigner({ ...props, cards }));
  expect(nodes(tree).find((node) => node.type === 'input' && node.props.type === 'text')).toBeDefined();
  await vi.advanceTimersByTimeAsync(200);
  cards = [required(created)];
  render(() => CardDesigner({ ...props, cards }));
  await vi.advanceTimersByTimeAsync(200);
  tree = render(() => CardDesigner({ ...props, cards }));
  expect(nodes(tree).find((node) => node.type === 'input' && node.props.type === 'text')?.props.value).toBe(
    created?.name,
  );
});

it('drops the removed dirty object when the controlled list repairs selection to a neighbor', async () => {
  const one = createBlankCard();
  const two = { ...createBlankCard(), name: 'Neighbor' };
  let cards = [one, two];
  let selectedId = one.id;
  const saved: string[] = [];
  const props = {
    disabled: false,
    onSave: (next: typeof one) => {
      saved.push(next.id);
    },
    onDelete: () => {},
  };
  let tree = render(() => CardDesigner({ ...props, cards, selectedId }));
  changeValue(
    nodes(tree).find((node) => node.type === 'input' && node.props.type === 'text'),
    'Deleted dirty object',
  );
  cards = [two];
  selectedId = two.id;
  tree = render(() => CardDesigner({ ...props, cards, selectedId }));
  await actions.handles.get('cards')?.flush();
  expect(nodes(tree).find((node) => node.type === 'input' && node.props.type === 'text')?.props.value).toBe('Neighbor');
  expect(saved).toEqual([]);
});

it('slow internal persona deletion retains the root-repaired neighboring selection after load completes', async () => {
  const one = createPersona({ name: 'Deleting' });
  const two = createPersona({ name: 'Neighbor' });
  let personas = [one, two];
  let selectedId: string | null = one.id;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const deletionStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const selected: (string | null)[] = [];
  const props = {
    disabled: false,
    onSave: () => {},
    onDelete: async () => {
      personas = [two];
      selectedId = two.id;
      started();
      await wait;
    },
    onSelectionChange: (id: string | null) => {
      selectedId = id;
      selected.push(id);
    },
  };
  let tree = render(() => PersonaLibrary({ ...props, personas, selectedId }));
  const deleting = click(button(tree, '删除这个身份'));
  await deletionStarted;
  render(() => PersonaLibrary({ ...props, personas, selectedId }));
  release();
  await deleting;
  tree = render(() => PersonaLibrary({ ...props, personas, selectedId }));
  expect(nodes(tree).find((node) => node.type === 'input')?.props.value).toBe('Neighbor');
  expect(selectedId).toBe(two.id);
  expect(selected).not.toContain(null);
});
