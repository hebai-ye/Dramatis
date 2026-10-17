import { conversationId, messageId, roomId } from '@dramatis/core';
import { expect, it, vi } from 'vitest';
import { createAdminProcessStore } from './admin-process-store';

const scope = (db = {}) => ({
  db,
  accountKey: 'account-a',
  roomId: roomId('world-a'),
  conversationId: conversationId('side-a'),
});
it('来源隔离，迟到事件不能更新另一轮或通知其他账户', () => {
  const store = createAdminProcessStore(),
    a = scope(),
    b = { ...a, accountKey: 'b' },
    changed = vi.fn();
  store.begin(a, 'one', 1);
  store.begin(b, 'two', 2);
  store.subscribe(b, changed);
  const before = store.get(b, { runId: 'two' });
  store.observe(a, 'one', { type: 'reasoning', requestIndex: 0, delta: 'A' }, 3);
  expect(store.get(b, { runId: 'two' })).toBe(before);
  expect(changed).not.toHaveBeenCalled();
  store.begin(a, 'next', 4);
  store.observe(a, 'one', { type: 'reasoning', requestIndex: 0, delta: '迟到' }, 5);
  expect(store.get(a, { runId: 'one' })?.entries).toHaveLength(1);
});
it('重复 callId 按请求区分，交接不清用户的展开状态', () => {
  const store = createAdminProcessStore(),
    a = scope();
  store.begin(a, 'run', 1);
  for (const requestIndex of [0, 1])
    store.observe(
      a,
      'run',
      {
        type: 'tool-received',
        requestIndex,
        toolIndex: 0,
        call: { id: 'call_0', type: 'function', function: { name: 'set_scene', arguments: '{}' } },
      },
      2,
    );
  store.setExpanded(a, 'run', 'process', true);
  store.setExpanded(a, 'run', 'tool:0:0', true);
  store.bindMessage(a, 'run', messageId('saved'));
  const result = store.get(a, { messageId: messageId('saved') });
  expect(result?.entries.map((x) => x.key)).toEqual(['tool:0:0:tool-received', 'tool:1:0:tool-received']);
  expect(result?.expanded).toEqual({ process: true, 'tool:0:0': true });
});
it('离开来源销毁推理且拒绝迟到内容，账户清理不保留 trace', () => {
  const store = createAdminProcessStore(),
    a = scope();
  store.begin(a, 'run', 1);
  store.observe(a, 'run', { type: 'reasoning', requestIndex: 0, delta: '私密推理' }, 2);
  store.leave(a);
  store.observe(a, 'run', { type: 'reasoning', requestIndex: 0, delta: '迟到' }, 3);
  expect(store.get(a, { runId: 'run' })?.entries).toEqual([]);
  store.clearAccount(a.db, a.accountKey);
  expect(store.get(a, { runId: 'run' })).toBeNull();
});
