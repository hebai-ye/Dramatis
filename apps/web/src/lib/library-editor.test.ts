import { describe, expect, it } from 'vitest';
import { createLibraryEditor } from './library-editor';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const first = { id: 'one', name: 'Initial' };

describe('library async draft coordination', () => {
  it('keeps a failed draft dirty and retries the same data', async () => {
    const create = createLibraryEditor;
    let fail = true;
    const stored: string[] = [];
    const editor = create(first, async (draft: typeof first) => {
      if (fail) throw new Error('offline');
      stored.push(draft.name);
    });
    editor.patch({ name: 'Unsaved' });
    await expect(editor.flush()).rejects.toThrow('offline');
    expect(editor.draft?.name).toBe('Unsaved');
    expect(editor.dirty).toBe(true);
    fail = false;
    await editor.flush();
    expect(stored).toEqual(['Unsaved']);
    expect(editor.dirty).toBe(false);
  });

  it('flush waits for in-flight writes and serializes the newest draft', async () => {
    const create = createLibraryEditor;
    const gate = deferred();
    const stored: string[] = [];
    const editor = create(first, async (draft: typeof first) => {
      stored.push(draft.name);
      if (stored.length === 1) await gate.promise;
    });
    editor.patch({ name: 'Earlier' });
    const saving = editor.flush();
    editor.patch({ name: 'Latest' });
    let finished = false;
    const leaving = editor.flush().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(stored).toEqual(['Earlier']);
    gate.resolve();
    await Promise.all([saving, leaving]);
    expect(stored).toEqual(['Earlier', 'Latest']);
    expect(editor.dirty).toBe(false);
  });

  it('selects a newly created object only after its slow save succeeds', async () => {
    const create = createLibraryEditor;
    const gate = deferred();
    const editor = create(first, () => gate.promise);
    const creating = editor.create({ id: 'two', name: 'Created' });
    expect(editor.draft?.id).toBe('one');
    expect(editor.busy).toBe(true);
    let flushed = false;
    const leaving = editor.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    gate.resolve();
    await Promise.all([creating, leaving]);
    expect(editor.draft?.id).toBe('two');
    expect(editor.busy).toBe(false);
  });

  it('waits for old writes before deleting and leaves no resurrecting draft', async () => {
    const create = createLibraryEditor;
    const gate = deferred();
    const events: string[] = [];
    const editor = create(first, async () => {
      events.push('save');
      await gate.promise;
    });
    editor.patch({ name: 'Changed' });
    const saving = editor.flush();
    const deleting = editor.remove(async () => {
      events.push('delete');
    });
    await Promise.resolve();
    expect(events).toEqual(['save']);
    gate.resolve();
    await Promise.all([saving, deleting]);
    await editor.flush();
    expect(events).toEqual(['save', 'delete']);
    expect(editor.draft).toBe(null);
  });

  it('refreshes clean same-ID external objects and protects dirty ones', async () => {
    const create = createLibraryEditor;
    const editor = create(first, () => {});
    editor.refresh({ id: 'one', name: 'External' });
    expect(editor.draft?.name).toBe('External');
    editor.patch({ name: 'Local' });
    editor.refresh({ id: 'one', name: 'Stale external' });
    expect(editor.draft?.name).toBe('Local');
    await editor.flush();
    editor.refresh({ id: 'one', name: 'New external' });
    expect(editor.draft?.name).toBe('New external');
  });

  it('does not save during IME composition and flushes after composition ends', async () => {
    const create = createLibraryEditor;
    const stored: string[] = [];
    const editor = create(first, (draft: typeof first) => {
      stored.push(draft.name);
    });
    editor.beginComposition();
    editor.patch({ name: '组合' });
    await expect(editor.flush()).rejects.toThrow(/输入/);
    expect(stored).toEqual([]);
    editor.endComposition();
    await editor.flush();
    expect(stored).toEqual(['组合']);
  });
});

it('does not issue the next write if IME starts while the prior write is in flight', async () => {
  const gate = deferred();
  const stored: string[] = [];
  const editor = createLibraryEditor(first, async (draft) => {
    stored.push(draft.name);
    await gate.promise;
  });
  editor.patch({ name: 'Before IME' });
  const saving = editor.flush();
  await Promise.resolve();
  editor.beginComposition();
  editor.patch({ name: '未完成' });
  gate.resolve();
  await expect(saving).rejects.toThrow(/输入/);
  expect(stored).toEqual(['Before IME']);
  editor.endComposition();
  await editor.flush();
  expect(stored).toEqual(['Before IME', '未完成']);
});

it('external invalidation prevents a queued newer draft from following an already emitted save', async () => {
  const gate = deferred();
  const stored: string[] = [];
  const editor = createLibraryEditor(first, async (draft) => {
    stored.push(draft.name);
    await gate.promise;
  });
  editor.patch({ name: 'Already emitted' });
  const saving = editor.flush();
  await Promise.resolve();
  editor.patch({ name: 'Must not revive' });
  editor.invalidate();
  gate.resolve();
  await saving;
  await editor.flush();
  expect(stored).toEqual(['Already emitted']);
  expect(editor.draft).toBe(null);
  expect(editor.dirty).toBe(false);
});

it('latest unchanged external snapshot cancels an older deferred refresh', async () => {
  const editor = createLibraryEditor(first, () => {});
  editor.patch({ name: 'Local' });
  editor.refresh({ id: 'one', name: 'Older external snapshot' });
  editor.patch({ name: 'Initial' });
  editor.refresh(first);
  await editor.run(() => {});
  expect(editor.draft?.name).toBe('Initial');
});

it('slow removal preserves the neighbor selected while the deletion was in flight', async () => {
  const gate = deferred();
  const editor = createLibraryEditor(first, () => {});
  const deleting = editor.remove(() => gate.promise);
  await Promise.resolve();
  editor.invalidate();
  editor.refresh({ id: 'neighbor', name: 'Neighbor' });
  gate.resolve();
  await deleting;
  expect(editor.draft).toEqual({ id: 'neighbor', name: 'Neighbor' });
  expect(editor.busy).toBe(false);
  expect(editor.dirty).toBe(false);
});
