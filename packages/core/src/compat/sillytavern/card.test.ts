import { describe, expect, it } from 'vitest';
import { DEFAULT_CARD_SYSTEM_PROMPT } from '../../model/card.js';
import { CardImportError, decodeCardPayload, importCardFromJson, parseCharacterCard } from './card.js';

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('parseCharacterCard', () => {
  it('解析 V2 卡', () => {
    const { card, warnings } = parseCharacterCard({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Alice',
        description: '酒馆的老板',
        personality: '爽朗',
        scenario: '雨夜的酒馆',
        first_mes: '欢迎光临。',
        mes_example: '<START>\n{{user}}: 你好\n{{char}}: 坐吧。',
        creator: 'tester',
        creator_notes: '测试用卡',
        character_version: '1.2',
        alternate_greetings: ['你来得正好。', '又是你。'],
        tags: ['酒馆', '日常'],
        system_prompt: '保持角色。',
        post_history_instructions: '不要跳戏。',
        character_book: { name: 'book' },
      },
    });

    expect(card.name).toBe('Alice');
    expect(card.firstMessage).toBe('欢迎光临。');
    expect(card.alternateGreetings).toEqual(['你来得正好。', '又是你。']);
    expect(card.tags).toEqual(['酒馆', '日常']);
    expect(card.embeddedWorldBook).toEqual({ name: 'book' });
    expect(card.characterVersion).toBe('1.2');
    expect(card.source.spec).toBe('chara_card_v2');
    expect(card.source.specVersion).toBe('2.0');
    expect(card.systemPrompt).toBe('保持角色。');
    expect(warnings).toHaveLength(0);
  });

  it('解析 V1 平铺卡', () => {
    const { card } = parseCharacterCard({
      name: 'Bob',
      description: '沉默的佣兵',
      personality: '寡言',
      first_mes: '……',
      mes_example: '',
    });

    expect(card.name).toBe('Bob');
    expect(card.source.spec).toBe('chara_card_v1');
    expect(card.source.specVersion).toBe('');
    expect(card.systemPrompt).toBe(DEFAULT_CARD_SYSTEM_PROMPT);
  });

  it('未识别字段被保留并产生提示，而不是静默丢弃', () => {
    const { card, warnings } = parseCharacterCard({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Carol',
        first_mes: '嗨',
        custom_field: { nested: true },
      },
    });

    expect(card.extensions.custom_field).toEqual({ nested: true });
    expect(warnings.some((warning) => warning.code === 'unknown-fields')).toBe(true);
  });

  it('缺少名字与开场白时给出提示并继续', () => {
    const { card, warnings } = parseCharacterCard({ spec: 'chara_card_v2', data: {} });

    expect(card.name).toBe('未命名角色');
    expect(warnings.map((warning) => warning.code)).toContain('missing-name');
    expect(warnings.map((warning) => warning.code)).toContain('missing-greeting');
  });

  it('空 extensions 字段不产生噪声', () => {
    const { card, warnings } = parseCharacterCard({
      spec: 'chara_card_v2',
      data: { name: 'X', first_mes: '嗨', extensions: { talkativeness: '0.5' } },
    });

    expect(card.extensions).toEqual({ talkativeness: '0.5' });
    expect(warnings).toHaveLength(0);
  });

  it('拒绝非对象输入', () => {
    expect(() => parseCharacterCard('nope')).toThrow(CardImportError);
    expect(() => parseCharacterCard(null)).toThrow(CardImportError);
  });
});

describe('decodeCardPayload', () => {
  it('识别明文 JSON', () => {
    expect(decodeCardPayload('{"name":"A"}')).toEqual({ name: 'A' });
  });

  it('识别 base64 编码的 JSON', () => {
    expect(decodeCardPayload(toBase64('{"name":"中文名"}'))).toEqual({ name: '中文名' });
  });

  it('拒绝空载荷', () => {
    expect(() => decodeCardPayload('   ')).toThrow(CardImportError);
  });
});

describe('importCardFromJson', () => {
  it('解析 JSON 文本并记录来源', () => {
    const { card } = importCardFromJson('{"name":"Dave","first_mes":"早"}', 'dave.json');

    expect(card.name).toBe('Dave');
    expect(card.source.kind).toBe('json');
    expect(card.source.fileName).toBe('dave.json');
  });

  it('非法 JSON 给出明确错误', () => {
    expect(() => importCardFromJson('{oops')).toThrow(/JSON/);
  });
});
