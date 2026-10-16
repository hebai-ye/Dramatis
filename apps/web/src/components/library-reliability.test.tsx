import { createBlankCard, createBlankWorldBook, createWorldBookEntry } from '@dramatis/core';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AvatarCropper } from './AvatarCropper';
import { CardDesigner } from './CardDesigner';
import { WorldDesigner } from './WorldDesigner';

// Real component handlers with controlled hook lifetimes; browser/IME acceptance remains separate.
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
const actions = vi.hoisted(() => ({
  handles: new Map<string, { flush: () => Promise<void> }>(),
  registerEditor(view: string, handle: { flush: () => Promise<void> }) {
    this.handles.set(view, handle);
    return () => {
      this.handles.delete(view);
    };
  },
  async requestAction(action: () => void | Promise<void>) {
    for (const handle of this.handles.values()) await handle.flush();
    await action();
    return true;
  },
}));
vi.mock('../lib/library-view', () => ({ useLibraryActions: () => actions }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: host.state.bind(host),
  useEffect: host.effect.bind(host),
  useRef: (initial: unknown) => host.state(() => ({ current: initial }))[0],
}));
function render(component: () => ReactNode) {
  host.begin();
  component();
  host.flush();
  host.begin();
  const tree = component();
  host.flush();
  return tree;
}
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
function button(tree: ReactNode, label: string) {
  return find(tree, (n) => n.type === 'button' && text(n.props.children as ReactNode) === label);
}
function field(tree: ReactNode, label: string) {
  return find(
    find(tree, (n) => n.type === 'label' && text(n.props.children as ReactNode).startsWith(label)),
    (n) => n.type === 'input',
  );
}
function change(node: ReactElement<Record<string, unknown>>, value: string) {
  (node.props.onChange as (event: unknown) => void)({ target: { value }, nativeEvent: { isComposing: false } });
}
function click(node: ReactElement<Record<string, unknown>>) {
  return (node.props.onClick as () => unknown)();
}
function composition(tree: ReactNode, end = false) {
  const root = nodes(tree)[0];
  if (!root) throw new Error('Missing component fixture');
  (root.props[end ? 'onCompositionEnd' : 'onCompositionStart'] as () => void)();
}
beforeEach(() => {
  host.reset();
  actions.handles.clear();
  vi.useFakeTimers();
  vi.stubGlobal('window', { confirm: () => true });
});
afterEach(() => {
  host.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([',', '，', '、'])(
  'retains card tag delimiter %s and commits arrays only on blur or library flush',
  async (separator) => {
    const card = createBlankCard(),
      saved: string[][] = [];
    const props = {
      cards: [card],
      selectedId: card.id,
      disabled: false,
      onDelete: () => {},
      onSave: (next: typeof card) => {
        saved.push(next.tags);
      },
    };
    let tree = render(() => CardDesigner(props));
    change(field(tree, '标签'), `alpha${separator}`);
    tree = render(() => CardDesigner(props));
    expect(field(tree, '标签').props.value).toBe(`alpha${separator}`);
    await vi.advanceTimersByTimeAsync(500);
    expect(saved).toEqual([]);
    change(field(tree, '标签'), `alpha${separator}beta${separator}`);
    await actions.handles.get('cards')?.flush();
    expect(saved).toEqual([['alpha', 'beta']]);
    expect(
      field(
        render(() => CardDesigner(props)),
        '标签',
      ).props.value,
    ).toBe('alpha、beta');
  },
);

it('keeps IME tags raw, blocks leaving mid-composition, then preserves failed save for retry', async () => {
  const card = createBlankCard(),
    saved: string[][] = [];
  let fail = true;
  const props = {
    cards: [card],
    selectedId: card.id,
    disabled: false,
    onDelete: () => {},
    onSave: (next: typeof card) => {
      if (fail) throw new Error('Synthetic refusal');
      saved.push(next.tags);
    },
  };
  let tree = render(() => CardDesigner(props));
  composition(tree);
  change(field(tree, '标签'), ' 中文，第二项、');
  await vi.advanceTimersByTimeAsync(500);
  await expect(actions.handles.get('cards')?.flush()).rejects.toThrow(/输入/);
  tree = render(() => CardDesigner(props));
  expect(field(tree, '标签').props.value).toBe(' 中文，第二项、');
  composition(tree, true);
  await click(
    button(
      render(() => CardDesigner(props)),
      '保存',
    ),
  );
  tree = render(() => CardDesigner(props));
  expect(text(tree)).toContain('Synthetic refusal');
  expect(field(tree, '标签').props.value).toBe('中文、第二项');
  fail = false;
  await click(button(tree, '重试保存'));
  expect(saved).toEqual([['中文', '第二项']]);
});

it('finishing tag composition preserves raw delimiters until the field is committed', async () => {
  const card = createBlankCard(),
    saved: string[][] = [];
  const props = {
    cards: [card],
    selectedId: card.id,
    disabled: false,
    onDelete: () => {},
    onSave: (next: typeof card) => {
      saved.push(next.tags);
    },
  };
  let tree = render(() => CardDesigner(props));
  composition(tree);
  change(field(tree, '标签'), '中文，');
  composition(tree, true);
  await vi.advanceTimersByTimeAsync(500);
  expect(saved).toEqual([]);
  tree = render(() => CardDesigner(props));
  expect(field(tree, '标签').props.value).toBe('中文，');
  await (field(tree, '标签').props.onBlur as () => unknown)();
  expect(saved).toEqual([['中文']]);
});

it('replacing an upload with an unsupported file clears the previous unconfirmed crop', () => {
  const card = createBlankCard();
  const props = { cards: [card], selectedId: card.id, disabled: false, onDelete: () => {}, onSave: () => {} };
  const upload = (type: string) => {
    const input = find(
      render(() => CardDesigner(props)),
      (n) => n.type === 'input' && n.props.type === 'file',
    );
    (input.props.onChange as (event: unknown) => void)({ target: { files: [{ type, size: 20 }], value: 'file' } });
  };
  upload('image/png');
  expect(nodes(render(() => CardDesigner(props))).some((n) => n.type === AvatarCropper)).toBe(true);
  upload('image/gif');
  const tree = render(() => CardDesigner(props));
  expect(nodes(tree).some((n) => n.type === AvatarCropper)).toBe(false);
  expect(nodes(tree).some((n) => n.props.role === 'alert')).toBe(true);
});

it('selection flush reads the most recent raw card tags even before a rerender', async () => {
  const one = createBlankCard(),
    two = createBlankCard(),
    saved: { id: string; tags: string[] }[] = [];
  const props = {
    cards: [one, two],
    disabled: false,
    onDelete: () => {},
    onSave: (next: typeof one) => {
      saved.push({ id: next.id, tags: next.tags });
    },
  };
  let tree = render(() => CardDesigner(props));
  const selector = find(tree, (n) => n.type === 'select');
  await (selector.props.onChange as (event: unknown) => unknown)({ target: { value: one.id } });
  tree = render(() => CardDesigner(props));
  change(field(tree, '标签'), 'first,second，');
  await (find(tree, (n) => n.type === 'select').props.onChange as (event: unknown) => unknown)({
    target: { value: two.id },
  });
  expect(saved).toEqual([{ id: one.id, tags: ['first', 'second'] }]);
  expect(
    field(
      render(() => CardDesigner(props)),
      '标签',
    ).props.value,
  ).toBe('');
});

it('keyword preparation merges into the latest world draft rather than replacing a discrete change', async () => {
  const entry = createWorldBookEntry(),
    book = { ...createBlankWorldBook(), entries: [entry] },
    saved: (typeof book)[] = [];
  const props = {
    books: [book],
    selectedId: book.id,
    attachedIds: [],
    disabled: false,
    onAttach: () => {},
    onDelete: () => {},
    onSave: (next: typeof book) => {
      saved.push(next);
    },
  };
  let tree = render(() => WorldDesigner(props));
  click(find(tree, (n) => n.props.className === 'room-open'));
  tree = render(() => WorldDesigner(props));
  change(field(tree, '关键词'), 'alpha,beta,');
  tree = render(() => WorldDesigner(props));
  const checkbox = find(tree, (n) => n.type === 'input' && n.props.type === 'checkbox');
  (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } });
  await vi.advanceTimersByTimeAsync(1);
  expect(saved[0]?.entries[0]?.keys).toEqual(['alpha', 'beta']);
  expect(saved[0]?.entries[0]?.disabled).toBe(true);
});

