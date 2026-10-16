import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

function mount() {
  const nodes = new Map(
    ['#out', '#probe-status', '#probe-data'].map((selector) => [selector, { textContent: '', setAttribute: vi.fn() }]),
  );
  vi.stubGlobal('document', { querySelector: (selector: string) => nodes.get(selector) ?? null });
  return nodes;
}

describe('synthetic probe integration feedback in Node WebCrypto', () => {
  it('completes the actual crypto self-check with a passed visible summary', async () => {
    const nodes = mount();
    await import('./crypto-probe');
    await vi.waitFor(
      () => {
        expect(nodes.get('#probe-status')?.textContent).toMatch(/^通过 ·/);
      },
      { timeout: 15_000 },
    );
    expect(nodes.get('#probe-data')?.textContent).toContain('假数据');
    expect(nodes.get('#probe-status')?.textContent).toContain('失败 0');
    expect(nodes.get('#out')?.textContent).toContain('全部检查结束');
  }, 20_000);

  it('completes the actual two-device memory sync check with a passed visible summary', async () => {
    const nodes = mount();
    await import('./sync-probe');
    await vi.waitFor(
      () => {
        expect(nodes.get('#probe-status')?.textContent).toMatch(/^通过 ·/);
      },
      { timeout: 15_000 },
    );
    expect(nodes.get('#probe-data')?.textContent).toContain('内存后端');
    expect(nodes.get('#probe-status')?.textContent).toContain('失败 0');
    expect(nodes.get('#out')?.textContent).toContain('全部检查结束');
  }, 20_000);
});
