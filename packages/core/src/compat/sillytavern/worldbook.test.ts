import { describe, expect, it } from 'vitest';
import { SelectiveLogic, type WorldBook } from '../../model/card.js';
import { matchWorldBookEntries, parseWorldBook } from './worldbook.js';

function build(entries: unknown[]): WorldBook {
  return parseWorldBook({ entries }).book;
}

const alwaysInclude = (): number => 0;

describe('parseWorldBook', () => {
  it('支持以 uid 为键的对象形态', () => {
    const { book } = parseWorldBook({
      entries: {
        '0': { uid: 0, key: ['酒馆'], content: '旧城东侧的酒馆', comment: '地点' },
        '7': { uid: 7, key: '佣兵', content: '佣兵公会', comment: '组织' },
      },
    });

    expect(book.entries).toHaveLength(2);
    expect(book.entries[0]?.title).toBe('地点');
    expect(book.entries[0]?.keys).toEqual(['酒馆']);
    // key 是裸字符串时也要认
    expect(book.entries[1]?.keys).toEqual(['佣兵']);
    expect(book.entries[1]?.id).toBe('7');
  });

  it('支持数组形态', () => {
    const { book } = parseWorldBook({ entries: [{ comment: 'A', key: ['a'], content: 'x' }] });
    expect(book.entries).toHaveLength(1);
  });

  it('映射插入位置与选择逻辑', () => {
    const { book } = parseWorldBook({
      entries: [{ comment: 'A', key: ['a'], content: 'x', position: 4, depth: 2, selectiveLogic: 3 }],
    });

    expect(book.entries[0]?.position).toBe('at_depth');
    expect(book.entries[0]?.depth).toBe(2);
    expect(book.entries[0]?.selectiveLogic).toBe(SelectiveLogic.AND_ALL);
  });

  it('未识别的条目字段被保留并提示', () => {
    const { book, warnings } = parseWorldBook({
      entries: [{ comment: 'A', key: ['a'], content: 'x', someFutureField: 42 }],
    });

    expect(book.entries[0]?.extensions.someFutureField).toBe(42);
    expect(warnings.some((warning) => warning.code === 'unknown-entry-fields')).toBe(true);
  });

  it('提示既非常驻又无关键词的条目', () => {
    const { warnings } = parseWorldBook({ entries: [{ comment: '废条目', content: 'x' }] });
    expect(warnings.some((warning) => warning.code === 'entries-without-keys')).toBe(true);
  });
});

