import { describe, expect, it } from 'vitest';
import { buildMemoryAttachment, withAttachment } from '../memory/attachment.js';
import { type Card, DEFAULT_CARD_SYSTEM_PROMPT } from '../model/card.js';
import { defaultConversationModes, type ReplyLength, replyLengthOf, unlimitedModeOf } from '../model/conversation.js';
import { cardId, eventId, type InstanceId, instanceId, newId, nowIso, PLAYER, roomId, sceneId } from '../model/ids.js';
import { type CharacterInstance, neutralTraits } from '../model/instance.js';
import type { MemoryEvent } from '../model/message.js';
import type { Room, Scene } from '../model/room.js';
import { createCharacterMessage, createPlayerMessage } from '../session/turn.js';
import { assemblePrompt, buildUnlimitedModeBlock, UNLIMITED_BLOCK_ID } from './assemble.js';
import { unlimitedPromptOf } from './unlimited.js';

function fixtures(castPolicy: Scene['castPolicy'] = 'locked') {
  const now = nowIso();
  const roomIdValue = roomId(newId());
  const instanceIdValue = instanceId(newId());
  const sceneIdValue = sceneId(newId());

  const card: Card = {
    id: cardId(newId()),
    name: 'Alice',
    nickname: '',
    description: '酒馆的老板',
    personality: '爽朗健谈',
    scenario: '雨夜的酒馆',
    firstMessage: '欢迎光临。',
    alternateGreetings: [],
    exampleMessages: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creator: '',
    creatorNotes: '',
    characterVersion: '',
    tags: [],
    embeddedWorldBook: null,
    extensions: {},
    source: { kind: 'json', spec: 'chara_card_v2', specVersion: '2.0', importedAt: now },
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  const instance: CharacterInstance = {
    id: instanceIdValue,
    roomId: roomIdValue,
    cardId: card.id,
    displayName: 'Alice',
    presence: 'onstage',
    traits: neutralTraits(),
    affect: { valence: 0.6, arousal: 0.5, updatedAt: now, history: [] },
    relationships: [
      {
        target: PLAYER,
        trust: 0.4,
        affinity: 0.5,
        fear: 0,
        respect: 0.2,
        tension: 0.1,
        updatedAt: now,
        history: [],
      },
    ],
    traitsLocked: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  const scene: Scene = {
    id: sceneIdValue,
    roomId: roomIdValue,
    conversationId: null,
    title: '开场',
    location: '旧城东侧的酒馆',
    worldTime: '第三日 · 黄昏',
    castPolicy,
    cast: [instanceIdValue],
    summary: '',
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    deletedAt: null,
  };

  const room: Room = {
    id: roomIdValue,
    title: '测试房间',
    personaId: null,
    playerName: '旅人',
    playerPersona: '',
    cardIds: [card.id],
    instanceIds: [instanceIdValue],
    worldBookIds: [],
    activeConversationId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  return { card, instance, room, scene };
}

function history(...contents: string[]) {
  const { room, scene } = fixtures();
  return contents.map((content, index) =>
    createPlayerMessage({
      roomId: room.id,
      sceneId: scene.id,
      turnId: `turn-${String(index)}`,
      speakerName: room.playerName,
      content,
    }),
  );
}

function makeInstance(
  room: Room,
  card: Card,
  name: string,
  presence: CharacterInstance['presence'] = 'onstage',
): CharacterInstance {
  const now = nowIso();
  return {
    id: instanceId(newId()),
    roomId: room.id,
    cardId: card.id,
    displayName: name,
    presence,
    traits: neutralTraits(),
    affect: { valence: 0, arousal: 0, updatedAt: now, history: [] },
    relationships: [],
    traitsLocked: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function line(room: Room, scene: Scene, speaker: CharacterInstance, content: string, audience: InstanceId[]) {
  return createCharacterMessage({
    roomId: room.id,
    sceneId: scene.id,
    turnId: 'turn-x',
    speakerInstanceId: speaker.id,
    speakerName: speaker.displayName,
    content,
    audience,
  });
}

function attachmentMemory(instance: CharacterInstance, summary: string): MemoryEvent {
  const now = nowIso();
  return {
    id: eventId(newId()),
    roomId: instance.roomId,
    conversationId: null,
    sceneId: null,
    timeline: { worldTime: '第九日', sequence: 1 },
    location: '货栈',
    participants: [instance.id],
    summary,
    observerId: instance.id,
    perception: '这件事不能让别人知道。',
    importance: 0.7,
    pinned: false,
    importanceLocked: false,
    affects: [],
    sourceTurnIds: ['turn-1'],
    createdAt: now,
    updatedAt: now,
    lastRecalledAt: null,
    recallCount: 0,
    deletedAt: null,
    supersededBy: null,
    supersedes: [],
    consolidatedAt: null,
  };
}
const baseBudget = { maxTokens: 8000, reserveForReply: 1000 };

describe('assemblePrompt', () => {
  it('生成 system + 历史 + 本轮输入的对话结构', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: history('你好'),
      playerInput: '今晚有空吗？',
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });

    expect(prompt.messages[0]?.role).toBe('system');
    expect(prompt.messages.at(-1)).toEqual({ role: 'user', content: '今晚有空吗？' });
    expect(prompt.messages).toHaveLength(3);
  });

  it('把角色卡内容写进 system', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '嗨',
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });

    const system = prompt.messages[0]?.content ?? '';
    expect(system).toContain('酒馆的老板');
    expect(system).toContain('爽朗健谈');
    expect(system).toContain('信任 +0.40');
  });

  it('旧卡空字段实际使用高级系统提示默认值，自定义内容保持原样', () => {
    const { card, instance, room, scene } = fixtures();
    const input = { card, instance, room, scene, history: [], playerInput: '继续', budget: baseBudget };
    const defaultPrompt = assemblePrompt(input);
    expect(defaultPrompt.blocks.find((block) => block.id === 'system')?.content).toBe(DEFAULT_CARD_SYSTEM_PROMPT);

    const customPrompt = assemblePrompt({ ...input, card: { ...card, systemPrompt: '  我自己的规则。\n' } });
    expect(customPrompt.blocks.find((block) => block.id === 'system')?.content).toBe('  我自己的规则。\n');
  });

  it('当前对话的高级系统提示独立装配，不改角色卡默认提示', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '继续',
      modes: { playerFirst: false, silent: false, advancedSystemPrompt: '保持雨夜氛围。' },
      budget: baseBudget,
    });
    expect(prompt.blocks.find((block) => block.id === 'system')?.content).toBe(DEFAULT_CARD_SYSTEM_PROMPT);
    expect(prompt.blocks.find((block) => block.id === 'conversation-system')?.content).toBe('保持雨夜氛围。');
    expect(card.systemPrompt).toBe('');

    const withoutPrompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '继续',
      modes: { playerFirst: false, silent: false, advancedSystemPrompt: '   ' },
      budget: baseBudget,
    });
    expect(withoutPrompt.blocks.some((block) => block.id === 'conversation-system')).toBe(false);
  });

  it('对话级玩家身份覆盖世界上的旧默认身份', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '你好',
      player: { name: '沈砚', description: '旧信的主人' },
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });

    expect(prompt.messages[0]?.content).toContain('「沈砚」');
    expect(prompt.messages.at(-1)).toEqual({ role: 'user', content: '你好' });
  });

  it('锁场时把导演指令写进 prompt', () => {
    const { card, instance, room, scene } = fixtures('locked');
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '嗨',
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });

    expect(prompt.messages[0]?.content).toContain('不得引入任何新角色');
  });

  it('锁场指令随策略变化', () => {
    const { card, instance, room, scene } = fixtures('open');
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '嗨',
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });

    expect(prompt.messages[0]?.content).not.toContain('不得引入任何新角色');
  });

  it('预算不足时仍产出可用 prompt 并记录降级', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: history(...Array.from({ length: 40 }, (_, index) => `第${String(index)}句话`.repeat(20))),
      playerInput: '继续',
      // 估算计入了消息结构开销与 5% 余量（审计 B12），不可丢的那几块需要 600 左右的窗口
      budget: { maxTokens: 2100, reserveForReply: 1500 },
    });

    expect(prompt.report.stages.length).toBeGreaterThan(0);
    expect(prompt.messages.at(-1)?.content).toBe('继续');
    expect(prompt.messages[0]?.role).toBe('system');
    expect(prompt.report.fits).toBe(true);
    expect(prompt.report.compressed).toContain('system');
  });

  it('历史按时间顺序映射成 user / assistant', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: history('第一句', '第二句'),
      playerInput: '第三句',
      budget: { maxTokens: 8000, reserveForReply: 1000 },
    });

    expect(prompt.messages.map((message) => message.role)).toEqual(['system', 'user', 'user', 'user']);
    expect(prompt.messages[1]?.content).toBe('第一句');
  });
});

