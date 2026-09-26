import { describe, expect, it } from 'vitest';
import { createBlankCard, DEFAULT_CARD_SYSTEM_PROMPT } from './card.js';

/**
 * 顺序 89（用户 2026-09-26）：默认系统提示换成用户自己那套系统预设。
 *
 * 顺序 90 把卡上的 `systemPrompt` 字段删了，于是 `DEFAULT_CARD_SYSTEM_PROMPT`
 * 成了**唯一**的来源（「基本规则」块直接用它）。这里钉住的是用户明确要求保留的几条，
 * 以及那次裁定里唯一改动过的格式约定：用户原文写「动作用括号、对白用双引号」，
 * 但引擎按自己的写法渲染，于是裁定「保留引擎写法，预设其余内容照收」——
 * 动作行以 `#` 起段、对白不加引号。
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

/**
 * 顺序 90（用户 2026-09-26 裁定「彻底删除已有数据」）：卡上不再有开场白、场景设定、
 * 对话示例与高级字段。这里用 `in` 而不是 `card.firstMessage` 来断言，是因为类型层
 * 已经把字段删掉了——直接写属性名连编译都过不去。
 */
describe('顺序 90：卡上已删掉的四类字段', () => {
  it('新建的卡不再带这些字段', () => {
    const card = createBlankCard() as unknown as Record<string, unknown>;
    for (const key of [
      'scenario',
      'firstMessage',
      'alternateGreetings',
      'exampleMessages',
      'systemPrompt',
      'postHistoryInstructions',
      'creatorNotes',
    ]) {
      expect(key in card).toBe(false);
    }
  });
});
