import type { ProviderProfile } from '@dramatis/core';
import type { KeyStorageMode } from './keystore';

export interface DeepSeekSetupOwner {
  readonly profileId: string;
  readonly keyMode: KeyStorageMode;
  readonly context: object;
  readonly token: object;
}

export interface DeepSeekSetupReceipt {
  profileId: string;
  keyRef: string;
  baseUrl: string;
}

export type DeepSeekSetupState = 'waiting' | 'configured' | 'missing' | 'read-error' | 'locked';

export function deepseekSetupState(input: {
  active: ProviderProfile | null;
  apiKey: string;
  keyLoading: boolean;
  keyError: string | null;
  vaultLocked: boolean;
}): DeepSeekSetupState {
  if (input.active == null) return 'waiting';
  if (input.vaultLocked) return 'locked';
  if (input.keyLoading) return 'waiting';
  if (input.keyError !== null) return 'read-error';
  return input.apiKey.trim() === '' ? 'missing' : 'configured';
}

export function isDeepSeekProfile(profile: ProviderProfile): boolean {
  try {
    const address = new URL(profile.baseUrl);
    return (
      address.protocol === 'https:' &&
      address.hostname === 'api.deepseek.com' &&
      address.port === '' &&
      address.username === '' &&
      address.password === '' &&
      address.search === '' &&
      address.hash === '' &&
      ['/', '/v1', '/v1/'].includes(address.pathname)
    );
  } catch {
    return false;
  }
}
