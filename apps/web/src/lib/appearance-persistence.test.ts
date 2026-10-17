import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppearance } from './appearance';

const hooks = vi.hoisted(() => {
  let slots: unknown[] = [];
  let cursor = 0;
  return {
    reset() {
      slots = [];
      cursor = 0;
    },
    begin() {
      cursor = 0;
    },
    state(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[index],
        (next: unknown) => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next;
        },
      ];
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: hooks.state,
  useRef: (initial: unknown) => hooks.state(() => ({ current: initial }))[0],
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
}));
function render() {
  hooks.begin();
  // biome-ignore lint/correctness/useHookAtTopLevel: controlled hook scheduler
  return useAppearance();
}
beforeEach(() => hooks.reset());
afterEach(() => vi.unstubAllGlobals());

describe('appearance persistence feedback', () => {
  it('reports a saved change only after its storage write succeeds', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    let api = render();
    expect(api.hasSavedChanges).toBe(false);
    api.patch({ theme: 'dark' });
    api = render();
    expect(api.hasSavedChanges).toBe(true);
  });
  it('keeps the old stored background and reports session-only preview until retry succeeds', async () => {
    const saved = JSON.stringify({
      theme: 'tavern',
      background: 'data:image/png;base64,old',
      backgroundOpacity: 0.85,
      showIntent: false,
    });
    const storage = new Map([
      ['dramatis.appearance.v1', saved],
      ['fixture-key', 'old-key'],
    ]);
    let blocked = true;
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (blocked) throw new Error('quota fixture');
        storage.set(key, value);
      },
    });
    let api = render();
    await api.setBackgroundFromFile({
      type: 'image/png',
      size: 1,
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    } as File);
    api = render();
    expect(api.value.background).toBe('data:image/png;base64,AQ==');
    expect(api.persistenceError).toContain('quota fixture');
    expect(storage.get('dramatis.appearance.v1')).toBe(saved);
    expect(storage.get('fixture-key')).toBe('old-key');
    api.patch({ theme: 'dark' });
    api = render();
    blocked = false;
    api.retryPersist();
    api = render();
    expect(api.persistenceError).toBe(null);
    expect(JSON.parse(storage.get('dramatis.appearance.v1') ?? '')).toEqual({
      theme: 'dark',
      background: 'data:image/png;base64,AQ==',
      backgroundOpacity: 0.85,
      showIntent: false,
    });
    expect(storage.get('fixture-key')).toBe('old-key');
  });
});

describe('background selection persistence', () => {
  it.each(['tavern', 'light', 'dark'] as const)(
    'restores an existing %s appearance with an uploaded background',
    (theme) => {
      const saved = {
        theme,
        background: 'data:image/png;base64,bGVnYWN5',
        backgroundOpacity: 0.42,
        showIntent: true,
      };
      vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(saved), setItem: () => {} });

      expect(render().value).toEqual(saved);
    },
  );

  it('stores a selected built-in path and restores it after a fresh mount', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    render().patch({ background: '/backgrounds/v1/tavern-hearth.webp', backgroundOpacity: 0.64 });

    expect(JSON.parse(storage.get('dramatis.appearance.v1') ?? '')).toEqual({
      theme: 'tavern',
      background: '/backgrounds/v1/tavern-hearth.webp',
      backgroundOpacity: 0.64,
      showIntent: false,
    });
    hooks.reset();
    expect(render().value.background).toBe('/backgrounds/v1/tavern-hearth.webp');
    expect(render().value.backgroundOpacity).toBe(0.64);
  });

  it.each([
    '/backgrounds/v1/removed-scene.webp',
    '/backgrounds/v2/tavern-hearth.webp',
    '/backgrounds/v1/thumbs/tavern-hearth.webp',
  ])('restores an unknown built-in path %s as a solid background', (background) => {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ theme: 'dark', background, backgroundOpacity: 0.31, showIntent: true }),
      setItem: () => {},
    });

    expect(render().value).toEqual({ theme: 'dark', background: '', backgroundOpacity: 0.31, showIntent: true });
  });

  it('does not persist an unknown built-in path supplied by a stale selection', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    render().patch({ background: '/backgrounds/v1/removed-scene.webp' });

    expect(render().value.background).toBe('');
    expect(JSON.parse(storage.get('dramatis.appearance.v1') ?? '').background).toBe('');
  });

  it('retains a built-in preview on storage failure and saves the latest appearance on retry', () => {
    const saved = JSON.stringify({
      theme: 'light',
      background: 'data:image/png;base64,bGVnYWN5',
      backgroundOpacity: 0.85,
      showIntent: false,
    });
    const storage = new Map([
      ['dramatis.appearance.v1', saved],
      ['fixture-key', 'unrelated'],
    ]);
    let blocked = true;
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (blocked) throw new Error('storage unavailable');
        storage.set(key, value);
      },
    });
    render().patch({ background: '/backgrounds/v1/space-bridge.webp' });
    let api = render();
    expect(api.value.background).toBe('/backgrounds/v1/space-bridge.webp');
    expect(api.hasSavedChanges).toBe(false);
    expect(api.persistenceError).toContain('storage unavailable');
    expect(storage.get('dramatis.appearance.v1')).toBe(saved);

    api.patch({ theme: 'dark', backgroundOpacity: 0.56, showIntent: true });
    blocked = false;
    render().retryPersist();
    api = render();
    expect(api.persistenceError).toBe(null);
    expect(api.hasSavedChanges).toBe(true);
    hooks.reset();
    expect(render().value).toEqual({
      theme: 'dark',
      background: '/backgrounds/v1/space-bridge.webp',
      backgroundOpacity: 0.56,
      showIntent: true,
    });
    expect(storage.get('fixture-key')).toBe('unrelated');
  });
});
