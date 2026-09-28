import { describe, expect, it } from 'vitest';
import { defaultConversationModes, speakerLimitOf } from './conversation.js';

describe('多人回复上限的老数据兼容', () => {
  it('旧对话缺字段默认为 2，非法值不放大上限', () => {
    expect(defaultConversationModes().maxSpeakers).toBe(2);
    expect(speakerLimitOf(undefined)).toBe(2);
    expect(speakerLimitOf({ ...defaultConversationModes(), maxSpeakers: undefined })).toBe(2);
    expect(speakerLimitOf({ ...defaultConversationModes(), maxSpeakers: 99 as never })).toBe(2);
    expect(speakerLimitOf({ ...defaultConversationModes(), maxSpeakers: 1 })).toBe(1);
    expect(speakerLimitOf({ ...defaultConversationModes(), maxSpeakers: 3 })).toBe(3);
  });
});
