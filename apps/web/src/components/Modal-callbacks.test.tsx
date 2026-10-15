import { conversationId, roomId, type Scene, sceneId } from '@dramatis/core';
import type { ReactElement, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DialogShell } from './DialogShell';
import { Modal } from './Modal';
import { SceneDialog } from './SceneDialog';

const callbacks = vi.hoisted(() => ({ events: [] as string[], effects: [] as Array<() => unknown> }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
  useLayoutEffect: (effect: () => unknown) => {
    callbacks.effects.push(effect);
  },
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useId: () => 'title',
}));
const fixtureScene: Scene = {
  id: sceneId('callback-scene'),
  roomId: roomId('callback-room'),
  conversationId: conversationId('callback-conversation'),
  title: '原场景',
  location: '',
  worldTime: '',
  castPolicy: 'open',
  cast: [],
  summary: '原设定',
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
  endedAt: null,
  deletedAt: null,
};
function nodes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element as ReactElement<Record<string, unknown>>, ...nodes(element.props?.children)];
}
describe('Modal close callbacks (no browser focus claim)', () => {
  it.each(['escape', 'scrim', 'button'])('awaits SceneDialog summary before closing through %s', async (route) => {
    callbacks.events = [];
    callbacks.effects = [];
    let resolveSave!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const scene = SceneDialog({
      scene: fixtureScene,
      instances: [],
      disabled: false,
      onClose: () => callbacks.events.push('close'),
      onSave: async () => {
        callbacks.events.push('save-start');
        await pending;
        callbacks.events.push('save-done');
      },
      onStartNewScene: async () => ({ status: 'complete' }),
    });
    // Mount only SceneDialog's effects; this callback test does not claim DOM focus/guards.
    callbacks.effects.splice(0).forEach((effect) => {
      effect();
    });
    const summary = nodes(scene).find((node) => node.type === 'textarea');
    if (!summary) throw Error('summary missing');
    (summary.props.onChange as (event: unknown) => void)({ target: { value: '未保存' }, nativeEvent: {} });
    const modal = Modal(scene.props);
    const tree = DialogShell(modal.props);
    const all = nodes(tree);
    if (route === 'escape') {
      const dialog = all.find((node) => node.props.role === 'dialog');
      if (!dialog) throw Error('dialog missing');
      (dialog.props.onKeyDown as (event: unknown) => void)({
        key: 'Escape',
        keyCode: 27,
        nativeEvent: { isComposing: false },
        preventDefault: () => {},
        stopPropagation: () => {},
      });
    } else {
      const button = all.find(
        (node) => node.type === 'button' && node.props.className === (route === 'scrim' ? 'dialog-scrim' : 'ghost'),
      );
      if (!button) throw Error('close button missing');
      (button.props.onClick as () => void)();
    }
    await vi.waitFor(() => expect(callbacks.events).toEqual(['save-start']));
    resolveSave();
    await vi.waitFor(() => expect(callbacks.events).toEqual(['save-start', 'save-done', 'close']));
  });
});