describe('assemblePrompt / 跨对话记忆附件（顺序 27c）', () => {
  it('日常输入只注入索引，不展开正文', () => {
    const { card, instance, room, scene } = fixtures();
    const memory = attachmentMemory(
      instance,
      '账房的门锁着，里面还有没对完的账，钥匙在柜子第三层，最后一页写着日期和一枚鹿印，门槛下还有一张旧收条。',
    );
    const attachment = buildMemoryAttachment({
      fromConversationId: 'conv-old' as never,
      fromConversationTitle: '主线',
      chapters: [],
      impressions: [{ id: memory.id, summary: memory.summary, importance: memory.importance }],
      extraKeywords: ['账房'],
    });
    const prompt = assemblePrompt({
      card: withAttachment(card, attachment),
      instance,
      room,
      scene,
      history: [],
      playerInput: '今晚喝点什么？',
      attachmentSources: { memories: [memory] },
      budget: baseBudget,
    });
    const system = prompt.messages[0]?.content ?? '';
    expect(system).toContain('跨对话记忆索引');
    expect(system).not.toContain('想起的具体的事');
    expect(system).not.toContain('最后一页写着日期和一枚鹿印');
  });

  it('命中关键词时才展开正文', () => {
    const { card, instance, room, scene } = fixtures();
    const memory = attachmentMemory(
      instance,
      '账房的门锁着，里面还有没对完的账，钥匙在柜子第三层，最后一页写着日期和一枚鹿印，门槛下还有一张旧收条。',
    );
    const attachment = buildMemoryAttachment({
      fromConversationId: 'conv-old' as never,
      fromConversationTitle: '主线',
      chapters: [],
      impressions: [{ id: memory.id, summary: memory.summary, importance: memory.importance }],
      extraKeywords: ['账房'],
    });
    const prompt = assemblePrompt({
      card: withAttachment(card, attachment),
      instance,
      room,
      scene,
      history: [],
      playerInput: '账房那件事后来怎么了？',
      attachmentSources: { memories: [memory] },
      budget: baseBudget,
    });
    const system = prompt.messages[0]?.content ?? '';
    expect(system).toContain('想起的具体的事');
    expect(system).toContain('没对完的账');
  });

  it('问「还记得吗」时也会展开最重要的正文', () => {
    const { card, instance, room, scene } = fixtures();
    const memory = attachmentMemory(instance, '那一夜在货栈把账对上了。');
    const attachment = buildMemoryAttachment({
      fromConversationId: 'conv-old' as never,
      fromConversationTitle: '主线',
      chapters: [],
      impressions: [{ id: memory.id, summary: memory.summary, importance: memory.importance }],
    });
    const prompt = assemblePrompt({
      card: withAttachment(card, attachment),
      instance,
      room,
      scene,
      history: [],
      playerInput: '你还记得吗？',
      attachmentSources: { memories: [memory] },
      budget: baseBudget,
    });
    expect(prompt.messages[0]?.content).toContain('那一夜在货栈把账对上了');
  });
});
describe('assemblePrompt / 记忆的来源（顺序 57）', () => {
  const memories = [
    { id: 'm-recall', summary: '常规想起的一件事。', score: 40 },
    { id: 'm-mention', summary: '被提起才想起的旧事。', score: 30, origin: 'mention' as const },
    { id: 'm-source', summary: '印象里的一件具体的事。', score: 29, origin: 'source' as const },
  ];

  it('三种来源各自有标签与提示语，并按来源统计', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '夹层呢？',
      memories,
      budget: baseBudget,
    });

    expect(prompt.memoryStats).toEqual({ recall: 1, mention: 1, source: 1 });
    expect(prompt.blocks.filter((block) => block.kind === 'memory').map((block) => block.label)).toEqual([
      '相关记忆',
      '提到才想起的旧事',
      '印象背后的原文',
    ]);
    const system = prompt.messages[0]?.content ?? '';
    expect(system).toContain('被提起才想起的旧事。 （旧事，因为被提起才想起）');
    expect(system).toContain('印象里的一件具体的事。 （这是那段印象里的一件具体的事）');
    expect(system).not.toContain('常规想起的一件事。 （');
  });

  it('来源统计只数预算后真正留下来的：分数最低的补充项先被丢', () => {
    const { card, instance, room, scene } = fixtures();
    const input = { card, instance, room, scene, history: [], playerInput: '夹层呢？', memories };
    const reserveForReply = 100;
    const assembleWith = (maxTokens: number) => assemblePrompt({ ...input, budget: { maxTokens, reserveForReply } });

    // 找到「刚好什么都不丢」的最小窗口（估算带结构开销与 5% 余量，审计 B12），再少一个 token
    let fitting = assembleWith(baseBudget.maxTokens).tokenEstimate + reserveForReply;
    while (assembleWith(fitting - 1).report.dropped.length === 0) fitting -= 1;
    while (assembleWith(fitting).report.dropped.length > 0) fitting += 1;
    const squeezed = assembleWith(fitting - 1);

    expect(squeezed.report.stages).toContain('drop-memory');
    expect(squeezed.memoryStats).toEqual({ recall: 1, mention: 1, source: 0 });
    expect(squeezed.messages[0]?.content).not.toContain('印象里的一件具体的事');
  });
});