it('returns focus to the adjacent world entry after deletion and preserves focus when cancelled', () => {
  const one = { ...createWorldBookEntry(), title: 'First' },
    two = { ...createWorldBookEntry(), title: 'Second' };
  const book = { ...createBlankWorldBook(), entries: [one, two] };
  const props = {
    books: [book],
    selectedId: book.id,
    attachedIds: [],
    disabled: false,
    onAttach: () => {},
    onDelete: () => {},
    onSave: () => {},
  };
  let tree = render(() => WorldDesigner(props));
  const openers = nodes(tree).filter((n) => n.props.className === 'room-open');
  let focused = '';
  if (typeof openers[1]?.props.ref === 'function') {
    (openers[1].props.ref as (button: unknown) => void)({
      focus() {
        focused = 'Second';
      },
    });
  }
  vi.stubGlobal('window', { confirm: () => false });
  click(button(tree, '删'));
  render(() => WorldDesigner(props));
  expect(focused).toBe('');
  vi.stubGlobal('window', { confirm: () => true });
  tree = render(() => WorldDesigner(props));
  click(button(tree, '删'));
  render(() => WorldDesigner(props));
  expect(focused).toBe('Second');
});

it('waits for the last-entry save before focusing the disabled add-entry button', async () => {
  const entry = createWorldBookEntry(),
    book = { ...createBlankWorldBook(), entries: [entry] };
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const props = {
    books: [book],
    selectedId: book.id,
    attachedIds: [],
    disabled: false,
    onAttach: () => {},
    onDelete: () => {},
    onSave: () => wait,
  };
  let tree = render(() => WorldDesigner(props)),
    focused = 0;
  const add = button(tree, '＋ 新增条目');
  const target = {
    disabled: true,
    focus() {
      if (!this.disabled) focused++;
    },
  };
  const ref = add.props.ref as { current: unknown } | undefined;
  if (ref) ref.current = target;
  click(button(tree, '删'));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  tree = render(() => WorldDesigner(props));
  expect(button(tree, '＋ 新增条目').props.disabled).toBe(true);
  expect(focused).toBe(0);
  release();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  target.disabled = false;
  render(() => WorldDesigner(props));
  expect(focused).toBe(1);
});

