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

describe('matchWorldBookEntries：逐条 scanDepth（顺序 60）', () => {
  it('每条条目只看自己那一段窗口', () => {
    const book = build([
      { comment: '浅', key: ['酒馆'], content: 'shallow', scanDepth: 1 },
      { comment: '深', key: ['酒馆'], content: 'deep', scanDepth: 5 },
    ]);
    // 从旧到新：酒馆在第 1 条，早就不在「最近 1 条」里了
    const scanLines = ['我们进了酒馆', '他点了茶', '雨还在下'];

    const matches = matchWorldBookEntries(book, { scanLines, random: alwaysInclude });
    expect(matches.map((match) => match.entry.title)).toEqual(['深']);
  });

  it('没写 scanDepth 的用全局默认（8 条）', () => {
    const book = build([{ comment: '默认', key: ['酒馆'], content: 'x' }]);
    const inside = ['我们进了酒馆', ...Array.from({ length: 7 }, (_, index) => `第 ${String(index)} 句废话`)];
    const outside = ['我们进了酒馆', ...Array.from({ length: 8 }, (_, index) => `第 ${String(index)} 句废话`)];

    expect(matchWorldBookEntries(book, { scanLines: inside, random: alwaysInclude })).toHaveLength(1);
    expect(matchWorldBookEntries(book, { scanLines: outside, random: alwaysInclude })).toHaveLength(0);
    // 全局深度可以调
    expect(
      matchWorldBookEntries(book, { scanLines: outside, globalScanDepth: 20, random: alwaysInclude }),
    ).toHaveLength(1);
  });

  it('scanDepth 为 0 时只看得到常驻条目', () => {
    const book = build([
      { comment: '关键词', key: ['酒馆'], content: 'x', scanDepth: 0 },
      { comment: '常驻', content: '规则', constant: true, scanDepth: 0 },
    ]);

    const matches = matchWorldBookEntries(book, { scanLines: ['酒馆'], random: alwaysInclude });
    expect(matches.map((match) => match.entry.title)).toEqual(['常驻']);
  });
});

describe('matchWorldBookEntries：递归（顺序 60）', () => {
  it('上一轮命中的正文可以带出下一轮（最多 3 轮）', () => {
    const book = build([
      { comment: '一层', key: ['酒馆'], content: '掌柜姓秦', preventRecursion: false },
      { comment: '二层', key: ['秦'], content: '秦娘管着账房', preventRecursion: false },
      { comment: '三层', key: ['账房'], content: '账房在二楼', preventRecursion: false },
      { comment: '四层', key: ['二楼'], content: '二楼常年上锁', preventRecursion: false },
    ]);

    const matches = matchWorldBookEntries(book, { scanText: '酒馆', random: alwaysInclude });
    // 返回顺序按 order/标题排（不是按轮次），所以按标题对账
    const roundOf = new Map(matches.map((match) => [match.entry.title, match.round]));
    // 1 轮酒馆 → 2 轮秦 → 3 轮账房；上限 3 轮，所以第 4 层（二楼）进不来
    expect(roundOf.get('一层')).toBe(1);
    expect(roundOf.get('二层')).toBe(2);
    expect(roundOf.get('三层')).toBe(3);
    expect(roundOf.has('四层')).toBe(false);
    expect(matches).toHaveLength(3);
  });

  it('preventRecursion 的条目不做触发源（默认就是 true）', () => {
    const book = build([
      { comment: '一层', key: ['酒馆'], content: '掌柜姓秦' },
      { comment: '二层', key: ['秦'], content: '秦娘管着账房' },
    ]);

    expect(matchWorldBookEntries(book, { scanText: '酒馆', random: alwaysInclude })).toHaveLength(1);
  });

  it('excludeRecursion 的条目不会被递归触发，但主扫描照常命中', () => {
    const book = build([
      { comment: '一层', key: ['酒馆'], content: '掌柜姓秦', preventRecursion: false },
      { comment: '禁递归', key: ['秦'], content: 'x', excludeRecursion: true },
      { comment: '允许', key: ['秦'], content: 'y' },
    ]);

    // 「秦」只在递归带出来的文本里出现：禁递归的那条不该进，允许的那条该进
    const recursive = matchWorldBookEntries(book, { scanText: '酒馆', random: alwaysInclude });
    expect(recursive.map((match) => match.entry.title)).toEqual(['一层', '允许']);

    // 主扫描里就有「秦」的话，禁递归的条目正常命中
    const primary = matchWorldBookEntries(book, { scanText: '酒馆里秦娘在', random: alwaysInclude });
    expect(primary.map((match) => match.entry.title)).toContain('禁递归');
  });

  it('递归轮数可以调小', () => {
    const book = build([
      { comment: '一层', key: ['酒馆'], content: '掌柜姓秦', preventRecursion: false },
      { comment: '二层', key: ['秦'], content: '秦娘管着账房', preventRecursion: false },
    ]);

    const matches = matchWorldBookEntries(book, {
      scanText: '酒馆',
      maxRecursionRounds: 1,
      random: alwaysInclude,
    });
    expect(matches.map((match) => match.entry.title)).toEqual(['一层']);
  });
});