describe('assemblePrompt / 历史按场记覆盖收起（顺序 58）', () => {
  /** 两场戏：第一场已结束（场记覆盖全部 30 条），第二场是当前场（场记覆盖前 10 条，共 20 条）。 */
  function twoScenes() {
    const base = fixtures();
    const ended: Scene = {
      ...base.scene,
      id: sceneId(newId()),
      title: '码头的黄昏',
      location: '码头',
      recap: '玩家在码头追问铜钥匙的下落，Alice 说钥匙在柜子第三层。',
      endedAt: nowIso(),
    };
    const current: Scene = { ...base.scene, title: '货栈后院', location: '货栈后院', recap: '玩家又问起账本。' };

    const make = (sceneValue: Scene, count: number, startSeq: number, tag: string) =>
      Array.from({ length: count }, (_, index) => {
        const player = index % 2 === 0;
        const seq = startSeq + index;
        return {
          ...(player
            ? createPlayerMessage({
                roomId: base.room.id,
                sceneId: sceneValue.id,
                turnId: `${tag}-${String(Math.floor(index / 2))}`,
                speakerName: base.room.playerName,
                content: seq === 3 ? '那把断了的铜钥匙还在你那儿吗？' : `${tag}玩家第 ${String(seq)} 句`,
                audience: [base.instance.id],
              })
            : createCharacterMessage({
                roomId: base.room.id,
                sceneId: sceneValue.id,
                turnId: `${tag}-${String(Math.floor(index / 2))}`,
                speakerInstanceId: base.instance.id,
                speakerName: 'Alice',
                content: seq === 4 ? '「铜钥匙在柜子第三层。」' : `${tag}角色第 ${String(seq)} 句`,
                audience: [base.instance.id],
              })),
          localSeq: seq,
        };
      });

    const endedLines = make(ended, 30, 1, '甲');
    const currentLines = make(current, 20, 31, '乙');
    const endedWithCursor: Scene = { ...ended, recapUpToMessageId: endedLines[29]?.id ?? null };
    const currentWithCursor: Scene = { ...current, recapUpToMessageId: currentLines[9]?.id ?? null };
    return {
      ...base,
      ended: endedWithCursor,
      current: currentWithCursor,
      history: [...endedLines, ...currentLines],
    };
  }

  it('已被场记覆盖且在近窗外的原文收起；未覆盖的与近窗内的照带', () => {
    const { card, instance, room, ended, current, history } = twoScenes();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene: current,
      scenes: [ended, current],
      history,
      playerInput: '今晚喝点酒？',
      historyPolicy: { mode: 'recap-aware', nearWindow: 8 },
      budget: baseBudget,
    });

    // 50 条可见：第一场 30 条 + 当前场前 10 条被覆盖；近窗 8 条（41–50）；41–50 里 41、42 本就没被覆盖
    expect(prompt.historyStats).toEqual({ total: 50, visible: 50, collapsed: 40, recalled: 0 });
    const historyMessages = prompt.messages.filter((message) => message.role !== 'system').slice(0, -1);
    expect(historyMessages).toHaveLength(10);
    expect(historyMessages[0]?.content).toBe('乙玩家第 41 句');
    // 收起的那段由场记代表：当前场的在场景块里，已结束的在「前几场」里
    const system = prompt.messages[0]?.content ?? '';
    expect(system).toContain('本场已经发生：玩家又问起账本。');
    expect(system).toContain('### 前几场');
    expect(system).toContain('码头的黄昏（码头）：玩家在码头追问铜钥匙的下落');
    expect(system).not.toContain('提到的旧对话原文');
  });

  it('玩家这一句提到收起段里的词，就取回最多三条原文，自成一节', () => {
    const { card, instance, room, ended, current, history } = twoScenes();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene: current,
      scenes: [ended, current],
      history,
      playerInput: '铜钥匙呢？',
      historyPolicy: { mode: 'recap-aware', nearWindow: 8 },
      budget: baseBudget,
    });

    expect(prompt.historyStats.recalled).toBe(2);
    const system = prompt.messages[0]?.content ?? '';
    expect(system).toContain('### 提到的旧对话原文');
    expect(system).toContain('旅人（玩家）：那把断了的铜钥匙还在你那儿吗？');
    expect(system).toContain('Alice：「铜钥匙在柜子第三层。」');
    expect(prompt.blocks.some((block) => block.kind === 'history-recall')).toBe(true);
  });

  it('同一回合第二名角色发言时 playerInput 为空，靠 mention 传玩家这一句', () => {
    const { card, instance, room, ended, current, history } = twoScenes();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene: current,
      scenes: [ended, current],
      history,
      playerInput: '',
      mention: { text: '铜钥匙呢？' },
      historyPolicy: { mode: 'recap-aware', nearWindow: 8 },
      budget: baseBudget,
    });
    expect(prompt.historyStats.recalled).toBe(2);
  });

  it('已进章节的场景不再重复进「前几场」', () => {
    const { card, instance, room, ended, current, history } = twoScenes();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene: current,
      scenes: [ended, current],
      history,
      playerInput: '继续',
      chapters: [
        {
          id: 'chapter-1',
          roomId: room.id,
          conversationId: null,
          title: '第一章',
          sceneIds: [ended.id],
          summary: '码头那一段。',
          keyFacts: [],
          createdAt: nowIso(),
          updatedAt: nowIso(),
          deletedAt: null,
        },
      ],
      budget: baseBudget,
    });
    const system = prompt.messages[0]?.content ?? '';
    expect(system).toContain('前情提要');
    expect(system).not.toContain('### 前几场');
  });

  it('full 模式原文全带，与老行为一致；缺省策略是 recap-aware / 40', () => {
    const { card, instance, room, ended, current, history } = twoScenes();
    const full = assemblePrompt({
      card,
      instance,
      room,
      scene: current,
      scenes: [ended, current],
      history,
      playerInput: '继续',
      modes: { playerFirst: false, silent: false, historyMode: 'full' },
      budget: baseBudget,
    });
    expect(full.historyStats).toEqual({ total: 50, visible: 50, collapsed: 0, recalled: 0 });

    const defaults = assemblePrompt({
      card,
      instance,
      room,
      scene: current,
      scenes: [ended, current],
      history,
      playerInput: '继续',
      budget: baseBudget,
    });
    // 50 条里被覆盖 40 条，近窗 40 条保住其中 30 条：只收起最早的 10 条
    expect(defaults.historyStats).toEqual({ total: 50, visible: 50, collapsed: 10, recalled: 0 });
  });
});

