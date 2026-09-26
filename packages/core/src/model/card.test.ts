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

/**
 * 顺序 89（用户 2026-09-26）：默认系统提示换成用户自己那套系统预设。
 *
 * 这段正文是「基本规则」块的内容来源（`assemble.ts` 的 `id: 'system'`，
 * priority 1000、不可丢弃），所以它写错了会直接影响每一轮的输出。
 * 下面钉住的是**用户明确要求保留的几条**，以及那次裁定里唯一改动过的格式约定：
 * 用户原文写「动作用括号、对白用双引号」，但引擎按自己的写法渲染，
 * 于是裁定「保留引擎写法，预设其余内容照收」——动作行以 `#` 起段、对白不加引号。
 */
describe('顺序 89：默认系统提示（系统预设）', () => {
  it('保留用户点名的那几条要求', () => {
    expect(DEFAULT_CARD_SYSTEM_PROMPT).toContain('沉浸');
    expect(DEFAULT_CARD_SYSTEM_PROMPT).toContain('只包含角色的行为与对话');
    expect(DEFAULT_CARD_SYSTEM_PROMPT).toContain('疑问句');
    expect(DEFAULT_CARD_SYSTEM_PROMPT).toContain('五感');
    expect(DEFAULT_CARD_SYSTEM_PROMPT).toContain('禁止事项');
  });

  it('用引擎的写法交代格式，而不是预设原文的括号 + 双引号', () => {
    expect(DEFAULT_CARD_SYSTEM_PROMPT).toContain('用 # 开头');
    expect(DEFAULT_CARD_SYSTEM_PROMPT).toContain('对白不加引号');
    expect(DEFAULT_CARD_SYSTEM_PROMPT).not.toContain('双引号');
  });

  it('不替玩家写对白是硬约束（用户点名）', () => {
    expect(DEFAULT_CARD_SYSTEM_PROMPT).toContain('输出本应属于玩家角色的对话');
  });
});
