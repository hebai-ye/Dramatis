import { describe, expect, it } from 'vitest';
import { claimAccountProfile } from './account-profile';

const input = {
  endpoint: 'http://localhost/sync',
  spaceHandle: 'fixture-handle',
  accountId: 'fixture-account',
  displayName: '测试账户',
  credential: 'fixture-proof',
  consent: true,
};

describe('用户明确同意后认领账户资料', () => {
  it('未同意不发送任何请求', async () => {
    let requests = 0;
    const result = await claimAccountProfile({ ...input, consent: false }, async () => {
      requests++;
      throw new Error();
    });
    expect(requests).toBe(0);
    expect(result).toEqual({ profile: null, warning: null });
  });
  it('只发送资料与所有权凭证，使用服务端已确定的显示名', async () => {
    const result = await claimAccountProfile(input, async (url, options) => {
      expect(url).toBe('http://localhost/sync/accounts/claim');
      expect(new Headers(options?.headers).get('authorization')).toBe('Bearer fixture-proof');
      expect(JSON.parse(String(options?.body))).toEqual({
        spaceHandle: 'fixture-handle',
        accountId: 'fixture-account',
        displayName: '测试账户',
        confirmed: true,
      });
      return Response.json({
        profile: { accountId: 'fixture-account', displayName: '服务端原名', spaceHandle: 'fixture-handle' },
      });
    });
    expect(result.profile?.displayName).toBe('服务端原名');
    expect(result.warning).toBeNull();
  });
  it('老服务器不支持时返回明确提示，不抛错破坏注册登录', async () => {
    const result = await claimAccountProfile(input, async () => new Response('', { status: 404 }));
    expect(result.profile).toBeNull();
    expect(result.warning).toContain('尚未支持');
  });
  it('网络失败和无效响应不误报关联成功', async () => {
    const failed = await claimAccountProfile(input, async () => {
      throw new Error('fixture network');
    });
    expect(failed.warning).toBeTruthy();
    const invalid = await claimAccountProfile(input, async () =>
      Response.json({ profile: { ...input, spaceHandle: 'another' } }),
    );
    expect(invalid.profile).toBeNull();
    expect(invalid.warning).toBeTruthy();
  });
});
