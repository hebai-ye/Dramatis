import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStreamState, resetStreamState, setStreamState, subscribeStream } from './stream-store';

const IDLE = { text: '', speaker: '', reasoning: '', phase: 'idle' } as const;

describe('流式状态与订阅边界（顺序 59）', () => {
  beforeEach(() => {
    resetStreamState('main');
    resetStreamState('admin');
  });
  afterEach(() => {
    resetStreamState('main');
    resetStreamState('admin');
  });

  it('正文 token 只通知订阅者，不变的帧不通知，也不替换快照', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeStream('main', listener);
    const initial = getStreamState('main');

    setStreamState('main', { text: '你' });
    const firstToken = getStreamState('main');
    expect(firstToken).not.toBe(initial);
    expect(listener).toHaveBeenCalledTimes(1);

    setStreamState('main', { text: '你' });
    expect(getStreamState('main')).toBe(firstToken);
    expect(listener).toHaveBeenCalledTimes(1);

    setStreamState('main', { text: '你好' });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setStreamState('main', { text: '你好。' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('说话人和阶段一起切换只通知一次；结束清空四态也只通知一次', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeStream('main', listener);
    setStreamState('main', { phase: 'planning' });
    setStreamState('main', { speaker: '秦娘', phase: 'writing' });
    setStreamState('main', { text: '先坐。', reasoning: '他决定开口' });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(getStreamState('main')).toEqual({
      text: '先坐。',
      speaker: '秦娘',
      reasoning: '他决定开口',
      phase: 'writing',
    });

    resetStreamState('main');
    expect(listener).toHaveBeenCalledTimes(4);
    expect(getStreamState('main')).toEqual(IDLE);
    resetStreamState('main');
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it('退订只影响自己那一条订阅，同一通道的其它订阅者照常收到', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeStream('main', first);
    const unsubscribeSecond = subscribeStream('main', second);

    setStreamState('main', { text: '一' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    setStreamState('main', { text: '二' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);

    // 重复退订不该把别人的订阅一起带走
    unsubscribeFirst();
    setStreamState('main', { text: '三' });
    expect(second).toHaveBeenCalledTimes(3);

    unsubscribeSecond();
    setStreamState('main', { text: '四' });
    expect(second).toHaveBeenCalledTimes(3);
  });

  it('主对话与副对话互不干扰：写一条通道不通知另一条的订阅者', () => {
    const mainListener = vi.fn();
    const adminListener = vi.fn();
    const unsubscribeMain = subscribeStream('main', mainListener);
    const unsubscribeAdmin = subscribeStream('admin', adminListener);

    resetStreamState('admin');
    expect(mainListener).toHaveBeenCalledTimes(0);
    expect(adminListener).toHaveBeenCalledTimes(0);

    setStreamState('main', { text: '主对话在流', speaker: '秦娘', phase: 'writing' });
    expect(mainListener).toHaveBeenCalledTimes(1);
    expect(adminListener).toHaveBeenCalledTimes(0);
    expect(getStreamState('admin')).toEqual(IDLE);

    setStreamState('admin', { text: '管理员在起草', phase: 'writing' });
    expect(mainListener).toHaveBeenCalledTimes(1);
    expect(adminListener).toHaveBeenCalledTimes(1);
    // 主通道的内容没被副对话写脏
    expect(getStreamState('main')).toEqual({
      text: '主对话在流',
      speaker: '秦娘',
      reasoning: '',
      phase: 'writing',
    });

    resetStreamState('admin');
    expect(getStreamState('admin')).toEqual(IDLE);
    expect(mainListener).toHaveBeenCalledTimes(1);
    expect(adminListener).toHaveBeenCalledTimes(2);

    unsubscribeMain();
    unsubscribeAdmin();
  });

  it('没有变化就不换快照引用；同一个值重复写也不通知', () => {
    const base = getStreamState('main');
    setStreamState('main', {});
    expect(getStreamState('main')).toBe(base);

    setStreamState('main', { phase: 'idle' });
    expect(getStreamState('main')).toBe(base);

    setStreamState('main', { text: '有变化' });
    const changed = getStreamState('main');
    expect(changed).not.toBe(base);

    setStreamState('main', { text: '有变化' });
    expect(getStreamState('main')).toBe(changed);
  });
});
