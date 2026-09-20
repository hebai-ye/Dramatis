import { describe, expect, it } from 'vitest';
import { createBlankCard } from '../model/card.js';
import { createConversation } from '../model/conversation.js';
import { createPersona } from '../model/persona.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { createWorldFromCard } from '../session/setup.js';
import { Repository } from '../storage/repository.js';
import { buildAdminBridgeMessages, describeAdminTools, parseAdminBridgeOutput } from './bridge.js';
import { parseAdminToolCall } from './tools.js';

describe('describeAdminTools', () => {
  it('把三件事连同参数与必填都写出来（网页版只能靠这段文字知道能做什么）', () => {
    const text = describeAdminTools();

    expect(text).toContain('upsert_character_card');
    expect(text).toContain('upsert_world_book');
    expect(text).toContain('set_scene');
    expect(text).toContain('name（必填）');
    expect(text).toContain('content（必填）');
    expect(text).toContain('open / locked / invite_only / triggered');
  });
});

describe('buildAdminBridgeMessages', () => {
  it('在原来的提示词后面补一段「这次没有工具接口」的说明', async () => {
    const repository = new Repository(createMemoryEntityStore());
    const persona = createPersona({ name: '沈砚' });
    const card = createBlankCard({ name: '秦娘' });
    const world = createWorldFromCard(card, persona);
    await repository.saveCard(card);

    const messages = buildAdminBridgeMessages({
      room: world.room,
      conversation: createConversation({ roomId: world.room.id, title: '世界管理', kind: 'side' }),
      scene: null,
      instances: [world.instance],
      cards: [card],
      worldBooks: [],
      history: [],
      userInput: '帮我起草一个角色',
    });

    const last = messages[messages.length - 1];
    expect(last?.role).toBe('system');
    expect(last?.content).toContain('这次你没有工具接口可以用');
    expect(last?.content).toContain('{"tool":"工具名","arguments":{...}}');
  });
});

describe('parseAdminBridgeOutput', () => {
  it('拿出代码块里的工具调用，剩下的当正文', () => {
    const raw = [
      '好，我先起草一张角色卡。',
      '```json',
      '{"tool":"upsert_character_card","arguments":{"name":"秦娘","description":"货栈掌柜"}}',
      '```',
      '采纳之后她就能进场景了。',
    ].join('\n');

    const parsed = parseAdminBridgeOutput(raw);

    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]?.function.name).toBe('upsert_character_card');
    expect(parsed.answer).toContain('好，我先起草一张角色卡。');
    expect(parsed.answer).toContain('采纳之后她就能进场景了。');
    expect(parsed.answer).not.toContain('"tool"');
    expect(parsed.invalid).toEqual([]);
  });

  it('一次多个块（多件事）都收下，顺序不变', () => {
    const raw = [
      '```json',
      '{"tool":"upsert_character_card","arguments":{"name":"陈九","description":"账房"}}',
      '```',
      '```json',
      '{"tool":"set_scene","arguments":{"location":"货栈"}}',
      '```',
    ].join('\n');

    const parsed = parseAdminBridgeOutput(raw);
    expect(parsed.calls.map((call) => call.function.name)).toEqual(['upsert_character_card', 'set_scene']);
  });

  it('没加围栏、直接写在正文里的 JSON 也认', () => {
    const raw = '{"tool":"set_scene","arguments":{"worldTime":"第三日"}} 已按你说的改了时间。';
    const parsed = parseAdminBridgeOutput(raw);

    expect(parsed.calls).toHaveLength(1);
    expect(parsed.answer).toBe('已按你说的改了时间。');
  });

  it('参数写成 arguments 字符串也能收（有些模型会把它序列化成字符串）', () => {
    const raw = '{"tool":"set_scene","arguments":"{\\"location\\":\\"河滩\\"}"}';
    const parsed = parseAdminBridgeOutput(raw);
    expect(parsed.calls[0]?.function.arguments).toBe('{"location":"河滩"}');
  });

  it('认不出的工具名单独报出来，不静默吞掉', () => {
    const parsed = parseAdminBridgeOutput('{"tool":"delete_everything","arguments":{}}');
    expect(parsed.invalid).toEqual(['delete_everything']);
  });

  it('正文里出现无关的 JSON 时保持原样（不当成工具调用）', () => {
    const raw = '这段设定里有个对象 {"weather":"rain"}，我只说这个。';
    const parsed = parseAdminBridgeOutput(raw);

    expect(parsed.calls).toHaveLength(0);
    expect(parsed.answer).toBe(raw);
  });

  it('坏 JSON 不抛错，当正文处理', () => {
    const parsed = parseAdminBridgeOutput('```json\n{"tool": "set_scene", 这里坏了}\n```');
    expect(parsed.calls).toHaveLength(0);
    expect(parsed.answer).toContain('这里坏了');
  });

  it('解析出来的调用能直接喂给同一套校验（参数缺失时如实报错）', () => {
    const parsed = parseAdminBridgeOutput('{"tool":"upsert_character_card","arguments":{"name":"只有名字"}}');
    const result = parseAdminToolCall(parsed.calls[0] as never, {});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('description');
  });
});
