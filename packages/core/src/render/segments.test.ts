import { describe, expect, it } from 'vitest';
import {
  hasSpeech,
  normalizeCardExample,
  renderMessageContent,
  splitByQuotes,
  splitLongSpeech,
  splitMessageContent,
  thirdPersonAction,
} from './segments.js';

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

  it('句末标点后面的 `#` 仍算动作分段（模型常把动作与对白挤在一行）', () => {
    const segments = splitMessageContent(
      '「上个月的事，六个人，车马一起没的。」# 她朝陈九那边抬了下下巴。「他跑船的。」',
    );

    expect(segments).toEqual([
      { kind: 'speech', text: '「上个月的事，六个人，车马一起没的。」' },
      { kind: 'action', text: '她朝陈九那边抬了下下巴。「他跑船的。」' },
    ]);
  });

  it('中文引号收尾后接 `#` 也断行', () => {
    const segments = splitMessageContent('「你问这个做什么。」# 她把杯子放下。');
    expect(segments.map((segment) => segment.kind)).toEqual(['speech', 'action']);
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

  it('剥掉「自己名字：」前缀，让后面的 `#` 重新变成动作标记', () => {
    // 真实模型端到端测试里的原样输出：自报家门 + 行内动作
    const pieces = renderMessageContent('秦娘：# 她拎起酒壶，往你杯里斟满。\n「姓周的——收旧书那个？」', {
      speakerName: '秦娘',
    });

    expect(pieces).toEqual([
      { kind: 'action', text: '她拎起酒壶，往你杯里斟满。' },
      { kind: 'speech', text: '「姓周的——收旧书那个？」' },
    ]);
  });

  it('写成别人的名字时保留正文（冒充要看得见），但不保留「名字：」这种假前缀', () => {
    const pieces = renderMessageContent('陈九：他抬眼看你。', { speakerName: '秦娘' });
    expect(pieces[0]?.text).toBe('陈九：他抬眼看你。');

    // 转写标记【…】不同：那是我们写进提示词的记号，角色不会这么说话，一律剥掉
    const copied = renderMessageContent('【陈九】# 我把烟斗重新点上。', { speakerName: '秦娘' });
    expect(copied).toEqual([{ kind: 'action', text: '我把烟斗重新点上。' }]);
  });

  it('照抄历史标记「【名字】」时也剥掉', () => {
    const pieces = renderMessageContent('【秦娘】# 她把壶放下。', { speakerName: '秦娘' });
    expect(pieces).toEqual([{ kind: 'action', text: '她把壶放下。' }]);
  });

  it('连着抄了多个标记也全部剥掉（长跑里真的长到五个）', () => {
    const pieces = renderMessageContent('【秦娘】【秦娘】【秦娘】「打烊了。」', { speakerName: '秦娘' });
    expect(pieces).toEqual([{ kind: 'speech', text: '「打烊了。」' }]);
  });
});

describe('normalizeCardExample', () => {
  it('把卡里的行内动作断到行首、把名字标签换成【】', () => {
    const raw = [
      '玩家：北边那支商队的事你听说了吗？',
      '陈九：听说？# 他压低声音，指节敲了两下桌子。「我的货找谁要去。」',
    ].join('\n');

    const normalized = normalizeCardExample(raw, ['陈九', '老周']);

    expect(normalized).toBe(
      [
        '【玩家】北边那支商队的事你听说了吗？',
        '【陈九】听说？',
        '# 他压低声音，指节敲了两下桌子。「我的货找谁要去。」',
      ].join('\n'),
    );
  });

  it('不认识的名字标签不动：那不是说话人标记', () => {
    const raw = '备注：这段是给作者看的。';
    expect(normalizeCardExample(raw, ['陈九'])).toBe('备注：这段是给作者看的。');
  });
});

