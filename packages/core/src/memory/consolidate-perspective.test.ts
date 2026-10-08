import { describe, expect, it } from 'vitest';
import { createBlankCard } from '../model/card.js';
import { conversationId, eventId, instanceId, messageId, newId, roomId } from '../model/ids.js';
import type { MemoryEvent } from '../model/message.js';
import { createPersona } from '../model/persona.js';
import { assemblePrompt } from '../prompt/assemble.js';
import { createWorldFromCard } from '../session/setup.js';
import { heuristicTokenCounter } from '../token/estimate.js';
import { renderAttachmentExpansion } from './attachment.js';
import { applyConsolidation, buildConsolidationPrompt, planConsolidation } from './consolidate.js';
import { selectWithinBudget } from './recall.js';

const AT = '2026-09-21T10:00:00.000Z';
const ROOM = roomId('room-a');
const OBSERVER = instanceId('observer-a');
const CONVERSATION = conversationId('conversation-a');

function memory(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: eventId(newId()),
    roomId: ROOM,
    conversationId: CONVERSATION,
    sceneId: null,
    timeline: { worldTime: '第一日', sequence: 1 },
    location: '账房',
    participants: [OBSERVER],
    summary: '秦娘把账本收进柜里。',
    observerId: OBSERVER,
    perception: '我以为她在藏证据。',
    importance: 0.3,
    pinned: false,
    importanceLocked: false,
    affects: [],
    sourceTurnIds: [],
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
    supersededBy: null,
    supersedes: [],
    consolidatedAt: null,
    lastRecalledAt: null,
    recallCount: 0,
    ...overrides,
  };
}

function batch(overrides: Partial<MemoryEvent> = {}): MemoryEvent[] {
  return [memory(overrides), memory({ createdAt: '2026-09-21T10:01:00.000Z', ...overrides })];
}

function planFor(memories: MemoryEvent[]) {
  const group = planConsolidation(memories, { threshold: 2, batchSize: 2 })[0];
  if (group === undefined) throw new Error('应当产生合并组');
  return group;
}

const FOREIGN_SCOPES: { label: string; overrides: Partial<MemoryEvent> }[] = [
  { label: '另一房间', overrides: { roomId: roomId('room-b') } },
  { label: '另一观察者', overrides: { observerId: instanceId('observer-b') } },
  { label: '另一对话', overrides: { conversationId: conversationId('conversation-b') } },
  { label: '无对话', overrides: { conversationId: null } },
  { label: '客观组', overrides: { observerId: null } },
];