describe('matchWorldBookEntries：group（顺序 60）', () => {
  it('同组只留一条，order 最高的赢', () => {
    const book = build([
      { comment: '甲', key: ['酒馆'], content: 'a', group: '地点', order: 10 },
      { comment: '乙', key: ['酒馆'], content: 'b', group: '地点', order: 90 },
      { comment: '丙', key: ['酒馆'], content: 'c', group: '地点', order: 50 },
    ]);

    const matches = matchWorldBookEntries(book, { scanText: '酒馆', random: alwaysInclude });
    expect(matches.map((match) => match.entry.title)).toEqual(['乙']);
  });

  it('同组里 order 最高的没掷过骰子就顺延给下一条', () => {
    const book = build([
      { comment: '高', key: ['酒馆'], content: 'a', group: '地点', order: 90, probability: 10 },
      { comment: '低', key: ['酒馆'], content: 'b', group: '地点', order: 10, probability: 100 },
    ]);

    // 0.5 → 90%*… 高的一条（10%）没过，低的（100%）顶上
    const matches = matchWorldBookEntries(book, { scanText: '酒馆', random: () => 0.5 });
    expect(matches.map((match) => match.entry.title)).toEqual(['低']);
  });

  it('同组全都没过骰子就没有这一组的条目', () => {
    const book = build([
      { comment: '甲', key: ['酒馆'], content: 'a', group: '地点', order: 90, probability: 10 },
      { comment: '乙', key: ['酒馆'], content: 'b', group: '地点', order: 10, probability: 10 },
    ]);

    expect(matchWorldBookEntries(book, { scanText: '酒馆', random: () => 0.9 })).toHaveLength(0);
  });

  it('不进组的条目互不影响', () => {
    const book = build([
      { comment: '甲', key: ['酒馆'], content: 'a', group: '地点', order: 90 },
      { comment: '散', key: ['酒馆'], content: 'b', group: '', order: 10 },
    ]);

    const matches = matchWorldBookEntries(book, { scanText: '酒馆', random: alwaysInclude });
    expect(matches.map((match) => match.entry.title)).toEqual(['甲', '散']);
  });
});

describe('parseWorldBook：位置码（顺序 60）', () => {
  it('认识的位置码不产生 warning', () => {
    const { warnings } = parseWorldBook({
      entries: [
        { comment: 'A', key: ['a'], content: 'x', position: 0 },
        { comment: 'B', key: ['b'], content: 'y', position: 4 },
      ],
    });

    expect(warnings.some((warning) => warning.code === 'unsupported-position')).toBe(false);
  });

  it('不认识的位置码如实提示，并落到 unknown（按默认位置处理）', () => {
    const { book, warnings } = parseWorldBook({
      entries: [{ comment: 'A', key: ['a'], content: 'x', position: 9 }],
    });

    expect(book.entries[0]?.position).toBe('unknown');
    expect(warnings.some((warning) => warning.code === 'unsupported-position')).toBe(true);
  });
});