it('keeps world keywords raw until blur and asks before removing nonempty entries', async () => {
  const entry = { ...createWorldBookEntry(), title: 'Synthetic entry', content: 'Keep me' };
  const book = { ...createBlankWorldBook(), entries: [entry] },
    saved: (typeof book)[] = [];
  const props = {
    books: [book],
    selectedId: book.id,
    attachedIds: [],
    disabled: false,
    onAttach: () => {},
    onDelete: () => {},
    onSave: (next: typeof book) => {
      saved.push(next);
    },
  };
  let tree = render(() => WorldDesigner(props));
  const opener = find(tree, (n) => n.props.className === 'room-open');
  expect(opener.props['aria-expanded']).toBe(false);
  click(opener);
  tree = render(() => WorldDesigner(props));
  expect(find(tree, (n) => n.props.className === 'room-open').props['aria-expanded']).toBe(true);
  change(field(tree, '关键词'), 'alpha,beta，');
  tree = render(() => WorldDesigner(props));
  expect(field(tree, '关键词').props.value).toBe('alpha,beta，');
  await vi.advanceTimersByTimeAsync(500);
  expect(saved).toEqual([]);
  await (field(tree, '关键词').props.onBlur as () => unknown)();
  expect(saved[0]?.entries[0]?.keys).toEqual(['alpha', 'beta']);
  vi.stubGlobal('window', { confirm: () => false });
  click(
    button(
      render(() => WorldDesigner(props)),
      '删',
    ),
  );
  expect(text(render(() => WorldDesigner(props)))).toContain('Synthetic entry');
  expect(saved).toHaveLength(1);
  vi.stubGlobal('window', { confirm: () => true });
  click(
    button(
      render(() => WorldDesigner(props)),
      '删',
    ),
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(saved[1]?.entries).toEqual([]);
});

it('exposes portrait expansion and chosen portrait state', async () => {
  const card = createBlankCard();
  const props = { cards: [card], selectedId: card.id, disabled: false, onDelete: () => {}, onSave: () => {} };
  let tree = render(() => CardDesigner(props));
  expect(button(tree, '浏览图库').props['aria-expanded']).toBe(false);
  click(button(tree, '浏览图库'));
  tree = render(() => CardDesigner(props));
  expect(button(tree, '收起图库').props['aria-expanded']).toBe(true);
  const tile = find(tree, (n) => n.props.className === 'portrait-tile');
  click(tile);
  await vi.advanceTimersByTimeAsync(1);
  expect(
    find(
      render(() => CardDesigner(props)),
      (n) => n.props.className === 'portrait-tile selected',
    ).props['aria-pressed'],
  ).toBe(true);
});

it('reports waiting, real saving, success, and save errors locally', async () => {
  const card = createBlankCard();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const props = { cards: [card], selectedId: card.id, disabled: false, onDelete: () => {}, onSave: () => wait };
  const tree = render(() => CardDesigner(props));
  change(field(tree, '名字'), 'Changed');
  expect(
    text(
      find(
        render(() => CardDesigner(props)),
        (n) => n.props.role === 'status',
      ),
    ),
  ).toContain('待保存');
  const saving = click(
    button(
      render(() => CardDesigner(props)),
      '保存',
    ),
  );
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(
    text(
      find(
        render(() => CardDesigner(props)),
        (n) => n.props.role === 'status',
      ),
    ),
  ).toContain('保存中');
  release();
  await saving;
  expect(
    text(
      find(
        render(() => CardDesigner(props)),
        (n) => n.props.role === 'status',
      ),
    ),
  ).toContain('已保存');
});

function cropFixture() {
  const images: {
    onload: (() => void) | null;
    onerror: (() => void) | null;
    src: string;
    naturalWidth: number;
    naturalHeight: number;
  }[] = [];
  const revoked: string[] = [],
    confirmed: string[][] = [];
  vi.stubGlobal(
    'Image',
    class {
      onload = null;
      onerror = null;
      src = '';
      naturalWidth = 800;
      naturalHeight = 400;
      constructor() {
        images.push(this);
      }
    },
  );
  let url = 0;
  vi.stubGlobal('URL', {
    createObjectURL: () => `blob:synthetic-${++url}`,
    revokeObjectURL: (value: string) => {
      revoked.push(value);
    },
  });
  const draw = vi.fn();
  vi.stubGlobal('document', {
    createElement: () => ({
      getContext: () => ({ beginPath() {}, arc() {}, clip() {}, drawImage: draw, fillRect() {}, fillStyle: '' }),
      toDataURL: () => 'data:image/webp;base64,synthetic',
    }),
  });
  const props = {
    source: { name: 'A' } as File | string,
    disabled: false,
    onCancel: () => {},
    onConfirm: (...result: string[]) => {
      confirmed.push(result);
    },
  };
  const view = () => render(() => AvatarCropper(props));
  return { props, view, images, revoked, confirmed, draw };
}
it('clears the old crop immediately on source change and rejects old loads and old confirm handlers', () => {
  const h = cropFixture();
  h.view();
  h.images[0]?.onload?.();
  let tree = h.view();
  const oldConfirm = button(tree, '保存图片与头像');
  expect(oldConfirm.props.disabled).toBe(false);
  h.props.source = { name: 'B' } as File;
  tree = h.view();
  expect(button(tree, '保存图片与头像').props.disabled).toBe(true);
  expect(nodes(tree).some((n) => n.type === 'img')).toBe(false);
  click(oldConfirm);
  expect(h.confirmed).toEqual([]);
  h.images[0]?.onload?.();
  h.images[1]?.onerror?.();
  tree = h.view();
  expect(button(tree, '保存图片与头像').props.disabled).toBe(true);
  expect(nodes(tree).some((n) => n.props.role === 'alert')).toBe(true);
  h.props.source = { name: 'C' } as File;
  tree = h.view();
  expect(nodes(tree).some((n) => n.props.role === 'alert')).toBe(false);
  h.images[1]?.onload?.();
  expect(button(h.view(), '保存图片与头像').props.disabled).toBe(true);
  h.images[2]?.onload?.();
  tree = h.view();
  click(button(tree, '保存图片与头像'));
  expect(h.confirmed).toHaveLength(1);
  expect(h.draw.mock.calls[0]?.[0]).toBe(h.images[2]);
  host.reset();
  expect(h.revoked).toEqual(['blob:synthetic-1', 'blob:synthetic-2', 'blob:synthetic-3']);
});
it('lets the focused crop pan by arrow keys, accelerate with Shift, clamp, and reset', () => {
  const h = cropFixture();
  h.view();
  h.images[0]?.onload?.();
  const tree = h.view();
  const crop = find(tree, (n) => n.props.className === 'avatar-crop-window');
  expect(crop.props.tabIndex).toBe(0);
  const key = (key: string, shiftKey = false) => {
    const current = find(h.view(), (n) => n.props.className === 'avatar-crop-window');
    (current.props.onKeyDown as (event: unknown) => void)({ key, shiftKey, preventDefault() {} });
  };
  const left = () => (find(h.view(), (n) => n.type === 'img').props.style as { left: number }).left;
  const center = left();
  key('ArrowRight');
  const small = left() - center;
  expect(small).toBeGreaterThan(0);
  key('ArrowRight', true);
  expect(left() - center - small).toBeGreaterThan(small);
  for (let i = 0; i < 100; i++) key('ArrowRight', true);
  expect(left()).toBe(0);
  change(field(h.view(), '缩放'), '2');
  click(button(h.view(), '重置裁切'));
  expect(left()).toBe(center);
  expect(field(h.view(), '缩放').props.value).toBe(1);
});