// 无模型、无数据库：断言送模材料与落地字段，固定 A07 的输入/输出契约。
describe('A07：合并保留谁在看以及该角色的 perception', () => {
  it('同一经过的不同观察者各自使用观感，明确姓名与实例，材料按时间排序且不修改输入', () => {
    const own = [
      memory({ summary: '共同经过一', perception: '我以为她在藏证据。' }),
      memory({
        summary: '共同经过二',
        perception: '我仍不敢相信她。',
        createdAt: '2026-09-22T10:00:00.000Z',
      }),
    ];
    const group = planConsolidation(own, { threshold: 2, batchSize: 2, gapMs: 2 * 24 * 3600_000 })[0];
    if (group === undefined) throw new Error('应当产生合并组');
    const other = batch({ observerId: instanceId('observer-b'), perception: '我相信她只是整理账本。' });
    const foreign = FOREIGN_SCOPES.flatMap(({ overrides }) =>
      batch({ ...overrides, summary: '不属于本组的经过', perception: '不属于本组的观感' }),
    );
    const pool = [...other, ...foreign, ...own].reverse();
    const before = structuredClone(pool);
    const prompt = buildConsolidationPrompt(group, pool, '  小满  ');

    expect(prompt).toContain(`观察者：小满（实例 ID：${OBSERVER}）`);
    expect(prompt).toContain('共同经过一');
    expect(prompt).toContain('共同经过二');
    expect(prompt).toContain('我以为她在藏证据。');
    expect(prompt).toContain('我仍不敢相信她。');
    expect(prompt.indexOf('共同经过一')).toBeLessThan(prompt.indexOf('共同经过二'));
    expect(prompt).toContain('可能包含误解');
    expect(prompt).toContain('不得把观感或误解升级为客观事实');
    expect(prompt).toContain('上述观察者的第一人称');
    expect(prompt).not.toContain('我相信她只是整理账本。');
    expect(prompt).not.toContain('不属于本组');
    const otherPrompt = buildConsolidationPrompt(planFor(other), pool, '陈九');
    expect(otherPrompt).toContain('观察者：陈九');
    expect(otherPrompt).toContain('我相信她只是整理账本。');
    expect(otherPrompt).not.toContain('我以为她在藏证据。');
    expect(pool).toEqual(before);
  });

  it('不传姓名或传空白仍明确观察者 ID，兼容原来的两参数调用', () => {
    const own = batch();
    const group = planFor(own);
    const prompt = buildConsolidationPrompt(group, own);
    expect(prompt).toContain(`观察者：实例 ID：${OBSERVER}`);
    expect(prompt).toContain('我以为她在藏证据。');
    expect(buildConsolidationPrompt(group, own, ' \n ')).toBe(prompt);
  });

  it('旧条目没有 perception 时仍保留经过，不编造心理', () => {
    const own = batch({ perception: '  ' });
    const prompt = buildConsolidationPrompt(planFor(own), own, '小满');
    expect(prompt).toContain('秦娘把账本收进柜里。');
    expect(prompt).not.toContain('观感（perception');
    expect(prompt).toContain('不补写未记录的心理');
  });

  it('既有印象作为提示词材料时，summary 中的主观限定不因 perception 为空而被客观化', () => {
    const own = batch();
    const group = planFor(own);
    const text = '我以为秦娘藏了证据，但这只是我的猜测。';
    const impressions = own.map((item) => ({ ...item, summary: text, perception: '', consolidatedAt: AT }));
    // 仅验证材料呈现；不开放老印象自动再次合并。
    expect(planConsolidation(impressions, { threshold: 2 })).toEqual([]);
    const prompt = buildConsolidationPrompt(group, impressions, '小满');
    expect(prompt).toContain(`该观察者已记录的印象／经过：${text}`);
    expect(prompt).not.toContain(`客观经过：${text}`);
    expect(prompt).toContain('保留 summary 与 perception 中已有的主观限定');
    expect(prompt).toContain('perception 为空也不代表 summary 是客观事实');
    expect(prompt).toContain('不得把观感或误解升级为客观事实');
  });

  it('客观组不用观察者姓名与 perception，不再要求第一人称或补写心理', () => {
    const objective = batch({ observerId: null, perception: '旧脏数据里的主观猜测' });
    const prompt = buildConsolidationPrompt(planFor(objective), objective, '不该采用的姓名');
    expect(prompt).toContain('这一组没有观察者');
    expect(prompt).toContain('客观、中性的第三人称');
    expect(prompt).toContain('只写站得住的事实与承诺');
    expect(prompt).toContain('秦娘把账本收进柜里。');
    expect(prompt).not.toContain('旧脏数据里的主观猜测');
    expect(prompt).not.toContain('不该采用的姓名');
    expect(prompt).not.toContain('用上述观察者的第一人称');
    expect(prompt).not.toContain('替秦娘瞒着账房');
  });

  it.each(FOREIGN_SCOPES)('$label 不能凑阈值或混进同组', ({ overrides }) => {
    const own = batch();
    const foreign = batch(overrides);
    expect(planConsolidation([...own.slice(0, 1), ...foreign.slice(0, 1)], { threshold: 2 })).toEqual([]);
    const groups = planConsolidation([...own, ...foreign], { threshold: 2, batchSize: 2 });
    expect(groups).toHaveLength(2);
    expect(groups[0]?.roomId).toBe(ROOM);
    expect(groups[0]?.memoryIds).toEqual(own.map((item) => item.id));
    expect(groups[1]?.memoryIds).toEqual(foreign.map((item) => item.id));
  });

  it.each(FOREIGN_SCOPES)('即使 memoryIds 错含$label，提示词及产物也整组拒绝，不盖章', ({ overrides }) => {
    const own = batch();
    const foreign = memory({ ...overrides, summary: '外部经过', perception: '外部观感' });
    const group = planFor(own);
    group.memoryIds.push(foreign.id);
    const pool = [...own, foreign];
    const before = structuredClone(pool);
    const prompt = buildConsolidationPrompt(group, pool, '小满');
    expect(prompt).not.toContain('外部经过');
    expect(prompt).not.toContain('外部观感');
    expect(prompt).not.toContain('秦娘把账本收进柜里。');
    const result = applyConsolidation({ group, memories: pool, reply: '不应落库的印象' });
    expect(result.impression).toBeNull();
    expect(result.originals).toEqual([]);
    expect(pool).toEqual(before);
  });

  it('没有对话的客观记忆也不能跨房间合并', () => {
    const own = batch({ observerId: null, conversationId: null });
    const foreign = batch({ observerId: null, conversationId: null, roomId: roomId('room-b') });
    const groups = planConsolidation([...own, ...foreign], { threshold: 2, batchSize: 2 });
    expect(groups).toHaveLength(2);
    expect(groups[0]?.memoryIds).toEqual(own.map((item) => item.id));
    expect(groups[1]?.memoryIds).toEqual(foreign.map((item) => item.id));
    expect(groups.map((group) => group.roomId)).toEqual([ROOM, roomId('room-b')]);
  });

  it('计划已绑定房间时，不能随同 ID 的当前材料漂移到另一个房间', () => {
    const own = batch();
    const group = planFor(own);
    const moved = own.map((item) => ({ ...item, roomId: roomId('room-b') }));
    expect(buildConsolidationPrompt(group, moved)).not.toContain('我以为她在藏证据。');
    const result = applyConsolidation({ group, memories: moved, reply: '不应落库' });
    expect(result.impression).toBeNull();
    expect(result.originals).toEqual([]);
  });

  it('旧调用方未提供 group.roomId 时接受单房间材料，但拒绝含混的跨房间旧组', () => {
    const own = batch();
    const group = planFor(own);
    delete group.roomId;
    expect(buildConsolidationPrompt(group, own)).toContain('我以为她在藏证据。');
    expect(applyConsolidation({ group, memories: own, reply: '我一直怀疑她藏了证据。' }).impression?.roomId).toBe(ROOM);
    const foreign = memory({ roomId: roomId('room-b'), summary: '另一个房间的秘密' });
    const mixed = { ...group, memoryIds: [...group.memoryIds, foreign.id] };
    const pool = [foreign, ...own];
    expect(buildConsolidationPrompt(mixed, pool)).not.toContain('另一个房间的秘密');
    expect(applyConsolidation({ group: mixed, memories: pool, reply: '不应落库' }).originals).toEqual([]);
  });

  it('角色印象沿用 summary + observerId，perception 不重复存同一文本且来源规则不变', () => {
    const turn1 = messageId('turn-1');
    const turn2 = messageId('turn-2');
    const own = [
      memory({ sourceTurnIds: [turn1], perception: '我以为她藏了证据。' }),
      memory({ sourceTurnIds: [turn1, turn2], perception: '我后来仍很怀疑。' }),
    ];
    const group = planFor(own);
    const before = structuredClone(own);
    const text = '我以为秦娘藏了证据，后来一直对她心存怀疑。';
    const result = applyConsolidation({
      group,
      memories: own,
      reply: `\`\`\`text\n${text}\n\`\`\`\n\n不应收录的解释`,
      now: '2026-09-23T00:00:00.000Z',
    });
    expect(result.impression?.summary).toBe(text);
    expect(result.impression?.perception).toBe('');
    expect(result.impression?.observerId).toBe(OBSERVER);
    expect(result.impression?.conversationId).toBe(CONVERSATION);
    expect(result.impression?.roomId).toBe(ROOM);
    expect(result.impression?.sourceTurnIds).toEqual([turn1, turn2]);
    expect(result.impression?.supersedes).toEqual(group.memoryIds);
    expect(result.originals.map((item) => item.perception)).toEqual(own.map((item) => item.perception));
    expect(result.originals.every((item) => item.supersededBy === result.impression?.id)).toBe(true);
    expect(own).toEqual(before);
  });

  it('不改预算消费者：一份正文预算即可召回，现有 assemble 与附件展示均只输出一次', () => {
    const card = createBlankCard({ name: '小满' });
    const { room, instance, scene } = createWorldFromCard(card, createPersona({ name: '玩家' }));
    const own = batch({ roomId: room.id, observerId: instance.id });
    const text = '我以为秦娘藏了证据，但这只是我的猜测。';
    const { impression } = applyConsolidation({ group: planFor(own), memories: own, reply: text });
    if (impression === null) throw new Error('应当产出一条印象');
    expect(impression.summary).toBe(text);
    expect(impression.perception).toBe('');
    const recalled = { event: impression, score: 1, reasons: [] };
    const budget = heuristicTokenCounter.count(text);
    expect(selectWithinBudget([recalled], budget)).toEqual([recalled]);
    expect(selectWithinBudget([recalled], budget - 1)).toEqual([]);
    // 反例守住原消费者仍按 summary + perception 计数，不为本次修复增加特殊去重。
    const duplicated = { ...recalled, event: { ...impression, perception: text } };
    expect(selectWithinBudget([duplicated], budget)).toEqual([]);

    const assembled = assemblePrompt({
      card,
      room,
      instance,
      scene,
      history: [],
      playerInput: '',
      memories: [{ id: impression.id, summary: impression.summary, perception: impression.perception, score: 1 }],
      budget: { maxTokens: 10_000, reserveForReply: 500 },
      options: { systemPrompt: '测试' },
    });
    expect(assembled.blocks.find((block) => block.id === `memory:${impression.id}`)?.content).toBe(text);
    const expansion = renderAttachmentExpansion({
      reason: 'past-question',
      matchedKeywords: [],
      memories: [impression],
      chapters: [],
    });
    expect(expansion).toBe(`【你想起了具体的事】\n- ${text}`);
  });

  it('客观产物的 observerId 仍为 null，perception 仍为空', () => {
    const objective = batch({ observerId: null });
    const result = applyConsolidation({ group: planFor(objective), memories: objective, reply: '秦娘收好了账本。' });
    expect(result.impression?.summary).toBe('秦娘收好了账本。');
    expect(result.impression?.observerId).toBeNull();
    expect(result.impression?.perception).toBe('');
  });

  it.each(['', '这段时间没有值得单独记住的事。'])('角色组无可用印象时不制造 perception（%s）', (reply) => {
    const own = batch();
    const result = applyConsolidation({ group: planFor(own), memories: own, reply, now: AT });
    expect(result.impression).toBeNull();
    expect(result.originals).toHaveLength(2);
    expect(result.originals.every((item) => item.consolidatedAt === AT && item.supersededBy === null)).toBe(true);
    expect(result.originals.map((item) => item.perception)).toEqual(own.map((item) => item.perception));
  });

  it('不重写已合并的老印象，即使旧 perception 为空且重要度很低', () => {
    const own = batch();
    const old = memory({ summary: '老印象原样保留', perception: '', consolidatedAt: AT, importance: 0.1 });
    const pool = [...own, old];
    const before = structuredClone(pool);
    const group = planFor(pool);
    expect(group.memoryIds).not.toContain(old.id);
    const result = applyConsolidation({ group, memories: pool, reply: '我仍然心存怀疑。' });
    expect(result.originals.map((item) => item.id)).not.toContain(old.id);
    expect(result.impression?.supersedes).not.toContain(old.id);
    expect(pool).toEqual(before);
  });
});
