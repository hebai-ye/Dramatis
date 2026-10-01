import { describe, expect, it } from 'vitest';
import { accountLeaveGuard, copyRecoveryCode, createAccountOperationGate, loadAccountBadges } from './account-ui';

describe('账户界面的操作保护', () => {
  it('复制不可用或被拒绝时保留可见的手动保存路径', async () => {
    expect((await copyRecoveryCode('fixture-code', undefined)).ok).toBe(false);
    const result = await copyRecoveryCode('fixture-code', {
      writeText: async () => {
        throw new Error('denied');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('手动');
    let copied = '';
    expect(
      (
        await copyRecoveryCode('fixture-code', {
          writeText: async (code) => {
            copied = code;
          },
        })
      ).ok,
    ).toBe(true);
    expect(copied).toBe('fixture-code');
  });

  it('一次操作未结束时拒绝重复提交，失败后允许重试', async () => {
    const gate = createAccountOperationGate();
    let release: () => void = () => {};
    const entered: string[] = [];
    const pending = gate.run(
      async () => {
        entered.push('first');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      () => {},
    );
    const duplicate = await gate.run(
      async () => {
        entered.push('duplicate');
      },
      () => {},
    );
    expect(duplicate.started).toBe(false);
    expect(entered).toEqual(['first']);
    release();
    await pending;
    await expect(
      gate.run(
        async () => {
          throw new Error('failed');
        },
        () => {},
      ),
    ).rejects.toThrow('failed');
    const retry = await gate.run(
      async () => {
        entered.push('retry');
      },
      () => {},
    );
    expect(retry.started).toBe(true);
    expect(entered).toEqual(['first', 'retry']);
  });

  it('恢复码显示时注册离开保护，忙碌保护优先且不会丢弃恢复码', () => {
    let code: string | null = 'fixture-code';
    const recovery = accountLeaveGuard(null, code, () => {
      code = null;
    });
    expect(recovery?.kind).toBe('recovery');
    expect(code).toBe('fixture-code');
    const busy = accountLeaveGuard('正在注册', code, () => {
      code = null;
    });
    expect(busy?.kind).toBe('busy');
    expect(busy?.discard).toBeUndefined();
    recovery?.discard?.();
    expect(code).toBeNull();
    expect(accountLeaveGuard(null, code, () => {})).toBeNull();
  });

  it('一个账户读取失败时显示未知，其他账户的状态和服务器仍能读取', async () => {
    const accounts = [{ id: 'a' }, { id: 'b' }];
    const result = await loadAccountBadges(accounts, async (account) => {
      if (account.id === 'a') throw new Error('blocked');
      return { configured: true, unlocked: false, lastSyncAt: null, endpoint: 'https://fixture.invalid/sync' };
    });
    expect(result.a?.state).toBe('unknown');
    expect(result.a?.error).toBe('blocked');
    expect(result.b).toMatchObject({ state: 'known', configured: true, endpoint: 'https://fixture.invalid/sync' });
  });
});
