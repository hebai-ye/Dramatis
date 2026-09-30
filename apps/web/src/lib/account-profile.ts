import { normalizeUserId } from '@dramatis/core';

export interface AccountProfile {
  accountId: string;
  displayName: string;
  spaceHandle: string;
}

/** 资料共享必须由用户同意；旧服务或认领失败不应破坏已创建的同步账户。 */
export async function claimAccountProfile(
  input: {
    endpoint: string;
    spaceHandle: string;
    accountId: string;
    displayName: string;
    credential: string;
    consent: boolean;
  },
  send: typeof fetch = fetch,
): Promise<{ profile: AccountProfile | null; warning: string | null }> {
  if (!input.consent) return { profile: null, warning: null };
  try {
    const response = await send(`${input.endpoint.replace(/\/+$/, '')}/accounts/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${input.credential}` },
      body: JSON.stringify({
        spaceHandle: input.spaceHandle,
        accountId: input.accountId,
        displayName: input.displayName,
        confirmed: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404)
      return { profile: null, warning: '此服务器尚未支持账户资料登记，账户与加密同步仍可使用。' };
    if (!response.ok) throw new Error('claim-failed');
    const body = (await response.json()) as { profile?: Partial<AccountProfile> };
    const profile = body.profile;
    if (
      profile?.spaceHandle !== input.spaceHandle ||
      profile.accountId !== normalizeUserId(input.accountId) ||
      typeof profile.displayName !== 'string' ||
      profile.displayName.trim() === '' ||
      profile.displayName.length > 80
    )
      throw new Error('invalid-profile');
    return { profile: profile as AccountProfile, warning: null };
  } catch {
    return { profile: null, warning: '账户资料尚未登记成功；账户与加密同步仍可使用，可稍后在登录时重试登记。' };
  }
}
