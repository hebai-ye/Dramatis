import { describe, expect, it } from 'vitest';
import { createBlankCard, DEFAULT_CARD_SYSTEM_PROMPT, resolveCardSystemPrompt } from './card.js';

describe('角色卡系统提示默认值', () => {
  it('新建卡带完整默认提示，显式自定义值不被覆盖', () => {
    expect(createBlankCard().systemPrompt).toBe(DEFAULT_CARD_SYSTEM_PROMPT);
    expect(createBlankCard({ systemPrompt: '保留这句。' }).systemPrompt).toBe('保留这句。');
  });

  it('旧卡空字段按默认提示使用，自定义字段逐字保留', () => {
    expect(resolveCardSystemPrompt('')).toBe(DEFAULT_CARD_SYSTEM_PROMPT);
    expect(resolveCardSystemPrompt('  ')).toBe(DEFAULT_CARD_SYSTEM_PROMPT);
    expect(resolveCardSystemPrompt('  我的规则。\n')).toBe('  我的规则。\n');
  });
});
