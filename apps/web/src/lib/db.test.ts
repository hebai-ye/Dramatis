import { describe, expect, it } from 'vitest';
import { shouldCopyRow } from './db';

describe('copyLocalDatabase 的过滤（审计 C3）', () => {
  it('同步状态与设备号不带到新账户', () => {
    expect(shouldCopyRow({ collection: 'meta', id: 'sync.config' })).toBe(false);
    expect(shouldCopyRow({ collection: 'meta', id: 'sync.state' })).toBe(false);
    expect(shouldCopyRow({ collection: 'meta', id: 'device.id' })).toBe(false);
  });

  it('其它数据照常复制', () => {
    expect(shouldCopyRow({ collection: 'meta', id: 'schema.version' })).toBe(true);
    expect(shouldCopyRow({ collection: 'messages', id: 'device.id' })).toBe(true);
    expect(shouldCopyRow({ collection: 'rooms', id: 'r1' })).toBe(true);
  });
});