describe('引号兜底：模型不写 `#` 时按引号分段', () => {
  it('hasSpeech 只认真的说了话的那一轮', () => {
    expect(hasSpeech('「你问这个做什么。」')).toBe(true);
    expect(hasSpeech('# 她把杯子放下，没抬头。')).toBe(false);
    // 没有引号 = 这一轮只做了动作。判据是引号，不是渲染规则（渲染为了兼容会把
    // 无引号的行也当对白显示）
    expect(hasSpeech('她把杯子放下。')).toBe(false);
    expect(hasSpeech('# 她把杯子放下。\n「……」')).toBe(true);
  });
  it('引号内是对白，引号外是动作', () => {
    const segments = splitMessageContent('她把酒壶提起来搁到炭盆上。\n「温着呢，别催。」');

    expect(segments).toEqual([
      { kind: 'action', text: '她把酒壶提起来搁到炭盆上。' },
      { kind: 'speech', text: '「温着呢，别催。」' },
    ]);
  });

  it('对白与动作挤在同一行时也能切开', () => {
    const segments = splitMessageContent('她没回头。「胡掌柜？会做生意的。」');

    expect(segments).toEqual([
      { kind: 'action', text: '她没回头。' },
      { kind: 'speech', text: '「胡掌柜？会做生意的。」' },
    ]);
  });

  it('整条消息没有引号时保持原样（全是对白），不把独白误判成动作', () => {
    const segments = splitMessageContent('我要是能管天，早把这铺子搬走了。');
    expect(segments).toEqual([{ kind: 'speech', text: '我要是能管天，早把这铺子搬走了。' }]);
  });

  it('`#` 标记依然有效，且优先于引号规则', () => {
    const segments = splitMessageContent('# 她把杯子放下。\n「你问这个做什么。」');
    expect(segments.map((segment) => segment.kind)).toEqual(['action', 'speech']);
  });

  it('splitByQuotes 认得中英文引号', () => {
    expect(splitByQuotes('She said "hello" and left.')).toEqual([
      { quoted: false, text: 'She said' },
      { quoted: true, text: '"hello"' },
      { quoted: false, text: 'and left.' },
    ]);
  });
});

describe('动作主语用名字（thirdPersonAction）', () => {
  it('把动作里的「我」换成说话人的名字', () => {
    expect(thirdPersonAction('我把斗笠檐往上一抬，正眼看你。', '陈九')).toBe('陈九把斗笠檐往上一抬，正眼看你。');
    expect(thirdPersonAction('我把手从钩子上收回来。', '陈九')).toBe('陈九把手从钩子上收回来。');
  });

  it('「我的」一起换：名字 + 的', () => {
    expect(thirdPersonAction('我把我的碗推过去。', '秦娘')).toBe('秦娘把秦娘的碗推过去。');
  });

  it('引号里的「我」一个字都不动——那是他在说话', () => {
    expect(thirdPersonAction('我抬眼看他。「我什么也没看见。」', '小满')).toBe('小满抬眼看他。「我什么也没看见。」');
  });

  it('三种不该动的「我」：我们、自我、你我', () => {
    expect(thirdPersonAction('我们得走了。', '陈九')).toBe('我们得走了。');
    expect(thirdPersonAction('他有点自我怀疑。', '陈九')).toBe('他有点自我怀疑。');
    expect(thirdPersonAction('你我之间不必多说。', '陈九')).toBe('你我之间不必多说。');
  });

  it('名字为空时原样返回（比如流式气泡还不知道是谁）', () => {
    expect(thirdPersonAction('我把碗放下。', '  ')).toBe('我把碗放下。');
  });

  it('同一段里第二次当主语时省略，而不是把名字念两遍', () => {
    expect(thirdPersonAction('我看了看她，我又低下头。', '陈九')).toBe('陈九看了看她，又低下头。');
    // 不是主语位置（比如「比我高」）就照常换成名字，不能删
    expect(thirdPersonAction('他比我还高。我记下了。', '陈九')).toBe('他比陈九还高。陈九记下了。');
  });

  it('渲染时按选项生效：角色开、玩家不开', () => {
    const content = '我把杯子放下。\n「你问这个做什么。」';

    const asCharacter = renderMessageContent(content, { speakerName: '秦娘', thirdPersonActions: true });
    expect(asCharacter).toEqual([
      { kind: 'action', text: '秦娘把杯子放下。' },
      { kind: 'speech', text: '「你问这个做什么。」' },
    ]);

    const asPlayer = renderMessageContent(content, { speakerName: '旅人' });
    expect(asPlayer[0]).toEqual({ kind: 'action', text: '我把杯子放下。' });
  });
});