describe('assemblePrompt / 多角色场景', () => {
  it('自定义卡提示仍保留玩家身份与本轮边界', () => {
    const { card, instance, room, scene } = fixtures();
    const bob = makeInstance(room, card, 'Bob');
    card.systemPrompt = '你可以随意续写整场戏。';
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      cast: [instance, bob],
      player: { name: '旅人', description: '独自寻找失踪的兄长。' },
      history: [],
      playerInput: '你见过他吗？',
      budget: baseBudget,
    });
    const system = prompt.messages[0]?.content ?? '';
    expect(system).toContain('玩家「旅人」的身份设定：独自寻找失踪的兄长。');
    expect(system).toContain('未知设定先问，不编造既定事实');
    expect(system).toContain('只写本角色这一轮的简短回应');
    expect(system).toContain('不要替他们发言');
  });

  it('极长玩家身份保留开头关键信息，但不把不可丢指令撑成全文', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      player: { name: '旅人', description: `正在寻找兄长。${'补充身世。'.repeat(200)}` },
      history: [],
      playerInput: '走吧',
      budget: baseBudget,
    });
    const instruction = prompt.blocks.find((block) => block.id === 'instruction')?.content ?? '';
    expect(instruction).toContain('正在寻找兄长。');
    expect(instruction).toContain('……');
    expect(instruction).not.toContain('补充身世。'.repeat(100));
  });

  it('场景块带上自动整理的本场场记（P1-5 的场景层）', () => {
    const { card, instance, room, scene } = fixtures();
    const withRecap: Scene = {
      ...scene,
      summary: '雨夜的酒馆',
      recap: '玩家问起三十箱货，Alice 没有正面回答。\n要点：三十箱货在船舱夹层',
      recapUpToSeq: 12,
    };

    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene: withRecap,
      history: [],
      playerInput: '继续',
      budget: baseBudget,
    });

    const system = prompt.messages[0]?.content ?? '';
    // 人写的简介与自动场记是两件事，各占一行
    expect(system).toContain('场景摘要：雨夜的酒馆');
    expect(system).toContain('本场已经发生：玩家问起三十箱货，Alice 没有正面回答。');
    expect(system).toContain('要点：三十箱货在船舱夹层');
  });

  it('章节摘要进「前情提要」块，更早的只报条数', () => {
    const { card, instance, room, scene } = fixtures();
    const chapter = (index: number) => ({
      id: `chapter-${String(index)}`,
      roomId: room.id,
      conversationId: null,
      title: `第 ${String(index)} 章 · 旧城`,
      sceneIds: [],
      summary: `第 ${String(index)} 章的经过。`,
      keyFacts: [`第 ${String(index)} 章的要点`],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deletedAt: null,
    });

    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '继续',
      chapters: [chapter(1), chapter(2), chapter(3), chapter(4), chapter(5)],
      budget: baseBudget,
    });

    const system = prompt.messages[0]?.content ?? '';
    expect(system).toContain('前情提要');
    // 只带最近三章：太久的只报个数，不占预算
    expect(system).toContain('更早还有 2 章（略）');
    expect(system).toContain('第 5 章的经过。');
    expect(system).not.toContain('第 1 章的经过。');
    expect(prompt.blocks.some((block) => block.id === 'chapter')).toBe(true);
  });

  it('场景块列出在场角色与各自的状态', () => {
    const { card, instance, room, scene } = fixtures();
    const bob = makeInstance(room, card, 'Bob', 'muted');

    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      cast: [instance, bob],
      history: [],
      playerInput: '你们好',
      budget: baseBudget,
    });

    const system = prompt.messages[0]?.content ?? '';
    expect(system).toContain('在场角色：');
    expect(system).toContain('Alice（正在与你对话）');
    expect(system).toContain('Bob（在场但一直没说话）');
  });

  it('多人同场时历史消息标出说话人，单人时不标', () => {
    const { card, instance, room, scene } = fixtures();
    const bob = makeInstance(room, card, 'Bob');
    const said = line(room, scene, bob, '今晚的雨真大', [instance.id, bob.id]);

    const group = assemblePrompt({
      card,
      instance,
      room,
      scene,
      cast: [instance, bob],
      history: [said],
      playerInput: '是啊',
      budget: baseBudget,
    });
    // 历史是独立的对话消息，不在 system 里
    const groupText = group.messages.map((message) => message.content).join('\n');
    // 用【名字】而不是「名字：」标记说话人：后者会被模型当成范本照抄，
    // 真实模型验证里它甚至抄成了别人的名字
    expect(groupText).toContain('【Bob】今晚的雨真大');

    const solo = assemblePrompt({
      card,
      instance,
      room,
      scene,
      cast: [instance],
      history: [said],
      playerInput: '是啊',
      budget: baseBudget,
    });
    const soloText = solo.messages.map((message) => message.content).join('\n');
    expect(soloText).toContain('今晚的雨真大');
    expect(soloText).not.toContain('【Bob】');
  });

  it('指令提醒不要替其他在场角色发言', () => {
    const { card, instance, room, scene } = fixtures();
    const bob = makeInstance(room, card, 'Bob');

    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      cast: [instance, bob],
      history: [],
      playerInput: '你们好',
      budget: baseBudget,
    });

    expect(prompt.messages[0]?.content).toContain('不要替他们发言');
    expect(prompt.messages[0]?.content).toContain('Bob');
  });

  it('同一回合的第二名角色不重复插入玩家输入', () => {
    const { card, instance, room, scene } = fixtures();
    const bob = makeInstance(room, card, 'Bob');
    const playerLine = createPlayerMessage({
      roomId: room.id,
      sceneId: scene.id,
      turnId: 'turn-x',
      speakerName: room.playerName,
      content: '你们好',
      audience: [instance.id, bob.id],
    });
    const aliceReply = line(room, scene, instance, '欢迎光临', [instance.id, bob.id]);

    const prompt = assemblePrompt({
      card,
      instance: bob,
      room,
      scene,
      cast: [instance, bob],
      history: [playerLine, aliceReply],
      playerInput: '',
      budget: baseBudget,
    });

    const messages = prompt.messages;
    expect(messages.at(-1)?.content).toBe('【Alice】欢迎光临');
    expect(messages.filter((message) => message.content === '你们好')).toHaveLength(1);
  });

  it('按视角裁掉不在场时的历史', () => {
    const { card, instance, room, scene } = fixtures();
    const bob = makeInstance(room, card, 'Bob');

    const prompt = assemblePrompt({
      card,
      instance: bob,
      room,
      scene,
      cast: [instance, bob],
      history: [
        line(room, scene, instance, '只有 Alice 在场时说的', [instance.id]),
        line(room, scene, instance, '两人都在时说的', [instance.id, bob.id]),
      ],
      playerInput: '继续',
      budget: baseBudget,
    });

    const rendered = prompt.messages.map((message) => message.content).join('\n');
    expect(rendered).toContain('两人都在时说的');
    expect(rendered).not.toContain('只有 Alice 在场时说的');
    expect(prompt.historyStats).toEqual({ total: 2, visible: 1, collapsed: 0, recalled: 0 });
  });

  it('会话级模式会落成 prompt 里的指令，而不只是界面上的开关', () => {
    const { card, instance, room, scene } = fixtures();

    const plain = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '你还在吗',
      budget: baseBudget,
    });
    expect(plain.messages[0]?.content).not.toContain('静默');

    const silent = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '你还在吗',
      modes: { playerFirst: true, silent: true },
      budget: baseBudget,
    });
    const system = silent.messages[0]?.content ?? '';

    expect(system).toContain('只有玩家先开口');
    expect(system).toContain('静默');
    // 静默模式下连动作的写法也要交代清楚，否则模型会干脆什么都不输出
    expect(system).toContain('`#`');
  });

  it('多人同场时交代清楚「名字前缀只是给你看的标记」', () => {
    const { card, instance, room, scene } = fixtures();
    const bob = makeInstance(room, card, 'Bob');

    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      cast: [instance, bob],
      history: [],
      playerInput: '你们谁先说',
      budget: baseBudget,
    });
    const system = prompt.messages[0]?.content ?? '';

    // 历史里的 assistant 消息带「名字：」前缀；真实模型会照抄这个格式，
    // 甚至写成别人的名字（DeepSeek 网页版端到端测试里就是这样），所以要明说
    expect(system).toContain('不要在回复开头写任何角色名');
    expect(system).toContain('那是他的回合');
  });
});

