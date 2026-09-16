import { describe, expect, it } from 'vitest';
import { instanceId, newId, nowIso, roomId } from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import { assessAttribution } from './attribution.js';

function actor(name: string): CharacterInstance {
  const now = nowIso();
  return {
    id: instanceId(newId()),
    roomId: roomId(newId()),
    cardId: newId() as never,
    displayName: name,
    presence: 'onstage',
    traits: { extroversion: 0, aggression: 0, empathy: 0, playfulness: 0, caution: 0 },
    affect: { valence: 0, arousal: 0, updatedAt: now, history: [] },
    relationships: [],
    traitsLocked: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 这里的四个用例都来自五十回合长跑的**真实输出**，不是编的：
 * 模型替场上别人发言，内容与署名不符。
 */
describe('assessAttribution', () => {
  const qinniang = actor('秦娘');
  const xiaoman = actor('小满');
  const chenjiu = actor('陈九');
  const cast = [qinniang, xiaoman, chenjiu];

  it('角色用第三人称叫自己 → 可疑（第 46 轮：小满那条写在陈九名下）', () => {
    const result = assessAttribution({
      content: '我看了看小满，又看看你，挠了下后颈。\n「她先生的书铺，我送过两回押货，见过面。」',
      speaker: { instanceId: xiaoman.id, displayName: '小满' },
      cast,
    });

    expect(result.suspicious).toBe(true);
    expect(result.reasons.join()).toContain('称呼自己');
  });

  it('第一人称句子里出现别人 → **不**判为可疑（正常的「我认得小满」不该被误报）', () => {
    const normal = assessAttribution({
      content: '我把烟斗往腰上一别。「那条道我熟，小满也知道。」',
      speaker: { instanceId: chenjiu.id, displayName: '陈九' },
      cast,
    });
    expect(normal.suspicious).toBe(false);
  });

  it('已知限制：靠道具词才能看出的错位（第 30 轮）测不出来，交给界面上的「改归属」', () => {
    // 这条其实是小满的戏（书角是她的道具、她还说「我再喊你一声陈九」），
    // 但句子里没有「自己的名字 + 我」这种硬信号，规则判不出来。
    // 与其加一堆猜测性的关键词规则（会把正常台词也标成可疑），不如让它漏过去，
    // 由「任何角色消息都能一键改归属」兜住。
    const result = assessAttribution({
      content: '我往后缩了半步，书角顶到了我的下巴。\n「真开的话，人不会只开一条缝。我再喊你一声陈九。」',
      speaker: { instanceId: qinniang.id, displayName: '秦娘' },
      cast,
    });

    expect(result.suspicious).toBe(false);
  });

  it('自己名下出现自己的名字也算可疑（第 37 轮：陈九那条里有「你跟陈九说」）', () => {
    const result = assessAttribution({
      content: '我在檐下站着。你跟陈九说要不要一个人进去的时候，我还冲你喊了退回来。',
      speaker: { instanceId: chenjiu.id, displayName: '陈九' },
      cast,
    });

    expect(result.suspicious).toBe(true);
    expect(result.candidates.map((item) => item.displayName)).toContain('小满');
  });

  it('正常回复不误报：提到别人但是第三人称叙述，或只是点名对话', () => {
    const normal = [
      '我朝门口看了一眼。「小满，你先别走。」', // 点名对话：句子里有别人，但不是自我叙述
      '# 我把抹布往肩上一搭，头也没抬。\n「这雨一时半会儿停不了。」',
      '我把烟斗往腰上一别。「那条道我熟，姓周的搭过我船。」',
    ];

    for (const content of normal) {
      const result = assessAttribution({
        content,
        speaker: { instanceId: chenjiu.id, displayName: '陈九' },
        cast,
      });
      // 「我朝门口看了一眼。「小满，你先别走。」」这句里「我」与「小满」在不同句子，
      // 不该被算作「在写别人的戏」
      expect(result.suspicious).toBe(false);
    }
  });

  it('场上只有一个人时不会误报别人的名字', () => {
    const result = assessAttribution({
      content: '我把书往怀里一抱。「我什么也没看见。」',
      speaker: { instanceId: xiaoman.id, displayName: '小满' },
      cast: [xiaoman],
    });

    expect(result.suspicious).toBe(false);
  });

  it('老数据里残留的转写标记不算「自报家门」', () => {
    const result = assessAttribution({
      content: '【秦娘】【秦娘】她笑了一声，把酒壶推过去。\n「对，记着呢。」',
      speaker: { instanceId: qinniang.id, displayName: '秦娘' },
      cast,
    });

    expect(result.suspicious).toBe(false);
  });
});
