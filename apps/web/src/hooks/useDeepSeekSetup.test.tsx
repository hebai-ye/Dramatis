import { createProviderProfile } from '@dramatis/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProvidersApi } from '../lib/providers';

const host = vi.hoisted(() => {
  let values: unknown[] = [],
    cursor = 0,
    effects: (() => void)[] = [];
  return {
    reset() {
      values = [];
      effects = [];
    },
    begin() {
      cursor = 0;
    },
    flush() {
      const work = effects;
      effects = [];
      for (const effect of work) effect();
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
    effect(run: () => void) {
      effects.push(run);
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: host.state,
  useRef: (initial: unknown) => host.state(() => ({ current: initial }))[0],
  useEffect: host.effect,
  useCallback: (callback: unknown) => callback,
}));
const modulePath = './' + 'useDeepSeekSetup';
const module = (await import(modulePath).catch(() => null)) as typeof import('./useDeepSeekSetup') | null;
let api: ProvidersApi, blocked: boolean;
function render() {
  host.begin();
  // biome-ignore lint/correctness/useHookAtTopLevel: controlled renderer executes the real hook with fixture scheduling
  const state = module?.useDeepSeekSetup({ accountKey: 'fixture-account', providers: api, blocked });
  host.flush();
  return state;
}
beforeEach(() => {
  host.reset();
  blocked = false;
  const active = createProviderProfile({ name: 'fixture', baseUrl: 'https://api.deepseek.com', model: 'fixture' });
  api = {
    active,
    activeId: active.id,
    apiKey: '',
    keyLoading: false,
    keyError: null,
    vaultLocked: false,
    keyMode: 'device',
  } as ProvidersApi;
});
describe('setup reminder timing', () => {
  it('opens for a confirmed missing key after initialization', () => {
    api.active = null;
    render();
    expect(render()?.open).toBe(false);
    api.active = createProviderProfile({ name: 'fixture', baseUrl: 'https://api.deepseek.com', model: 'fixture' });
    render();
    expect(render()?.open).toBe(true);
  });
  it('queues behind an existing dialog or bridge and opens when it finishes', () => {
    blocked = true;
    render();
    expect(render()?.open).toBe(false);
    blocked = false;
    render();
    expect(render()?.open).toBe(true);
  });
  it('suppresses automatic repeats after later, but permits manual reopening', () => {
    render();
    render()?.dismiss();
    render();
    expect(render()?.open).toBe(false);
    render()?.requestOpen();
    render();
    expect(render()?.open).toBe(true);
  });
  it('rechecks on a fresh visit rather than permanently hiding the prompt', () => {
    render();
    render()?.dismiss();
    host.reset();
    render();
    expect(render()?.open).toBe(true);
  });
  it('does not interrupt a usable existing key', () => {
    api.apiKey = 'fixture-existing';
    render();
    expect(render()?.open).toBe(false);
  });
  it('keeps an already open prompt mounted while its saved target is being read', () => {
    render();
    expect(render()?.open).toBe(true);
    api.keyLoading = true;
    render();
    expect(render()?.open).toBe(true);
  });
});