/**
 * 顺序 67e：回答长度与反重复。
 *
 * 来历是 2026-09-25 的 178 轮真实模型长跑（EVAL 第六十八节）：回复从 171 字
 * 涨到 325 字，自称名字从 0.9 次涨到 5.6 次。用户裁定「动作可以连着做几个
 * 不同的，但不许同一个动作重复」，并要求给用户一个长度档位。
 */
describe('回答长度与反重复（顺序 67e）', () => {
  it('缺省是标准档；认不出的值也退回标准', () => {
    expect(replyLengthOf(undefined)).toBe('normal');
    expect(replyLengthOf({ playerFirst: false, silent: false })).toBe('normal');
    expect(replyLengthOf({ playerFirst: false, silent: false, replyLength: 'short' })).toBe('short');
    expect(replyLengthOf({ playerFirst: false, silent: false, replyLength: 'long' })).toBe('long');
    expect(replyLengthOf({ playerFirst: false, silent: false, replyLength: 'huge' as unknown as ReplyLength })).toBe(
      'normal',
    );
  });

  it('新对话的缺省模式里就带着标准档', () => {
    expect(defaultConversationModes().replyLength).toBe('normal');
  });

  it('三档各自只出现自己那条规矩', () => {
    const { card, instance, room, scene } = fixtures();
    const styleOf = (replyLength: ReplyLength) =>
      assemblePrompt({
        card,
        instance,
        room,
        scene,
        history: [],
        playerInput: '继续',
        modes: { playerFirst: false, silent: false, replyLength },
        budget: baseBudget,
      }).blocks.find((block) => block.id === 'reply-style')?.content ?? '';

    const short = styleOf('short');
    const normal = styleOf('normal');
    const long = styleOf('long');

    expect(short).toContain('回答长度（偏短）');
    expect(short).not.toContain('回答长度（标准）');
    expect(normal).toContain('回答长度（标准）');
    expect(long).toContain('回答长度（偏长）');
    expect(long).not.toContain('回答长度（标准）');
  });

  it('反重复规矩每一档都在，且允许连续做多个不同动作', () => {
    const { card, instance, room, scene } = fixtures();
    const style =
      assemblePrompt({
        card,
        instance,
        room,
        scene,
        history: [],
        playerInput: '继续',
        budget: baseBudget,
      }).blocks.find((block) => block.id === 'reply-style')?.content ?? '';

    expect(style).toContain('可以连着做几个不同的动作');
    expect(style).toContain('不要用你自己的名字当主语');
    expect(style).toContain('已经答过的事不要复述');
    expect(style).toContain('回答长度（标准）');
  });

  it('这一块进了 system 提示，缺省档也写进正文', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '继续',
      budget: baseBudget,
    });

    const system = prompt.messages[0]?.content ?? '';
    expect(system).toContain('可以连着做几个不同的动作');
    expect(system).toContain('回答长度（标准）');
  });
});

