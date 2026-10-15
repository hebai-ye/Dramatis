import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

const pointer = vi.hoisted(() => ({ coarse: false }));
vi.mock('../lib/viewport', () => ({ useCoarsePointer: () => pointer.coarse }));

function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as ReactElement<Record<string, unknown>>;
  return [element, ...nodes(element.props.children as ReactNode)];
}
function pressEnter(tree: ReactNode, event: unknown): void {
  const textarea = nodes(tree).find((node) => node.type === 'textarea');
  if (!textarea) throw new Error('Composer textarea missing');
  (textarea.props.onKeyDown as (event: unknown) => void)(event);
}

describe('Composer Enter submission', () => {
  beforeEach(() => {
    pointer.coarse = false;
  });
  it.each([
    { value: 'hello', disabled: true, busy: false, bridgeOpen: false },
    { value: 'hello', disabled: false, busy: true, bridgeOpen: false },
    { value: 'hello', disabled: false, busy: false, bridgeOpen: true },
    { value: '  ', disabled: false, busy: false, bridgeOpen: false },
  ])('does not submit when the button cannot send: %o', (state) => {
    const onSend = vi.fn();
    const tree = Composer({
      ...state,
      onSend,
      onChange: () => {},
      onStop: () => {},
      manualMode: false,
      placeholder: 'Message',
    });
    pressEnter(tree, {
      key: 'Enter',
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => {},
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends enabled nonempty text on desktop Enter', () => {
    const onSend = vi.fn();
    const tree = Composer({
      value: 'hello',
      disabled: false,
      busy: false,
      bridgeOpen: false,
      manualMode: false,
      placeholder: 'Message',
      onSend,
      onChange: () => {},
      onStop: () => {},
    });
    pressEnter(tree, {
      key: 'Enter',
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => {},
    });
    expect(onSend).toHaveBeenCalledOnce();
  });

  it.each([
    { shiftKey: true, isComposing: false, coarse: false },
    { shiftKey: false, isComposing: true, coarse: false },
    { shiftKey: false, isComposing: false, coarse: true },
  ])('preserves newline input for Shift, IME and coarse pointers: %o', ({ shiftKey, isComposing, coarse }) => {
    pointer.coarse = coarse;
    const onSend = vi.fn();
    const preventDefault = vi.fn();
    const tree = Composer({
      value: 'hello',
      disabled: false,
      busy: false,
      bridgeOpen: false,
      manualMode: false,
      placeholder: 'Message',
      onSend,
      onChange: () => {},
      onStop: () => {},
    });
    pressEnter(tree, {
      key: 'Enter',
      shiftKey,
      nativeEvent: { isComposing },
      preventDefault,
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