describe('matchWorldBookEntries', () => {
  it('常驻条目无需命中', () => {
    const book = build([{ comment: '常驻', content: '世界规则', constant: true, key: [] }]);
    const matches = matchWorldBookEntries(book, { scanText: '随便说点什么', random: alwaysInclude });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.reason).toBe('constant');
  });

  it('默认忽略大小写', () => {
    const book = build([{ comment: 'A', key: ['Tavern'], content: 'x' }]);
    const matches = matchWorldBookEntries(book, { scanText: '我们去 tavern 吧', random: alwaysInclude });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.matchedKeys).toEqual(['Tavern']);
  });

  it('开启大小写敏感后不再命中', () => {
    const book = build([{ comment: 'A', key: ['Tavern'], content: 'x', caseSensitive: true }]);
    const matches = matchWorldBookEntries(book, { scanText: '我们去 tavern 吧', random: alwaysInclude });

    expect(matches).toHaveLength(0);
  });

  it('整词匹配不会因子串而误命中', () => {
    const book = build([{ comment: 'A', key: ['art'], content: 'x', matchWholeWords: true }]);

    expect(matchWorldBookEntries(book, { scanText: 'partial', random: alwaysInclude })).toHaveLength(0);
    expect(matchWorldBookEntries(book, { scanText: 'this is art', random: alwaysInclude })).toHaveLength(1);
  });

  it('整词匹配对中日韩文字同样有效', () => {
    const book = build([{ comment: 'A', key: ['酒馆'], content: 'x', matchWholeWords: true }]);
    const matches = matchWorldBookEntries(book, { scanText: '我们去酒馆坐坐', random: alwaysInclude });

    expect(matches).toHaveLength(1);
  });

  it('AND_ANY：次级键任意一个命中即可', () => {
    const book = build([
      { comment: 'A', key: ['酒馆'], keysecondary: ['雨', '雪'], selectiveLogic: SelectiveLogic.AND_ANY, content: 'x' },
    ]);

    expect(matchWorldBookEntries(book, { scanText: '酒馆里有雨', random: alwaysInclude })).toHaveLength(1);
    expect(matchWorldBookEntries(book, { scanText: '酒馆里很吵', random: alwaysInclude })).toHaveLength(0);
  });

  it('NOT_ANY：次级键一个都不能命中', () => {
    const book = build([
      { comment: 'A', key: ['酒馆'], keysecondary: ['雨'], selectiveLogic: SelectiveLogic.NOT_ANY, content: 'x' },
    ]);

    expect(matchWorldBookEntries(book, { scanText: '酒馆里很吵', random: alwaysInclude })).toHaveLength(1);
    expect(matchWorldBookEntries(book, { scanText: '外面的雨很大，进了酒馆', random: alwaysInclude })).toHaveLength(0);
  });

  it('AND_ALL：次级键必须全部命中', () => {
    const book = build([
      { comment: 'A', key: ['酒馆'], keysecondary: ['雨', '雪'], selectiveLogic: SelectiveLogic.AND_ALL, content: 'x' },
    ]);

    expect(matchWorldBookEntries(book, { scanText: '酒馆，雨，雪', random: alwaysInclude })).toHaveLength(1);
    expect(matchWorldBookEntries(book, { scanText: '酒馆，只有雨', random: alwaysInclude })).toHaveLength(0);
  });

  it('NOT_ALL：次级键不能全部命中', () => {
    const book = build([
      { comment: 'A', key: ['酒馆'], keysecondary: ['雨', '雪'], selectiveLogic: SelectiveLogic.NOT_ALL, content: 'x' },
    ]);

    expect(matchWorldBookEntries(book, { scanText: '酒馆，只有雨', random: alwaysInclude })).toHaveLength(1);
    expect(matchWorldBookEntries(book, { scanText: '酒馆，雨，雪', random: alwaysInclude })).toHaveLength(0);
  });

  it('disabled 条目永不出现在结果里', () => {
    const book = build([{ comment: 'A', key: ['酒馆'], content: 'x', disable: true }]);
    expect(matchWorldBookEntries(book, { scanText: '酒馆', random: alwaysInclude })).toHaveLength(0);
  });

  it('概率按注入的随机源判定', () => {
    const book = build([{ comment: 'A', key: ['酒馆'], content: 'x', probability: 50, useProbability: true }]);

    expect(matchWorldBookEntries(book, { scanText: '酒馆', random: () => 0.1 })).toHaveLength(1);
    expect(matchWorldBookEntries(book, { scanText: '酒馆', random: () => 0.9 })).toHaveLength(0);
  });

  it('概率为 100 时不消耗随机源', () => {
    const book = build([{ comment: 'A', key: ['酒馆'], content: 'x', probability: 100 }]);
    let calls = 0;

    const matches = matchWorldBookEntries(book, {
      scanText: '酒馆',
      random: () => {
        calls += 1;
        return 0.99;
      },
    });

    expect(matches).toHaveLength(1);
    expect(calls).toBe(0);
  });

  it('按 order 降序排列', () => {
    const book = build([
      { comment: '低', key: ['酒馆'], content: 'low', order: 10 },
      { comment: '高', key: ['酒馆'], content: 'high', order: 200 },
    ]);

    const matches = matchWorldBookEntries(book, { scanText: '酒馆', random: alwaysInclude });
    expect(matches.map((match) => match.entry.title)).toEqual(['高', '低']);
  });
});
