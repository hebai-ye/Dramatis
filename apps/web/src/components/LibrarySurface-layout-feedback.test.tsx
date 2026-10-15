import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LibrarySurface, type LibrarySurfaceProps } from './LibrarySurface';

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
const library = vi.hoisted(() => ({
  activeView: 'cards',
  busy: false,
  async requestAction(action: () => unknown) {
    try {
      await action();
    } catch {
      /* coordinator shows the global error */
    }
  },
}));
vi.mock('../lib/library-view', async (original) => ({
  ...(await original<typeof import('../lib/library-view')>()),
  useLibraryView: () => library,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: host.state.bind(host),
  useEffect: host.effect.bind(host),
  useLayoutEffect: host.effect.bind(host),
  useRef: (initial: unknown) => host.state(() => ({ current: initial }))[0],
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
let width = 400,
  resize: ((entries: unknown[]) => void) | undefined,
  disconnected = false;
const focused: string[] = [];
const props: LibrarySurfaceProps = {
  personas: [],
  cards: [],
  books: [],
  counts: { personas: 0, cards: 0, worldbooks: 0 },
  ready: true,
  mutationDisabled: false,
  world: null,
  onSavePersona: async () => {},
  onDeletePersona: async () => {},
  onSaveCard: async () => {},
  onDeleteCard: async () => {},
  onSaveBook: async () => {},
  onDeleteBook: async () => {},
  onAttach: async () => {},
  onDetach: async () => {},
  onImport: async () => ({
    ok: true,
    kind: 'cards',
    id: 'synthetic-card',
    warnings: [{ code: 'compat', message: 'Synthetic unknown field retained' }],
  }),
};
function run() {
  const surface = LibrarySurface(props);
  const browser = find(surface, (node) => typeof node.type === 'function' && node.props.view === 'cards');
  const tree = (browser.type as (props: Record<string, unknown>) => ReactNode)(browser.props);
  for (const node of nodes(tree)) {
    if (node.props.ref && typeof node.props.ref === 'object' && 'current' in node.props.ref) {
      node.props.ref.current = {
        getBoundingClientRect: () => ({ width }),
        closest: () => null,
        querySelector: () => ({ focus: () => focused.push('item') }),
        focus: () => focused.push(String(node.props.className)),
      };
    }
  }
  return tree;
}
function render() {
  host.begin();
  run();
  host.flush();
  host.begin();
  const tree = run();
  host.flush();
  return tree;
}
async function importFile() {
  const input = find(render(), (node) => node.type === 'input' && node.props.type === 'file');
  (input.props.onChange as (event: unknown) => void)({
    target: { files: [new File(['{}'], 'synthetic.json')], value: '' },
  });
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
beforeEach(() => {
  host.reset();
  width = 400;
  disconnected = false;
  focused.length = 0;
  library.activeView = 'cards';
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({ paddingLeft: '0', paddingRight: '0' }),
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: (entries: unknown[]) => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
  );
  props.onImport = async () => ({
    ok: true,
    kind: 'cards',
    id: 'synthetic-card',
    warnings: [{ code: 'compat', message: 'Synthetic unknown field retained' }],
  });
});
afterEach(() => {
  host.reset();
  vi.unstubAllGlobals();
});
it('uses the actual container width for list/detail navigation despite a wide viewport', () => {
  let tree = render();
  expect(String(nodes(tree)[0]?.props.className)).toContain('compact-layout');
  (
    find(tree, (node) => node.type === 'button' && text(node.props.children as ReactNode).startsWith('前往编辑区'))
      .props.onClick as () => void
  )();
  tree = render();
  expect(String(nodes(tree)[0]?.props.className)).toContain('showing-detail');
  expect(focused).toContain('ghost library-mobile-back');
  (
    find(tree, (node) => node.type === 'button' && text(node.props.children as ReactNode) === '返回素材列表').props
      .onClick as () => void
  )();
  tree = render();
  expect(String(nodes(tree)[0]?.props.className)).not.toContain('showing-detail');
  expect(focused).toContain('item');
});
it('responds to sidebar/container resizing and disconnects its observer on unmount', () => {
  render();
  width = 900;
  resize?.([{ contentRect: { width } }]);
  expect(String(nodes(render())[0]?.props.className)).not.toContain('compact-layout');
  width = 400;
  resize?.([{ contentRect: { width } }]);
  expect(String(nodes(render())[0]?.props.className)).toContain('compact-layout');
  host.reset();
  expect(disconnected).toBe(true);
});
it('shows compatibility warning details beside a successful library import', async () => {
  await importFile();
  const tree = render();
  expect(text(tree)).toContain('Synthetic unknown field retained');
  expect(find(tree, (node) => node.type === 'details').props.children).toBeTruthy();
  expect(text(tree)).toContain('1');
});
it('shows import failures next to the importing toolbar', async () => {
  props.onImport = async () => ({ ok: false, error: 'Synthetic malformed file' });
  await importFile();
  expect(text(render())).toContain('Synthetic malformed file');
  expect(find(render(), (node) => node.props.role === 'alert').props.children).toBeTruthy();
});
