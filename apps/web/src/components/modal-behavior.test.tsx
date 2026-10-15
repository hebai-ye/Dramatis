import { createBlankCard, createInstanceFor, roomId, type Scene, sceneId } from '@dramatis/core';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CastDetail } from './CastDetail';
import { CastPanel } from './CastPanel';
import { DialogShell } from './DialogShell';
import { Modal, useModalSaves } from './Modal';
import { NewConversationDialog } from './NewConversationDialog';
import { SceneDialog } from './SceneDialog';

// Real component handlers/controllers; hooks and minimal DOM are controlled because
// this repository intentionally has no jsdom dependency. Browser layout stays separate.
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
  useLayoutEffect: host.effect,
  useCallback: (callback: unknown) => callback,
  useMemo: (callback: () => unknown) => callback(),
  useId: () => host.state(() => `fixture-${Math.random()}`)[0],
}));
vi.mock('react-dom', () => ({ createPortal: (content: ReactNode) => content }));

function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as ReactElement<Record<string, unknown>>;
  return [node, ...nodes(node.props.children as ReactNode)];
}
function text(tree: ReactNode): string {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree === null || tree === undefined || typeof tree === 'boolean') return '';
  return typeof tree === 'object' ? text((tree as ReactElement<{ children: ReactNode }>).props.children) : String(tree);
}
function button(tree: ReactNode, label: string) {
  const node = nodes(tree).find((node) => node.type === 'button' && text(node.props.children as ReactNode) === label);
  if (!node) throw new Error(`Missing ${label}`);
  return node;
}
function click(node: ReactElement<Record<string, unknown>> | undefined) {
  if (!node) throw new Error('Missing button fixture');
  return (node.props.onClick as () => unknown)();
}
function render<T>(run: () => T): T {
  host.begin();
  const tree = run();
  host.flush();
  return tree;
}
function change(node: ReactElement<Record<string, unknown>> | undefined, value: string) {
  if (!node) throw new Error('Missing field fixture');
  (node.props.onChange as (event: unknown) => void)({ target: { value }, nativeEvent: {} });
}
class ElementFixture {
  tagName = 'BUTTON';
  nodeType = 1;
  isConnected = true;
  attrs = new Map<string, string>();
  style = { setProperty: (key: string, value: string) => this.attrs.set(key, value) };
  candidates: ElementFixture[] = [];
  initial: ElementFixture | null = null;
  getAttribute(key: string) {
    return this.attrs.get(key) ?? null;
  }
  getAttributeNames() {
    return [...this.attrs.keys()];
  }
  setAttribute(key: string, value: string) {
    this.attrs.set(key, value);
  }
  removeAttribute(key: string) {
    this.attrs.delete(key);
  }
  contains(target: unknown) {
    return target === this || this.candidates.includes(target as ElementFixture);
  }
  matches(selector: string) {
    return selector === ':disabled' && this.attrs.has('disabled');
  }
  closest() {
    return this.attrs.has('inert') ? this : null;
  }
  getClientRects() {
    return [this.getBoundingClientRect()];
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 100 };
  }
  querySelector() {
    return this.initial;
  }
  querySelectorAll() {
    return this.candidates;
  }
  focus() {
    doc.activeElement = this;
  }
}
const opener = new ElementFixture(),
  fallback = new ElementFixture(),
  background = new ElementFixture();
