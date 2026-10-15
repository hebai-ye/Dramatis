import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

vi.mock('../lib/viewport', () => ({ useCoarsePointer: () => false }));
function find(node: unknown, type: string): ReactElement<Record<string, unknown>> | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.type === type) return element;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const match = find(child, type);
    if (match) return match;
  }
  return undefined;
}
describe('发送按钮和键盘采用相同守卫', () => {
  for (const state of [
    { bridgeOpen: true, busy: false, disabled: false },
    { bridgeOpen: false, busy: true, disabled: false },
    { bridgeOpen: false, busy: false, disabled: true },
  ]) {
    it(`拒绝发送 ${JSON.stringify(state)}`, () => {
      const send = vi.fn();
      const tree = Composer({
        ...state,
        value: 'draft',
        onChange: vi.fn(),
        placeholder: '',
        manualMode: true,
        onSend: send,
        onStop: vi.fn(),
      });
      const input = find(tree, 'textarea');
      if (!input) throw new Error('Composer textarea missing');
      (input.props.onKeyDown as (event: unknown) => void)({
        key: 'Enter',
        shiftKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: vi.fn(),
      });
      expect(send).not.toHaveBeenCalled();
    });
  }
  it('允许时Enter发送而Shift/组合确认不发送', () => {
    const send = vi.fn();
    const tree = Composer({
      bridgeOpen: false,
      busy: false,
      disabled: false,
      value: 'draft',
      onChange: vi.fn(),
      placeholder: '',
      manualMode: false,
      onSend: send,
      onStop: vi.fn(),
    });
    const key = find(tree, 'textarea')?.props.onKeyDown as (event: unknown) => void;
    key({ key: 'Enter', shiftKey: true, nativeEvent: { isComposing: false } });
    key({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true } });
    expect(send).not.toHaveBeenCalled();
    key({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: vi.fn() });
    expect(send).toHaveBeenCalledOnce();
  });
});
