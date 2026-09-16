import { describe, expect, it } from 'vitest';
import { renderMessageContent, splitLongSpeech, splitMessageContent } from './segments.js';

describe('splitMessageContent', () => {
  it('把 `#` 开头的段落切成动作段', () => {
    const segments = splitMessageContent('「你回来了。」\n# 她把门掩上，没有看他。');

    expect(segments).toEqual([
      { kind: 'speech', text: '「你回来了。」' },
      { kind: 'action', text: '她把门掩上，没有看他。' },
    ]);
  });

  it('一段话里掺杂动作时切成 对白 → 动作 → 对白', () => {
    const segments = splitMessageContent('先说话。\n# 中间做了个动作。\n再说一句。');

    expect(segments.map((segment) => segment.kind)).toEqual(['speech', 'action', 'speech']);
    expect(segments[1]?.text).toBe('中间做了个动作。');
  });

  it('连续多个 `#` 都当动作标记剥掉，空行断开段落', () => {
    const segments = splitMessageContent('# 动作一\n\n## 动作二');

    expect(segments).toEqual([
      { kind: 'action', text: '动作一' },
      { kind: 'action', text: '动作二' },
    ]);
  });

  it('连续的对白行合并成一段，动作行不混进去', () => {
    const segments = splitMessageContent('第一行\n第二行\n# 动作\n第三行');

    expect(segments).toEqual([
      { kind: 'speech', text: '第一行\n第二行' },
      { kind: 'action', text: '动作' },
      { kind: 'speech', text: '第三行' },
    ]);
  });

  it('空内容与只有空白的 `#` 不产生片段', () => {
    expect(splitMessageContent('')).toEqual([]);
    expect(splitMessageContent('   \n\n  ')).toEqual([]);
    expect(splitMessageContent('#')).toEqual([]);
  });

  it('行内的 `#` 不是动作标记，只有行首才算', () => {
    const segments = splitMessageContent('话题 #1 是这么回事');
    expect(segments).toEqual([{ kind: 'speech', text: '话题 #1 是这么回事' }]);
  });
});

describe('splitLongSpeech', () => {
  it('短句原样返回', () => {
    expect(splitLongSpeech('很短的一句。', 20)).toEqual(['很短的一句。']);
  });

  it('超过上限时按句子边界切开', () => {
    const text = '第一句话说得很长很长很长。第二句话也不短，要凑够长度。第三句话收尾。';
    const pieces = splitLongSpeech(text, 20);

    expect(pieces.length).toBeGreaterThan(1);
    // 不切碎句子：每个片段都以句末标点结尾（最后一片除外也可以）
    for (const piece of pieces.slice(0, -1)) {
      expect(/[。！？…]$/.test(piece)).toBe(true);
    }
    expect(pieces.join('')).toBe(text);
  });

  it('单句超长时不再细切，宁可留一个长气泡', () => {
    const text = '这一句话里没有任何标点符号所以怎么切都会把话说断掉';
    expect(splitLongSpeech(text, 10)).toEqual([text]);
  });
});

describe('renderMessageContent', () => {
  it('动作段保持整段，对白段按气泡上限拆开', () => {
    const content = '# 一个很长的动作描写，它不该被拆成多个气泡因为它本来就不在气泡里。\n短话。';
    const pieces = renderMessageContent(content, { maxBubbleLength: 12 });

    expect(pieces[0]?.kind).toBe('action');
    expect(pieces[0]?.text).toContain('一个很长的动作描写');
    expect(pieces.filter((piece) => piece.kind === 'speech')).toHaveLength(1);
  });
});