const viewportEvents = new Map<string, () => void>();
const viewport = {
  height: 410,
  offsetTop: 25,
  addEventListener: (key: string, handler: () => void) => viewportEvents.set(key, handler),
  removeEventListener: (key: string) => viewportEvents.delete(key),
};
const doc = {
  activeElement: opener as ElementFixture | null,
  body: { children: [background] as ElementFixture[] },
  querySelector: () => fallback,
  addEventListener: () => {},
  removeEventListener: () => {},
};
function createScene({ roomId: worldId, title = '原场景' }: { roomId: Scene['roomId']; title?: string }): Scene {
  return {
    id: sceneId('scene-fixture'),
    roomId: worldId,
    conversationId: null,
    title,
    location: '',
    worldTime: '',
    castPolicy: 'locked',
    cast: [],
    summary: '',
    createdAt: '',
    updatedAt: '',
    endedAt: null,
    deletedAt: null,
  };
}
function gate() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  host.reset();
  opener.isConnected = true;
  background.attrs.clear();
  viewportEvents.clear();
  doc.activeElement = opener;
  vi.stubGlobal('document', doc);
  vi.stubGlobal('HTMLElement', ElementFixture);
  vi.stubGlobal('Node', ElementFixture);
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('window', {
    innerWidth: 390,
    innerHeight: 844,
    visualViewport: viewport,
    addEventListener: () => {},
    removeEventListener: () => {},
    clearTimeout,
    setTimeout,
  });
});
afterEach(() => {
  host.reset();
  vi.unstubAllGlobals();
});
function mountShell(extra: Record<string, unknown> = {}) {
  let closed = 0;
  const props = {
    label: '夹具',
    returnFocus: opener as unknown as HTMLElement,
    onClose: () => closed++,
    children: '正文',
    ...extra,
  };
  host.begin();
  let tree = DialogShell(props);
  const backdrop = new ElementFixture(),
    section = new ElementFixture(),
    close = new ElementFixture(),
    first = new ElementFixture(),
    last = new ElementFixture();
  section.candidates = [first, close, last];
  section.initial = first;
  const attach = () => {
    for (const node of nodes(tree)) {
      const ref = node.props.ref as { current: unknown } | undefined;
      if (!ref) continue;
      ref.current =
        node.props.role === 'dialog' ? section : node.type === 'div' ? backdrop : node.type === 'button' ? close : null;
    }
  };
  attach();
  host.flush();
  return {
    first,
    last,
    close,
    backdrop,
    get closed() {
      return closed;
    },
    tree: () => tree,
    rerender() {
      host.begin();
      tree = DialogShell(props);
      attach();
      host.flush();
      return tree;
    },
    key(key: string, shiftKey = false, composing = false) {
      const dialog = nodes(tree).find((node) => node.props.role === 'dialog');
      if (!dialog) throw new Error('Missing dialog fixture');
      (dialog.props.onKeyDown as (event: unknown) => void)({
        key,
        shiftKey,
        keyCode: composing ? 229 : 0,
        nativeEvent: { isComposing: composing },
        preventDefault() {},
        stopPropagation() {},
      });
    },
  };
}

describe('shared modal behavior', () => {
  it('Modal mounts the shared shell and captures the opener for focus return', () => {
    const tree = render(() => Modal({ label: '场景', onClose() {}, head: <strong>场景</strong>, children: '正文' }));
    expect(tree.type).toBe(DialogShell);
    expect(tree.props.returnFocus).toBe(opener);
    expect(tree.props.appearance).toBe('modal');
  });
  it('keeps custom headings, footer cancellation and dirty confirmation within one shell', () => {
    const h = mountShell({
      appearance: 'modal',
      head: <strong>场景</strong>,
      closeLabel: '取消',
      footer: (close: () => void) => (
        <button type="button" onClick={close}>
          页脚取消
        </button>
      ),
      guard: { kind: 'dirty', message: '保留编辑？' },
    });
    expect(text(h.tree())).toContain('场景');
    expect(nodes(h.tree()).filter((node) => node.props.role === 'dialog')).toHaveLength(1);
    click(button(h.tree(), '页脚取消'));
    const tree = h.rerender();
    expect(h.closed).toBe(0);
    expect(text(tree)).toContain('保留编辑？');
    expect(nodes(tree).find((node) => node.props.className === 'modal-body')?.props.inert).toBe(true);
    click(button(tree, '继续编辑'));
    h.rerender();
    h.key('Escape');
    h.rerender();
    click(button(h.tree(), '放弃更改并继续'));
    expect(h.closed).toBe(1);
  });
  it('isolates background, focuses the marked task field, traps Tab and restores focus', () => {
    const h = mountShell({ initialFocus: '[data-dialog-initial-focus]' });
    expect(background.getAttribute('inert')).toBe('');
    expect(doc.activeElement).toBe(h.first);
    expect(h.backdrop.attrs.get('--dialog-height')).toBe('410px');
    expect(h.backdrop.attrs.get('--dialog-top')).toBe('25px');
    h.last.focus();
    h.key('Tab');
    expect(doc.activeElement).toBe(h.first);
    h.first.focus();
    h.key('Tab', true);
    expect(doc.activeElement).toBe(h.last);
    h.key('Escape', false, true);
    expect(h.closed).toBe(0);
    h.key('Escape');
    expect(h.closed).toBe(1);
    host.reset();
    expect(background.getAttribute('inert')).toBe(null);
    expect(doc.activeElement).toBe(opener);
  });
  it('blocks close while busy and falls back when the opener was removed', () => {
    const h = mountShell({ guard: { kind: 'busy', message: '正在保存' } });
    h.key('Escape');
    h.rerender();
    expect(h.closed).toBe(0);
    expect(text(h.tree())).toContain('正在保存');
    opener.isConnected = false;
    host.reset();
    expect(doc.activeElement).toBe(fallback);
  });
});

