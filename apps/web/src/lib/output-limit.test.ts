import { describe, expect, it } from 'vitest';
import { replyTokenLimit } from './output-limit';

describe('单角色本轮生成上限', () => {
  it('默认与超大预留量最多发 512 token', () => {
    expect(replyTokenLimit('deepseek-chat', 1024)).toBe(512);
    expect(replyTokenLimit('deepseek-chat', 4096)).toBe(512);
  });

  it('旧配置零预留量仍有可用输出空间', () => {
    expect(replyTokenLimit('deepseek-chat', 0)).toBe(128);
    expect(replyTokenLimit('deepseek-chat', Number.NaN)).toBe(512);
  });

  it('推理模型保留推理与最终正文的空间', () => {
    expect(replyTokenLimit('deepseek-reasoner', 4096)).toBeUndefined();
    expect(replyTokenLimit('model-r1', 4096)).toBeUndefined();
  });
});
