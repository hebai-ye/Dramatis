import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProbeReporter } from './probe-reporter';

afterEach(() => vi.unstubAllGlobals());

function mount() {
  const nodes = new Map(
    ['#out', '#probe-status', '#probe-data'].map((selector) => [selector, { textContent: '', setAttribute: vi.fn() }]),
  );
  vi.stubGlobal('document', { querySelector: (selector: string) => nodes.get(selector) ?? null });
  return nodes;
}

describe('synthetic probe visible summary', () => {
  it('shows running, fake-data scope, and passed counts after all checks succeed', () => {
    const nodes = mount();
    const report = createProbeReporter('假数据 · 内存后端');
    expect(nodes.get('#probe-data')?.textContent).toBe('假数据 · 内存后端');
    expect(nodes.get('#probe-status')?.textContent).toContain('运行中');
    report.check('one', true);
    report.finish();
    expect(nodes.get('#probe-status')?.textContent).toContain('通过 · 检查通过 1 / 失败 0');
  });

  it('a false check remains a failed run after later successes', () => {
    const nodes = mount();
    const report = createProbeReporter('假数据');
    report.check('first', false);
    report.check('second', true);
    report.finish();
    expect(nodes.get('#probe-status')?.textContent).toContain('失败 · 检查通过 1 / 失败 1');
    expect(nodes.get('#out')?.textContent).toContain('❌ first');
  });

  it('unexpected rejected operations are visible failures with preserved prior logs', () => {
    const nodes = mount();
    const report = createProbeReporter('假数据');
    report.log('initial step');
    report.fail(new Error('synthetic failure'));
    expect(nodes.get('#probe-status')?.textContent).toContain('失败');
    expect(nodes.get('#out')?.textContent).toBe('initial step\n探针失败：synthetic failure');
  });
});