describe('dialog consumers', () => {
  it('closes after its own successful scene transition updates the scene snapshot', async () => {
    const wait = gate();
    let closed = 0;
    const props = {
      scene: createScene({ roomId: roomId('own-transition') }),
      instances: [],
      disabled: false,
      onClose: () => {
        closed++;
      },
      async onSave() {},
      onStartNewScene: vi.fn(async () => {
        await wait.promise;
        return { status: 'complete' as const };
      }),
    };
    let tree = render(() => SceneDialog(props));
    const switching = click(button(tree.props.footer as ReactNode, '从这里切换场景'));
    await vi.waitFor(() => expect(props.onStartNewScene).toHaveBeenCalledOnce());
    props.scene = { ...props.scene, id: sceneId('created-scene'), title: '新场' };
    tree = render(() => SceneDialog(props));
    wait.resolve();
    await switching;
    expect(closed).toBe(1);
  });
  it('retries failed autosave writes before closing but never repeats a discarded manual action', async () => {
    let nameWrites = 0,
      createWrites = 0;
    const saves = render(() => useModalSaves('retry-fields'));
    await saves.save('name', async () => {
      if (++nameWrites === 1) throw new Error('retry me');
    });
    await saves.save(
      'create',
      async () => {
        createWrites++;
        throw new Error('manual failure');
      },
      false,
    );
    expect(await saves.flush()).toBe(true);
    expect(nameWrites).toBe(2);
    expect(createWrites).toBe(1);
  });
  it('does not report success or reuse late failures after the target changes', async () => {
    const old = gate();
    let saves = render(() => useModalSaves('role-a'));
    const write = saves.save('name', () => old.promise);
    saves = render(() => useModalSaves('role-b'));
    old.resolve();
    expect(await write).toBe(false);
    saves = render(() => useModalSaves('role-b'));
    expect(saves.error).toBe(null);
    expect(saves.busy).toBe(false);
  });
  it('flushes scene summary into the current scene before starting the next scene', async () => {
    const wait = gate(),
      events: string[] = [];
    const props = {
      scene: createScene({ roomId: roomId('summary-order') }),
      instances: [],
      disabled: false,
      onClose: () => {
        events.push('close');
      },
      onSave: async (patch: Partial<Scene>) => {
        if (patch.summary) {
          events.push(`summary:${patch.summary}`);
          return wait.promise;
        }
      },
      onStartNewScene: async () => {
        events.push('next');
        return { status: 'complete' as const };
      },
    };
    let tree = render(() => SceneDialog(props));
    change(
      nodes(tree).find((node) => node.type === 'textarea'),
      '旧场的设定',
    );
    tree = render(() => SceneDialog(props));
    const switching = click(button(tree.props.footer as ReactNode, '从这里切换场景'));
    await vi.waitFor(() => expect(events).toEqual(['summary:旧场的设定']));
    wait.resolve();
    await switching;
    expect(events).toEqual(['summary:旧场的设定', 'next', 'close']);
  });
  it('keeps a failed field visible when another concurrent field saves successfully', async () => {
    const first = gate(),
      second = gate();
    let saves = render(() => useModalSaves('concurrent-fields'));
    const firstWrite = saves.save('name', () => first.promise);
    first.reject(new Error('名称未保存'));
    await firstWrite;
    saves = render(() => useModalSaves('concurrent-fields'));
    const secondWrite = saves.save('affinity', () => second.promise);
    second.resolve();
    await secondWrite;
    saves = render(() => useModalSaves('concurrent-fields'));
    expect(saves.error).toContain('名称未保存');
  });
  it('new conversation protects edited fields and exposes a guarded footer cancel', () => {
    const props = {
      mode: 'new-world' as const,
      cards: [],
      worldBooks: [],
      defaultCardIds: [],
      attachedBookIds: [],
      disabled: false,
      onClose() {},
      onSubmit() {},
    };
    let tree = render(() => NewConversationDialog(props));
    change(
      nodes(tree).find((node) => node.type === 'input'),
      '更改世界',
    );
    tree = render(() => NewConversationDialog(props));
    expect(tree.props.guard?.kind).toBe('dirty');
    let canceled = 0;
    const footer = tree.props.footer as (close: () => void) => ReactNode;
    click(
      button(
        footer(() => canceled++),
        '取消',
      ),
    );
    expect(canceled).toBe(1);
  });
  it('scene protects unsaved manual fields while retaining the summary flush close path', () => {
    const scene = createScene({ roomId: roomId('modal-world'), title: '原场景' });
    const props = {
      scene,
      instances: [],
      disabled: false,
      onClose() {},
      async onSave() {},
      async onStartNewScene() {
        return { status: 'complete' as const };
      },
    };
    let tree = render(() => SceneDialog(props));
    change(
      nodes(tree).find((node) => node.type === 'input'),
      '新草稿',
    );
    tree = render(() => SceneDialog(props));
    expect(tree.props.guard?.kind).toBe('dirty');
  });
  it('cast rows open their own details during readonly/busy mode', () => {
    const card = createBlankCard({ name: '同名' });
    const a = createInstanceFor(card, roomId('cast-world')),
      b = createInstanceFor(card, roomId('cast-world'));
    const opened: string[] = [];
    const tree = render(() =>
      CastPanel({
        instances: [a, b],
        scene: createScene({ roomId: a.roomId }),
        disabled: true,
        onSetPresence() {},
        onRename() {},
        onRemove() {},
        onOpenDetail: (id) => opened.push(id),
      }),
    );
    const details = nodes(tree).filter(
      (node) => node.type === 'button' && text(node.props.children as ReactNode) === '详情',
    );
    expect(details).toHaveLength(2);
    expect(details[1]?.props.disabled).not.toBe(true);
    click(details[1]);
    expect(opened).toEqual([b.id]);
    expect(details[1]?.props['aria-label']).toContain('同名');
  });
  it('cast detail keeps unfinished autosave drafts on normal close', async () => {
    const instance = createInstanceFor(createBlankCard({ name: '原名' }), roomId('cast-world'));
    const renamed: string[] = [];
    const props = {
      instance,
      card: null,
      memories: [],
      disabled: false,
      onClose() {},
      onRename: (_id: string, name: string) => {
        renamed.push(name);
      },
      onSetPresence() {},
      onSetRelationship() {},
      onRemove() {},
      async onRevertChange() {},
    };
    let tree = render(() => CastDetail(props));
    const input = nodes(tree.props.head as ReactNode).find((node) => node.type === 'input');
    change(input, '新名');
    tree = render(() => CastDetail(props));
    await (tree.props.onClose as () => void)();
    expect(renamed).toEqual(['新名']);
  });
  it('new conversation waits for submission and keeps a failed draft available', async () => {
    const wait = gate();
    let closed = 0,
      submitted = 0;
    const props = {
      mode: 'new-world' as const,
      cards: [],
      worldBooks: [],
      defaultCardIds: [],
      attachedBookIds: [],
      disabled: false,
      onClose: () => closed++,
      onSubmit: () => {
        submitted++;
        return wait.promise;
      },
    };
    let tree = render(() => NewConversationDialog(props));
    change(
      nodes(tree).find((node) => node.type === 'input'),
      '保留的草稿',
    );
    tree = render(() => NewConversationDialog(props));
    const footer = tree.props.footer as (close: () => void) => ReactNode;
    const submission = click(
      button(
        footer(() => {}),
        '开始',
      ),
    );
    tree = render(() => NewConversationDialog(props));
    expect(tree.props.guard?.kind).toBe('busy');
    click(
      button(
        (tree.props.footer as (close: () => void) => ReactNode)(() => {}),
        '开始',
      ),
    );
    expect(submitted).toBe(1);
    wait.reject(new Error('保存失败'));
    await submission;
    tree = render(() => NewConversationDialog(props));
    expect(closed).toBe(0);
    expect(text(tree)).toContain('保存失败');
    expect(nodes(tree).find((node) => node.type === 'input')?.props.value).toBe('保留的草稿');
  });
  it('scene keeps open on failed save and closes only after a successful save', async () => {
    const wait = gate();
    let closed = 0;
    const props = {
      scene: createScene({ roomId: roomId('scene-wait') }),
      instances: [],
      disabled: false,
      onClose: () => closed++,
      onSave: () => wait.promise,
      async onStartNewScene() {
        return { status: 'complete' as const };
      },
    };
    let tree = render(() => SceneDialog(props));
    const action = click(button(tree.props.footer as ReactNode, '保存当前场景'));
    tree = render(() => SceneDialog(props));
    expect(tree.props.guard?.kind).toBe('busy');
    expect(closed).toBe(0);
    wait.reject(new Error('存储失败'));
    await action;
    tree = render(() => SceneDialog(props));
    expect(closed).toBe(0);
    expect(text(tree)).toContain('存储失败');
    props.onSave = () => Promise.resolve();
    await click(button(render(() => SceneDialog(props)).props.footer as ReactNode, '保存当前场景'));
    expect(closed).toBe(1);
  });
});
