import { describe, expect, it } from 'vitest';
import { protectUnsavedRecovery } from './recovery-protection';

function leaveEvent(): Event {
  const event = new Event('beforeunload', { cancelable: true });
  Object.defineProperty(event, 'returnValue', { writable: true, value: '' });
  return event;
}

describe('未保存恢复码的页面离开保护', () => {
  it('存在恢复码时请求浏览器警告，不把码放进提示', () => {
    const page = new EventTarget();
    const dispose = protectUnsavedRecovery(() => 'fixture-sensitive-recovery', page);
    const event = leaveEvent();
    page.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(String(event.returnValue)).not.toContain('fixture-sensitive-recovery');
    expect(String(event.returnValue)).not.toBe('');
    dispose();
  });

  it('同步清掉内存码后，立刻进行的账户reload可以继续', () => {
    let code: string | null = 'fixture-sensitive-recovery';
    const page = new EventTarget();
    const dispose = protectUnsavedRecovery(() => code, page);
    code = null;
    const event = leaveEvent();
    page.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    dispose();
  });

  it('面板卸载解绑，不残留离开提示', () => {
    const page = new EventTarget();
    const dispose = protectUnsavedRecovery(() => 'fixture-sensitive-recovery', page);
    dispose();
    const event = leaveEvent();
    page.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