/**
 * 无限制模式（2026-09-25，用户点名）。
 *
 * 它把原「高级系统提示 · 当前对话」输入框换成了一个开关。正文**不是仓库里的常量**：
 * 网页是公开托管的静态站点，写进代码就等于编译进公开可下载的 JS，所以正文一律当
 * 用户数据，由调用方通过 `AssembleInput.unlimitedPrompt` 传进来。
 *
 * 这一组测试就是钉住这条契约：正文从参数来、空正文不加块、开关关着不加块。
 */
describe('无限制模式（2026-09-25）', () => {
  it('缺省关：老数据里没有这个字段，不需要迁移', () => {
    expect(unlimitedModeOf(undefined)).toBe(false);
    expect(unlimitedModeOf({ playerFirst: false, silent: false })).toBe(false);
    expect(unlimitedModeOf({ playerFirst: false, silent: false, unlimited: false })).toBe(false);
    expect(unlimitedModeOf({ playerFirst: false, silent: false, unlimited: true })).toBe(true);
    expect(defaultConversationModes().unlimited).toBe(false);
  });

  it('正文为空时不给块——空块比没有块更糟', () => {
    expect(unlimitedPromptOf('')).toBeNull();
    expect(unlimitedPromptOf('   \n  ')).toBeNull();
    expect(unlimitedPromptOf(undefined)).toBeNull();
    expect(unlimitedPromptOf(null)).toBeNull();
    expect(unlimitedPromptOf('  保持克制。 ')).toBe('保持克制。');
    expect(buildUnlimitedModeBlock(null)).toBeNull();
  });

  it('拿到正文时：不可丢弃、与角色卡系统提示同一档优先级', () => {
    const block = buildUnlimitedModeBlock('这一轮的额外要求。');
    expect(block).not.toBeNull();
    expect(block?.id).toBe(UNLIMITED_BLOCK_ID);
    expect(block?.content).toBe('这一轮的额外要求。');
    // 用户自己打开的开关，预算一紧就悄悄不加等于骗人
    expect(block?.droppable).toBe(false);
    expect(block?.kind).toBe('system');
  });

  it('打开开关 + 传了正文：整块进 system 提示', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '继续',
      modes: { playerFirst: false, silent: false, unlimited: true },
      unlimitedPrompt: '这一轮按这个要求写。',
      budget: baseBudget,
    });

    expect(prompt.blocks.find((candidate) => candidate.id === UNLIMITED_BLOCK_ID)?.content).toBe(
      '这一轮按这个要求写。',
    );
    expect(prompt.messages[0]?.content).toContain('这一轮按这个要求写。');
  });

  it('开关打开但没传正文：什么都不加（正文来自用户数据，缺省就是没有）', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '继续',
      modes: { playerFirst: false, silent: false, unlimited: true },
      budget: baseBudget,
    });
    expect(prompt.blocks.some((candidate) => candidate.id === UNLIMITED_BLOCK_ID)).toBe(false);
  });

  it('开关关着时，就算传了正文也不加块', () => {
    const { card, instance, room, scene } = fixtures();
    const withoutMode = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '继续',
      modes: { playerFirst: false, silent: false },
      unlimitedPrompt: '这一轮按这个要求写。',
      budget: baseBudget,
    });
    expect(withoutMode.blocks.some((candidate) => candidate.id === UNLIMITED_BLOCK_ID)).toBe(false);
  });

  it('旧版高级系统提示照旧装配——一次界面重构不该让用户写过的要求失效', () => {
    const { card, instance, room, scene } = fixtures();
    const prompt = assemblePrompt({
      card,
      instance,
      room,
      scene,
      history: [],
      playerInput: '继续',
      modes: { playerFirst: false, silent: false, advancedSystemPrompt: '保持雨夜氛围。' },
      budget: baseBudget,
    });
    const legacy = prompt.blocks.find((candidate) => candidate.id === 'conversation-system');
    expect(legacy?.content).toBe('保持雨夜氛围。');
    // 界面上不再有编辑入口，所以标签要能认出来是旧字段
    expect(legacy?.label).toContain('旧');
  });
});
