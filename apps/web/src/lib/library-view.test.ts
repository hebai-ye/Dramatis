import { describe, expect, it } from 'vitest';
import { createLibraryNavigation, type LibraryLeaveHandle, runLibraryNavigation } from './library-view';

describe('library navigation', () => {
  it('toggles the same library and switches directly without a conversation action', async () => {
    const nav = createLibraryNavigation();
    await nav.toggle('personas');
    expect(nav.state().activeView).toBe('personas');
    await nav.toggle('worldbooks');
    expect(nav.state().activeView).toBe('worldbooks');
    await nav.toggle('worldbooks');
    expect(nav.state().activeView).toBeNull();
    expect(nav.state().returnFocus).toBe(true);
  });

  it('waits for an already running editor write before leaving', async () => {
    const nav = createLibraryNavigation();
    await nav.toggle('cards');
    let release = () => {};
    const write = new Promise<void>((resolve) => {
      release = resolve;
    });
    nav.registerEditor('cards', { flush: () => write, pending: () => null, discard: () => {} });
    const leaving = nav.close();
    await Promise.resolve();
    expect(nav.state().activeView).toBe('cards');
    expect(nav.state().busy).toBe(true);
    release();
    expect(await leaving).toBe(true);
    expect(nav.state().activeView).toBeNull();
  });

  it('keeps the view and reports a rejected save instead of executing navigation', async () => {
    const nav = createLibraryNavigation();
    await nav.toggle('personas');
    let navigated = false;
    nav.registerEditor('personas', {
      flush: async () => {
        throw new Error('保存失败');
      },
      pending: () => null,
      discard: () => {},
    });
    expect(
      await nav.requestAction(() => {
        navigated = true;
      }),
    ).toBe(false);
    expect(navigated).toBe(false);
    expect(nav.state().activeView).toBe('personas');
    expect(nav.state().notice).toBe('保存失败');
  });

  it('asks before discarding a crop and cancellation keeps the draft', async () => {
    const nav = createLibraryNavigation();
    await nav.toggle('cards');
    let crop = true;
    nav.registerEditor('cards', {
      flush: async () => {},
      pending: () => (crop ? '头像裁切尚未确认' : null),
      discard: () => {
        crop = false;
      },
    });
    expect(await nav.toggle('worldbooks')).toBe(false);
    expect(nav.state().pendingMessage).toBe('头像裁切尚未确认');
    nav.cancel();
    expect(crop).toBe(true);
    expect(nav.state().activeView).toBe('cards');
    await nav.toggle('worldbooks');
    expect(await nav.confirmDiscard()).toBe(true);
    expect(crop).toBe(false);
    expect(nav.state().activeView).toBe('worldbooks');
  });

  it('flushes visited inactive editors and does not accept duplicate leave actions', async () => {
    const nav = createLibraryNavigation();
    await nav.toggle('personas');
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let actions = 0;
    nav.registerEditor('cards', { flush: () => pending, pending: () => null, discard: () => {} });
    const first = nav.requestAction(() => {
      actions++;
    });
    expect(
      await nav.requestAction(() => {
        actions++;
      }),
    ).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(actions).toBe(1);
  });

  it('does not unregister a newer editor handle through an older cleanup', async () => {
    const nav = createLibraryNavigation();
    let saved = false;
    const older: LibraryLeaveHandle = { flush: async () => {}, pending: () => null, discard: () => {} };
    const remove = nav.registerEditor('cards', older);
    nav.registerEditor('cards', {
      flush: async () => {
        saved = true;
      },
      pending: () => null,
      discard: () => {},
    });
    remove();
    await nav.requestAction(() => {});
    expect(saved).toBe(true);
  });

  it('closes after committed conversation navigation without requesting return focus', async () => {
    const nav = createLibraryNavigation();
    await nav.toggle('worldbooks');
    nav.dismissForNavigation();
    expect(nav.state().activeView).toBeNull();
    expect(nav.state().returnFocus).toBe(false);
  });
});

describe('committed navigation', () => {
  it('checks the committed target, rather than a resolved no-op', async () => {
    const { waitForLibraryNavigation } = await import('./library-view');
    let ticks = 0;
    expect(
      await waitForLibraryNavigation(
        () => false,
        async () => {
          ticks += 1;
        },
      ),
    ).toBe(false);
    expect(ticks).toBe(3);
  });
  it('accepts an already open target and a later actual commit', async () => {
    const { waitForLibraryNavigation } = await import('./library-view');
    let committed = false;
    expect(
      await waitForLibraryNavigation(
        () => true,
        async () => {},
      ),
    ).toBe(true);
    expect(
      await waitForLibraryNavigation(
        () => committed,
        async () => {
          committed = true;
        },
      ),
    ).toBe(true);
  });
});

describe('guarded navigation intent', () => {
  it('rejects a missing target even when its stale same-ID snapshot is still committed', async () => {
    const nav = createLibraryNavigation();
    await nav.toggle('cards');
    let opened = false;
    const result = await nav.requestAction(() =>
      runLibraryNavigation({
        action: async () => {
          opened = true;
        },
        exists: async () => false,
        committed: () => true,
        leave: nav.dismissForNavigation,
      }),
    );
    expect(result).toBe(false);
    expect(opened).toBe(false);
    expect(nav.state().activeView).toBe('cards');
    expect(nav.state().notice).toContain('仍然存在');
  });

  it('rechecks existence after loading instead of accepting a concurrently deleted target', async () => {
    const nav = createLibraryNavigation();
    await nav.toggle('personas');
    let alive = true;
    const result = await nav.requestAction(() =>
      runLibraryNavigation({
        action: async () => {
          alive = false;
        },
        exists: async () => alive,
        committed: () => true,
        leave: nav.dismissForNavigation,
      }),
    );
    expect(result).toBe(false);
    expect(nav.state().activeView).toBe('personas');
    expect(nav.state().notice).toContain('仍然存在');
  });

  it('keeps the full cross-world new-conversation intent through crop confirmation', async () => {
    const nav = createLibraryNavigation();
    await nav.toggle('cards');
    let crop = true;
    let world = 'A';
    let dialog = false;
    nav.registerEditor('cards', {
      flush: async () => {},
      pending: () => (crop ? '尚有裁图' : null),
      discard: () => {
        crop = false;
      },
    });
    expect(
      await nav.requestAction(() =>
        runLibraryNavigation({
          action: async () => {
            world = 'B';
          },
          exists: async () => true,
          committed: () => world === 'B',
          onCommitted: () => {
            dialog = true;
          },
          leave: nav.dismissForNavigation,
        }),
      ),
    ).toBe(false);
    expect(world).toBe('A');
    expect(dialog).toBe(false);
    expect(await nav.confirmDiscard()).toBe(true);
    expect(world).toBe('B');
    expect(dialog).toBe(true);
    expect(nav.state().activeView).toBeNull();
    expect(nav.state().returnFocus).toBe(false);
  });
});
