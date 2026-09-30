import { describe, expect, it } from 'vitest';
import { instanceId } from '../model/ids.js';
import {
  assessBleed,
  buildSignatures,
  extractSignatureSpans,
  MIN_SIGNATURE_LENGTH,
  type SignatureMember,
} from './bleed.js';

const QIN = instanceId('inst-qin');
const CHEN = instanceId('inst-chen');
const MAN = instanceId('inst-man');
const OUTSIDER = instanceId('inst-outsider');

const QIN_CARD = '酒铺掌柜，一个人守着这间铺子，柜台擦得能照出人影。';
const CHEN_CARD = '走货的，八岁那年雷砸了船，船板掀起来，攥缆绳攥出来的。';
const MAN_CARD = '秦娘是个好人；给我留了半页纸。';

function members(): SignatureMember[] {
  return [
    { instanceId: QIN, displayName: '秦娘', material: [QIN_CARD] },
    { instanceId: CHEN, displayName: '陈九', material: [CHEN_CARD] },
    { instanceId: MAN, displayName: '小满', material: [MAN_CARD] },
  ];
}

function spansOf(signatures: ReturnType<typeof buildSignatures>, id: typeof QIN): readonly string[] {
  return signatures.find((owner) => owner.instanceId === id)?.spans ?? [];
}

describe('顺序 79：抽「独有说法」的片段', () => {
  it('整句与分句两个粒度都抽，剥掉行首标记', () => {
    const spans = extractSignatureSpans('# 八岁那年雷砸了船，船板掀起来\n- 船板掀起来');
    expect(spans).toContain('八岁那年雷砸了船，船板掀起来');
    expect(spans).toContain('八岁那年雷砸了船');
    expect(spans).toContain('船板掀起来');
    expect(spans).not.toContain('# 八岁那年雷砸了船，船板掀起来');
  });

  it(`${MIN_SIGNATURE_LENGTH} 字下限与「只有数字符号」的片段都丢掉`, () => {
    const spans = extractSignatureSpans('他走了，好的，12345678，这天真冷');
    expect(spans).not.toContain('他走了');
    expect(spans).not.toContain('好的');
    expect(spans).not.toContain('12345678');
    expect(spans).toContain('这天真冷');
  });
});

describe('顺序 79：什么样的片段才算「他独有」', () => {
  it('只有他自己的卡里写过的片段留得下来', () => {
    const signatures = buildSignatures(members());
    expect(spansOf(signatures, CHEN)).toContain('八岁那年雷砸了船');
    expect(spansOf(signatures, QIN)).toContain('柜台擦得能照出人影');
    expect(spansOf(signatures, MAN)).toContain('给我留了半页纸');
  });

  it('片段里出现任何人的名字，都不算独有说法', () => {
    const signatures = buildSignatures(members());
    const all = signatures.flatMap((owner) => owner.spans);
    expect(all.some((span) => span.includes('秦娘'))).toBe(false);
    expect(all.some((span) => span.includes('陈九'))).toBe(false);
    // 小满那句本来是「秦娘是个好人」，栽在名字上被丢掉，能留下的只有后半句
    expect(spansOf(signatures, MAN)).not.toContain('秦娘是个好人');
  });

  it('两个人卡里都有的说法不算谁独有', () => {
    const shared = '这条街上住了二十年，谁家的事都瞒不住。';
    const signatures = buildSignatures([
      { instanceId: QIN, displayName: '秦娘', material: [shared] },
      { instanceId: MAN, displayName: '小满', material: [shared] },
    ]);
    const all = signatures.flatMap((owner) => owner.spans);
    expect(all.some((span) => span.includes('这条街上住了二十年'))).toBe(false);
  });

  it('世界书与场景里写过的说法不算谁独有', () => {
    const signatures = buildSignatures([{ instanceId: QIN, displayName: '秦娘', material: [QIN_CARD] }], {
      shared: ['酒铺里的柜台擦得能照出人影'],
    });
    expect(spansOf(signatures, QIN)).not.toContain('柜台擦得能照出人影');
  });
});

describe('顺序 79：串线判定', () => {
  it('秦娘复述陈九的身世 → 命中，并给出原话片段', () => {
    const assessment = assessBleed({
      content: '我八岁那年雷砸了船，船板掀起来，攥缆绳攥出来的。',
      speakerInstanceId: QIN,
      signatures: buildSignatures(members()),
    });
    expect(assessment.bleeding).toBe(true);
    expect(assessment.hits).toHaveLength(1);
    expect(assessment.hits[0]?.ownerInstanceId).toBe(CHEN);
    expect(assessment.hits[0]?.ownerName).toBe('陈九');
    expect(assessment.hits[0]?.span).toContain('八岁那年雷砸了船');
    expect(assessment.reason).toContain('陈九');
  });

  it('陈九说自己的身世不算串线', () => {
    const assessment = assessBleed({
      content: '我八岁那年雷砸了船，船板掀起来，攥缆绳攥出来的。',
      speakerInstanceId: CHEN,
      signatures: buildSignatures(members()),
    });
    expect(assessment.bleeding).toBe(false);
    expect(assessment.reason).toBeNull();
  });

  it('提到别人的名字、说大家都写的布景，都不报警', () => {
    const signatures = buildSignatures(members(), { shared: ['酒铺里的柜台擦得能照出人影'] });
    const assessment = assessBleed({
      content: '柜台擦得能照出人影，我等着陈九回来。',
      speakerInstanceId: MAN,
      signatures,
    });
    expect(assessment.bleeding).toBe(false);
  });

  it('一条消息最多报三条，多的不摆出来', () => {
    const four: SignatureMember[] = ['一号', '二号', '三号', '四号'].map((name, index) => ({
      instanceId: instanceId(`inst-${String(index)}`),
      displayName: name,
      material: [['左手有六根指头的人', '曾在北边打过三年铁', '会唱一支没有词的歌', '养了一条不叫的狗'][index] ?? ''],
    }));
    const assessment = assessBleed({
      content:
        '我知道左手有六根指头的人，也见过曾在北边打过三年铁，还听过会唱一支没有词的歌，另外有人养了一条不叫的狗。',
      speakerInstanceId: OUTSIDER,
      signatures: buildSignatures(four),
    });
    expect(assessment.bleeding).toBe(true);
    expect(assessment.hits).toHaveLength(3);
    expect(assessment.hits[0]?.ownerName).toBe('一号');
  });

  it('没有内容、没有签名时安静返回', () => {
    expect(assessBleed({ content: '……', speakerInstanceId: QIN, signatures: [] })).toEqual({
      bleeding: false,
      hits: [],
      reason: null,
    });
    expect(assessBleed({ content: '', speakerInstanceId: QIN, signatures: buildSignatures(members()) })).toEqual({
      bleeding: false,
      hits: [],
      reason: null,
    });
  });
});
