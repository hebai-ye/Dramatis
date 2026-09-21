/**
 * 模型配置的默认窗口与回复预留（2026-09-21 用户要求：按「800 条用户输入」设）。
 *
 * 两件事：新配置拿到的是新默认值；老库里**还是老默认值**的那份被迁移升级，
 * 而用户自己调过的数字**不许动**。
 */

import { describe, expect, it } from 'vitest';
import { createProviderProfile } from '../model/provider.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { COLLECTIONS, Repository } from './repository.js';

describe('模型配置的默认值（800 条用户输入）', () => {
  it('新配置：窗口 65536、回复预留 4096', () => {
    const profile = createProviderProfile({
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    });
    expect(profile.maxTokens).toBe(65536);
    expect(profile.reserveForReply).toBe(4096);
  });

  it('迁移只升级「还是老默认值」的那份；用户自己调过的数字不动', async () => {
    const store = createMemoryEntityStore();
    // 老默认值（会被升级）
    await store.put(COLLECTIONS.providerProfiles, {
      id: 'p-old',
      name: '老的',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      keyRef: 'provider:p-old',
      temperature: 0.9,
      maxTokens: 16384,
      reserveForReply: 1024,
      role: 'both',
      price: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    // 用户自己调过的（不许动）
    await store.put(COLLECTIONS.providerProfiles, {
      id: 'p-custom',
      name: '自己调的',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-reasoner',
      keyRef: 'provider:p-custom',
      temperature: 0.6,
      maxTokens: 8192,
      reserveForReply: 2048,
      role: 'both',
      price: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });

    const repo = new Repository(store);
    await repo.migrate();
    const profiles = await repo.listProviderProfiles();
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));

    expect(byId.get('p-old')?.maxTokens).toBe(65536);
    expect(byId.get('p-old')?.reserveForReply).toBe(4096);
    // 用户自己的选择保持原样
    expect(byId.get('p-custom')?.maxTokens).toBe(8192);
    expect(byId.get('p-custom')?.reserveForReply).toBe(2048);
  });
});
