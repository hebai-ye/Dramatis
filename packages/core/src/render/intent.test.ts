import { describe, expect, it } from 'vitest';
import { intentKind, splitIntent } from './intent.js';

describe('splitIntent', () => {
  it('把开头的意图行摘出来，正文保留', () => {
    const result = splitIntent('意图：把那批货的来路问清楚\n\n「你说的三十箱，是谁点过数的？」');

    expect(result.intent).toBe('把那批货的来路问清楚');
    expect(result.body).toBe('「你说的三十箱，是谁点过数的？」');
  });

  it('没有意图行时原样返回，不误伤正文', () => {
    const content = '她把杯子放下。\n「这雨一时半会儿停不了。」';
    expect(splitIntent(content)).toEqual({ intent: null, body: content });
  });

  it('正文里出现「意图：」不算声明——只认开头', () => {
    const content = '她笑了一声。\n意图：这句话该由谁来说？';
    expect(splitIntent(content).intent).toBeNull();
  });

  it('容忍半角冒号、前后空格与空行', () => {
    expect(splitIntent('  意图: 观察他会不会先开口  \n\n\n「……」').intent).toBe('观察他会不会先开口');
  });

  it('只有意图没有正文时，正文是空串', () => {
    expect(splitIntent('意图：听他说完')).toEqual({ intent: '听他说完', body: '' });
  });
});

describe('intentKind', () => {
  it('按关键词分成四类', () => {
    expect(intentKind('观察他会不会先开口')).toBe('wait');
    expect(intentKind('追问那批货的来路')).toBe('ask');
    expect(intentKind('提醒他别一个人进去')).toBe('initiate');
    expect(intentKind('把酒壶推过去')).toBe('other');
    expect(intentKind(null)).toBe('other');
  });

  it('「等他回答」这类先判为按兵不动，不会被「问」字抢走', () => {
    expect(intentKind('等他把话说完，再问他')).toBe('wait');
  });
});
