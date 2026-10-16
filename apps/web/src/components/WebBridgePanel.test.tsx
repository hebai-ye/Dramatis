import { messageId } from '@dramatis/core';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebBridgePanel } from './WebBridgePanel';

const host = vi.hoisted(() => ({
  cells: [] as unknown[],
  cursor: 0,
  asks: 0,
  resolve: null as null | ((text: string) => void),
  replayEffects: false,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (run: () => unknown) => {
    const cleanup = run();
    if (host.replayEffects) {
      if (typeof cleanup === 'function') cleanup();
      run();
    }
  },
  useState: (initial: unknown) => {
    const i = host.cursor++;
    if (!(i in host.cells)) host.cells[i] = typeof initial === 'function' ? initial() : initial;
    return [
      host.cells[i],
      (next: unknown) => {
        host.cells[i] = typeof next === 'function' ? next(host.cells[i]) : next;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = host.cursor++;
    host.cells[i] ??= { current: initial };
    return host.cells[i];
  },
}));
vi.mock('../lib/local-bridge', () => ({
  probeLocalBridge: async () => ({ reachable: true, attached: true }),
  askLocalBridge: () => {
    host.asks++;
    return new Promise<string>((resolve) => {
      host.resolve = resolve;
    });
  },
}));
beforeEach(() => {
  host.cells = [];
  host.cursor = 0;
  host.asks = 0;
  host.resolve = null;
  host.replayEffects = false;
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible' });
});
afterEach(() => vi.unstubAllGlobals());
function text(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(text).join('');
  return node && typeof node === 'object' ? text((node as ReactElement<{ children: unknown }>).props?.children) : '';
}
function nodes(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (!node || typeof node !== 'object') return [];
  const e = node as ReactElement<Record<string, unknown>>;
  return [e, ...(Array.isArray(e.props?.children) ? e.props.children : [e.props?.children]).flatMap(nodes)];
}
async function drain() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
it('管理员助手同帧只启动一次，返回仅填入而不自动应用', async () => {
  const onAdmin = vi.fn(async () => ({ status: 'confirmed' as const, messageId: messageId('m') }));
  const props = {
    bridge: { stage: 'admin' as const, prompt: '合成', sourceKey: 'a' },
    busy: false,
    disabled: false,
    onReply: vi.fn(),
    onAnalysis: vi.fn(),
    onAdmin,
    onSkip: vi.fn(),
  };
  const render = () => {
    host.cursor = 0;
    return WebBridgePanel(props);
  };
  render();
  await drain();
  const helper = nodes(render()).find((e) => e.type === 'button' && text(e).includes('本地助手'));
  if (!helper) throw new Error('missing helper');
  (helper.props.onClick as () => void)();
  (helper.props.onClick as () => void)();
  expect(host.asks).toBe(1);
  host.resolve?.('合成助手回复');
  await drain();
  const ready = render();
  expect(nodes(ready).find((e) => e.type === 'textarea')?.props.value).toBe('合成助手回复');
  expect(onAdmin).not.toHaveBeenCalled();
  const apply = nodes(ready).find((e) => e.type === 'button' && /应用回复|收下这次起草/.test(text(e)));
  if (!apply) throw new Error('missing apply');
  (apply.props.onClick as () => void)();
  await drain();
  expect(onAdmin).toHaveBeenCalledOnce();
});
it('StrictMode effect 重放后助手完成仍可填入与解锁', async () => {
  host.replayEffects = true;
  const props = {
    bridge: { stage: 'admin' as const, prompt: '合成', sourceKey: 'a' },
    busy: false,
    disabled: false,
    onReply: vi.fn(),
    onAnalysis: vi.fn(),
    onAdmin: vi.fn(),
    onSkip: vi.fn(),
  };
  const render = () => {
    host.cursor = 0;
    return WebBridgePanel(props);
  };
  render();
  await drain();
  const helper = nodes(render()).find((e) => e.type === 'button' && text(e).includes('一键用'));
  if (!helper) throw new Error('missing helper');
  (helper.props.onClick as () => void)();
  host.resolve?.('重放后的合成回复');
  await drain();
  expect(nodes(render()).find((e) => e.type === 'textarea')?.props.value).toBe('重放后的合成回复');
});
it('复制被拒绝时显示可手动复制的提示词', async () => {
  vi.stubGlobal('navigator', {
    clipboard: {
      writeText: async () => {
        throw new Error('denied');
      },
    },
  });
  const props = {
    bridge: { stage: 'admin' as const, prompt: '手动复制内容', sourceKey: 'a' },
    busy: false,
    disabled: false,
    onReply: vi.fn(),
    onAnalysis: vi.fn(),
    onAdmin: vi.fn(),
    onSkip: vi.fn(),
  };
  const render = () => {
    host.cursor = 0;
    return WebBridgePanel(props);
  };
  const copy = nodes(render()).find((e) => e.type === 'button' && text(e).includes('复制提示词'));
  if (!copy) throw new Error('missing copy');
  (copy.props.onClick as () => void)();
  await drain();
  expect(text(render())).toContain('复制失败');
  expect(nodes(render()).find((e) => e.type === 'details' && e.props.className === 'bridge-prompt')?.props.open).toBe(
    true,
  );
});
it('来源明确失效后禁止重复应用，仍保留粘贴内容', async () => {
  const onAdmin = vi.fn(async () => ({ status: 'rejected' as const, reason: '起草来源已经变化' }));
  const props = {
    bridge: { stage: 'admin' as const, prompt: '合成', sourceKey: 'a' },
    busy: false,
    disabled: false,
    onReply: vi.fn(),
    onAnalysis: vi.fn(),
    onAdmin,
    onSkip: vi.fn(),
  };
  const render = () => {
    host.cursor = 0;
    return WebBridgePanel(props);
  };
  const input = nodes(render()).find((e) => e.type === 'textarea');
  if (!input) throw new Error('missing paste');
  (input.props.onChange as (e: unknown) => void)({ target: { value: '保留的回复' } });
  const apply = nodes(render()).find((e) => e.type === 'button' && text(e) === '应用回复');
  if (!apply) throw new Error('missing apply');
  (apply.props.onClick as () => void)();
  await drain();
  expect(nodes(render()).find((e) => e.type === 'button' && text(e) === '应用回复')?.props.disabled).toBe(true);
  (apply.props.onClick as () => void)();
  await drain();
  expect(onAdmin).toHaveBeenCalledOnce();
});
it('改用手动后迟到助手不覆盖粘贴、不应用也不重启网页请求', async () => {
  const props = {
    bridge: { stage: 'admin' as const, prompt: '合成', sourceKey: 'a' },
    busy: false,
    disabled: false,
    onReply: vi.fn(),
    onAnalysis: vi.fn(),
    onAdmin: vi.fn(),
    onSkip: vi.fn(),
  };
  const render = () => {
    host.cursor = 0;
    return WebBridgePanel(props);
  };
  render();
  await drain();
  const helper = nodes(render()).find((e) => e.type === 'button' && text(e).includes('一键用'));
  if (!helper) throw new Error('missing helper');
  (helper.props.onClick as () => void)();
  const manual = nodes(render()).find((e) => e.type === 'button' && text(e) === '改用手动贴回');
  if (!manual) throw new Error('missing manual');
  (manual.props.onClick as () => void)();
  const input = nodes(render()).find((e) => e.type === 'textarea');
  if (!input) throw new Error('missing input');
  (input.props.onChange as (e: unknown) => void)({ target: { value: '后来手动输入' } });
  host.resolve?.('迟到助手');
  await drain();
  expect(nodes(render()).find((e) => e.type === 'textarea')?.props.value).toBe('后来手动输入');
  expect(props.onAdmin).not.toHaveBeenCalled();
  (helper.props.onClick as () => void)();
  expect(host.asks).toBe(1);
});
