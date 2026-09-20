import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './types.js';
import { cleanPastedReply, needsWebBridge, renderPromptForWeb, WEB_BRIDGE_TARGET } from './web-bridge.js';

describe('renderPromptForWeb', () => {
  it('带角色标注整段拼起来，顺序不变', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '你是秦娘，货栈的掌柜。' },
      { role: 'user', content: '秦娘：「灯要灭了。」' },
    ];

    expect(renderPromptForWeb(messages)).toBe(
      ['--- role: system ---', '你是秦娘，货栈的掌柜。', '', '--- role: user ---', '秦娘：「灯要灭了。」'].join('\n'),
    );
  });

  it('和 eval 取样器的格式一致（同一种贴法，验证过的行为才等于用户看到的）', () => {
    const rendered = renderPromptForWeb([{ role: 'user', content: '一句话' }]);
    expect(rendered.startsWith('--- role: user ---\n')).toBe(true);
  });
});

describe('cleanPastedReply', () => {
  it('去掉首尾空白', () => {
    expect(cleanPastedReply('\n\n  「我这就去。」  \n')).toBe('「我这就去。」');
  });

  it('整段被代码围栏包住时脱掉围栏', () => {
    expect(cleanPastedReply('```\n「我这就去。」\n```')).toBe('「我这就去。」');
  });

  it('不改台词本身：多段、引号、动作都原样留着', () => {
    const raw = '秦娘把灯芯挑低了，「再等一等。」\n\n她没再说话。';
    expect(cleanPastedReply(raw)).toBe(raw);
  });

  it('中文里的三段反引号不会被误判成围栏', () => {
    const raw = '他说「别用 ``` 这个符号」，然后走了。';
    expect(cleanPastedReply(raw)).toBe(raw);
  });
});

describe('needsWebBridge', () => {
  it('没有 Key（含空白与 null）就该走网页版桥接', () => {
    expect(needsWebBridge('')).toBe(true);
    expect(needsWebBridge('   ')).toBe(true);
    expect(needsWebBridge(null)).toBe(true);
    expect(needsWebBridge(undefined)).toBe(true);
  });

  it('填了 Key 就走正常 API 路', () => {
    expect(needsWebBridge('sk-xxxx')).toBe(false);
  });
});

describe('WEB_BRIDGE_TARGET', () => {
  it('指向 DeepSeek 网页版，且不含任何用户私有信息', () => {
    expect(WEB_BRIDGE_TARGET.url).toBe('https://chat.deepseek.com/');
    expect(WEB_BRIDGE_TARGET.name).toContain('DeepSeek');
  });
});
