import {
  buildMemoryEvents,
  createBlankCard,
  createInstanceFor,
  createPersona,
  createWorldFromCard,
  type InstanceId,
  type Message,
  type MessageId,
  newId,
  planNewConversation,
  Repository,
} from '@dramatis/core';
import { createIndexedDbEntityStore } from '../src/lib/db';

/**
 * 世界种子探针（开发用页面，不进应用构建）。
 *
 * 打开 `http://127.0.0.1:5273/tools/world-seed-probe.html` 就会往**本机库里**种一个
 * 已知规模的世界，用来做界面回归与问题复现：
 *
 * - 三条主线（各自的地点词：货栈 / 河滩 / 胡记院）+ 一条副对话 + 一条已归档的线；
 * - 每条线的每一轮都产出一份记忆（1 条客观 + N 条视角），走**真实的**
 *   `buildMemoryEvents` 与仓储层，形状与线上跑出来的完全一致；
 * - 记忆里带着各自的地点词，所以「记忆面板里出现了哪条线的内容」一眼可辨。
 *
 * 为什么需要它：界面回归要的是「已知规模的数据」，而真模型跑一轮要花钱、还不可复现。
 * 它只新增、不修改已有世界；重复打开会先清掉上一次种的那个世界。
 */

const WORLD_TITLE = '回归世界 · 三条线';
const START = Date.parse('2026-09-18T10:00:00.000Z');
const TURN_MS = 3 * 60 * 1000;

interface Line {
  title: string;
  kind: 'main' | 'side';
  /** 这一条线的地点词，用来在界面上辨认「这条记忆是哪条线的」。 */
  place: string;
  turns: { player: string; reply: string; summary: string; observations: { speaker: string; perception: string }[] }[];
}

const MAI: Line = {
  title: '主线',
  kind: 'main',
  place: '货栈',
  turns: [
    {
      player: '这两天货栈里可还太平？',
      reply: '「太平是太平，就是账房那边灯亮到后半夜。」小满把秤砣归了位，抬眼看了看后院。',
      summary: '玩家在货栈问起近况，小满答账房的灯亮到后半夜。',
      observations: [
        { speaker: '小满', perception: '他第一句就问货栈，说明他心里有事。' },
        { speaker: '秦娘', perception: '账房的事被他先提起来了，得留个心眼。' },
      ],
    },
    {
      player: '账房的灯，是谁在熬夜？',
      reply: '「陈九。」秦娘把茶盏搁下，「他不肯说在算什么。」',
      summary: '秦娘说出熬夜的是陈九，且他不肯说在算什么。',
      observations: [
        { speaker: '秦娘', perception: '替陈九挡了一句，但没说谎。' },
        { speaker: '陈九', perception: '她把我推出来了，看来瞒不住太久。' },
      ],
    },
    {
      player: '把那批没上账的货单拿来我看看。',
      reply: '陈九从袖里抽出一叠纸：「「鹿印」那批的，我没敢记进总账。」',
      summary: '陈九交出盖着鹿印的货单，承认没有记进总账。',
      observations: [
        { speaker: '陈九', perception: '交出去一半，剩下的那半还得再想。' },
        { speaker: '秦娘', perception: '鹿印这三个字一出口，事情就回不去了。' },
      ],
    },
    {
      player: '为什么不上账？',
      reply: '「上头交代的。」陈九的声音低下去，「我只管抄，不管问。」',
      summary: '陈九说漏记账是上头交代的，他只管抄不管问。',
      observations: [
        { speaker: '陈九', perception: '把上头搬出来，至少今夜能过去。' },
        { speaker: '小满', perception: '他说「上头」的时候，眼睛看着货栈后墙。' },
      ],
    },
    {
      player: '货栈后院那堵墙，有什么讲究？',
      reply: '小满顺着墙根走了一圈：「巷口那半堵是新砌的，砖色跟别处不一样。」',
      summary: '小满发现后院巷口有半堵新砌的墙，砖色与别处不同。',
      observations: [
        { speaker: '小满', perception: '新墙下面压着旧砖，像是匆忙赶出来的。' },
        { speaker: '秦娘', perception: '她看得比我细，这丫头留不住。' },
      ],
    },
    {
      player: '新墙是什么时候砌的？',
      reply: '「今年春天。」秦娘答得快，「我记得下过一场大雨。」',
      summary: '秦娘说新墙是今年春天砌的，当时下过一场大雨。',
      observations: [
        { speaker: '秦娘', perception: '答得太快，得补一句雨的事才像真的。' },
        { speaker: '陈九', perception: '春天下雨那天，我不在货栈。' },
      ],
    },
    {
      player: '陈九，那本河道旧图还在你那儿吗？',
      reply: '「在。」陈九没抬头，「压在账册最底下，谁也不借。」',
      summary: '河道旧图还在陈九手上，压在账册最底下。',
      observations: [
        { speaker: '陈九', perception: '旧图的事说出来比藏着安全。' },
        { speaker: '小满', perception: '他把旧图看得比货单重。' },
      ],
    },
    {
      player: '明早进胡记院，谁先开口问锁？',
      reply: '「我去。」陈九这才抬头，「问锁是我的本分。」',
      summary: '陈九主动请缨，明早进胡记院由他先开口问锁。',
      observations: [
        { speaker: '陈九', perception: '问锁这活儿我熟，也能顺便看看门牌。' },
        { speaker: '秦娘', perception: '他抢着去，八成是心里有数。' },
      ],
    },
    {
      player: '那门牌上刻的字，你们谁见过？',
      reply: '秦娘摇头：「我没进过那院。」小满也没作声。',
      summary: '秦娘与小满都没进过胡记院，也没见过门牌。',
      observations: [
        { speaker: '秦娘', perception: '如实说没去过，省得日后对不上。' },
        { speaker: '小满', perception: '他问门牌，可能是想试我们。' },
      ],
    },
    {
      player: '三十箱没有清单的货，是谁先提起来的？',
      reply: '「是我。」小满站出来，「我在船后艄点的数。」',
      summary: '小满承认三十箱无清单的货是她在船后艄点数时发现的。',
      observations: [
        { speaker: '小满', perception: '承认点数的事，但没说箱子里装的是什么。' },
        { speaker: '陈九', perception: '她把话头接过去了，正好。' },
      ],
    },
    {
      player: '船后艄那截舱板底下，是能藏东西的地方吗？',
      reply: '小满笑了一下：「「能藏。」我爹当年就在那儿放私盐。」',
      summary: '小满说船后艄舱板底下能藏东西，她父亲当年在那儿放过私盐。',
      observations: [
        { speaker: '小满', perception: '把爹的事说出来，是想让他知道我不是外人。' },
        { speaker: '秦娘', perception: '连私盐都说了，这丫头是真信他。' },
      ],
    },
    {
      player: '今夜谁守货栈？',
      reply: '「我守。」陈九把灯挑亮了些，「你们睡。」',
      summary: '今夜由陈九守货栈。',
      observations: [
        { speaker: '陈九', perception: '守着账册，也守着那本旧图。' },
        { speaker: '小满', perception: '他今晚不会睡了。' },
      ],
    },
    {
      player: '明早我去哪儿找你们？',
      reply: '「辰时，货栈门口。」秦娘把门闩推上，「过时不候。」',
      summary: '约定辰时在货栈门口集合，过时不候。',
      observations: [
        { speaker: '秦娘', perception: '先把时间定死，省得有人临阵变卦。' },
        { speaker: '陈九', perception: '辰时，正好赶在开门之前。' },
      ],
    },
    {
      player: '那批货单你打算怎么办？',
      reply: '陈九把纸叠好推回来：「「你收着。」我抄的那份，明早烧了。」',
      summary: '陈九把鹿印货单交给玩家保管，打算明早烧掉自己的抄本。',
      observations: [
        { speaker: '陈九', perception: '东西在他手里，出事也是他的事。' },
        { speaker: '秦娘', perception: '烧抄本这个主意，比藏着高明。' },
      ],
    },
  ],
};

const RIVER: Line = {
  title: '河滩旧道',
  kind: 'main',
  place: '河滩',
  turns: [
    {
      player: '这条旧道还走船吗？',
      reply: '小满把竹篙点了点水：「「走，只是过不了大船。」河滩上的泥是新翻的。」',
      summary: '玩家问河滩旧道，小满说还走船但过不了大船，且河边有新翻的泥。',
      observations: [
        { speaker: '小满', perception: '新翻的泥不像船家干的活。' },
        { speaker: '陈九', perception: '有人在夜里动过河滩。' },
      ],
    },
    {
      player: '新翻的泥有多长？',
      reply: '「三丈上下。」小满比了比，「正好是一艘小船靠岸的长度。」',
      summary: '河滩新翻的泥有三丈左右，长度刚好够一艘小船靠岸。',
      observations: [
        { speaker: '小满', perception: '这个长度不是巧合。' },
        { speaker: '秦娘', perception: '三丈，装三十箱刚好。' },
      ],
    },
    {
      player: '夜里谁来过这里？',
      reply: '陈九蹲下抓了把泥：「「不是本地的船。」泥里有股松香味。」',
      summary: '陈九看出夜里来过外地的船，泥里带松香味。',
      observations: [
        { speaker: '陈九', perception: '松香是修船用的，本地的船早就不补了。' },
        { speaker: '小满', perception: '他说得像亲眼见过。' },
      ],
    },
    {
      player: '旧道尽头是哪儿？',
      reply: '「胡记院后墙。」小满答得干脆，「再过去就没路了。」',
      summary: '河滩旧道的尽头是胡记院后墙。',
      observations: [
        { speaker: '小满', perception: '把这条路说出来，等于把胡记院也说了。' },
        { speaker: '陈九', perception: '果然是一条道上的事。' },
      ],
    },
    {
      player: '我们什么时候去河滩看看？',
      reply: '「天亮前。」秦娘在岸上接了话，「天亮就有人看见。」',
      summary: '约定天亮前去河滩查看，避免被人看见。',
      observations: [
        { speaker: '秦娘', perception: '天亮前去，才来得及。' },
        { speaker: '小满', perception: '她比我更急。' },
      ],
    },
    {
      player: '天亮前河滩上有什么？',
      reply: '小满想了想：「「什么都没有。」就几只水鸟。」',
      summary: '天亮前的河滩上只有几只水鸟，没有别的东西。',
      observations: [
        { speaker: '小满', perception: '水鸟都在，说明夜里没人惊动过。' },
        { speaker: '陈九', perception: '那船是前两天来的。' },
      ],
    },
    {
      player: '我们走旧道过去还是绕大路？',
      reply: '「走旧道。」陈九把灯压暗，「大路上有巡夜的。」',
      summary: '决定走旧道去胡记院，因为大路上有巡夜的。',
      observations: [
        { speaker: '陈九', perception: '巡夜的班次我记得，走旧道更稳。' },
        { speaker: '秦娘', perception: '他连巡夜都算进去了，是常走夜路的人。' },
      ],
    },
    {
      player: '到了后墙谁先上？',
      reply: '「我。」小满把绳子缠在手腕上，「我上墙熟。」',
      summary: '小满主动要求先上胡记院后墙。',
      observations: [
        { speaker: '小满', perception: '上墙这事我做得来，别让他们抢。' },
        { speaker: '陈九', perception: '她上墙，我在下面接。' },
      ],
    },
    {
      player: '后墙里面是什么？',
      reply: '「一间上锁的小屋。」小满的声音低下来，「门牌是铜的。」',
      summary: '小满说胡记院后墙里有一间上锁的小屋，门牌是铜的。',
      observations: [
        { speaker: '小满', perception: '门牌我只敢看一眼。' },
        { speaker: '秦娘', perception: '铜门牌，不是寻常人家。' },
      ],
    },
    {
      player: '铜门牌上的字，你看清了吗？',
      reply: '小满摇头：「「字朝里。」看不清。」',
      summary: '铜门牌上的字朝里，小满没看清。',
      observations: [
        { speaker: '小满', perception: '再过一次，我一定看得清。' },
        { speaker: '陈九', perception: '朝里的门牌，是给里面的人看的。' },
      ],
    },
  ],
};

const HUJI: Line = {
  title: '胡记院线',
  kind: 'main',
  place: '胡记院',
  turns: [
    {
      player: '胡记院的门白天开吗？',
      reply: '秦娘摇头：「「不开。」只走侧门。」',
      summary: '胡记院白天正门不开，只走侧门。',
      observations: [
        { speaker: '秦娘', perception: '正门不开的院子，做的是不见光的买卖。' },
        { speaker: '陈九', perception: '侧门对着巷子，进出自如。' },
      ],
    },
    {
      player: '侧门有人守吗？',
      reply: '「有个老头。」陈九比了个高度，「白天睡，晚上也不怎么醒。」',
      summary: '胡记院侧门由一个年老的人看守，白天睡觉。',
      observations: [
        { speaker: '陈九', perception: '老头不重要，重要的是门上的锁。' },
        { speaker: '秦娘', perception: '守门的这么松，里面必有别的看守。' },
      ],
    },
  ],
};

const SIDE: Line = {
  title: '世界管理员',
  kind: 'side',
  place: '',
  turns: [
    {
      player: '帮我把「胡记院」写成一条世界书条目。',
      reply:
        '我先起草一条，你看要不要采纳：\n\n- 名称：胡记院\n- 关键词：胡记院 / 铜门牌\n- 内容：正门不开，只走侧门；后院有一间上锁的小屋，门牌是铜的。',
      summary: '',
      observations: [],
    },
  ],
};

function cardFor(name: string, description: string, scenario: string) {
  return createBlankCard({ name, nickname: name, description, scenario, personality: '寡言，做事先看一步。' });
}

function messageOf(input: {
  roomId: Message['roomId'];
  conversationId: Message['conversationId'];
  sceneId: Message['sceneId'];
  turnId: string;
  role: Message['role'];
  speakerInstanceId: InstanceId | null;
  speakerName: string;
  audience: InstanceId[];
  content: string;
  at: number;
  /** 角色回复带上用量：线上跑出来的每条回复都有，回归数据也得有（菜单里的 Token 那行要看它） */
  usage?: Message['usage'];
}): Message {
  const iso = new Date(input.at).toISOString();
  return {
    id: newId() as MessageId,
    roomId: input.roomId,
    conversationId: input.conversationId,
    sceneId: input.sceneId,
    turnId: input.turnId,
    localSeq: 0,
    deviceId: '',
    role: input.role,
    speakerInstanceId: input.speakerInstanceId,
    speakerName: input.speakerName,
    audience: input.audience,
    content: input.content,
    createdAt: iso,
    updatedAt: iso,
    deletedAt: null,
    ...(input.usage === undefined ? {} : { usage: input.usage }),
  };
}

const out = document.querySelector('#out');
function show(text: string): void {
  if (out !== null) out.textContent = text;
}

async function main(): Promise<void> {
  if (!window.confirm(`往本机库里种一个「${WORLD_TITLE}」？（只新增，不动已有世界）`)) {
    show('已取消。');
    return;
  }

  const { store } = await createIndexedDbEntityStore();
  const repository = new Repository(store);
  // 先跑迁移：否则应用下次打开时会以为这是个「没有 schemaVersion 的老库」，
  // 从头跑一遍 v2…v6，而 v3 会给每个世界**再补一条空的主线对话**（踩过）。
  await repository.migrate();

  // 重复打开时先清掉上一次种的世界，免得越堆越多
  for (const summary of await repository.listRooms()) {
    if (summary.title === WORLD_TITLE) await repository.deleteRoom(summary.id);
  }

  const persona = createPersona({ name: '沈砚', description: '跑码头的行商，说话直接。' });
  await repository.savePersona(persona);

  const cards = [
    cardFor('秦娘', '货栈掌柜，四十上下，管着半个码头的账。', '雨夜，货栈里只剩下三个人。'),
    cardFor('小满', '船家女，十七八岁，眼睛比记性好。', '雨夜，货栈里只剩下三个人。'),
    cardFor('陈九', '账房先生，三十出头，手稳，话少。', '雨夜，货栈里只剩下三个人。'),
  ];
  for (const card of cards) await repository.saveCard(card);

  const start = createWorldFromCard(cards[0]!, persona);
  await repository.saveRoom(start.room);
  await repository.saveConversation(start.conversation);
  await repository.saveScene(start.scene);
  await repository.saveInstance(start.instance);

  // 世界里其余两张卡也实例化（同一个世界共用实例）
  const extra = cards.slice(1).map((card) => createInstanceFor(card, start.room.id));
  for (const instance of extra) await repository.saveInstance(instance);

  const allInstances = [start.instance, ...extra];
  const byName = new Map(allInstances.map((instance) => [instance.displayName, instance]));

  let room = (await repository.getRoom(start.room.id))!;
  room = { ...room, instanceIds: allInstances.map((instance) => instance.id), cardIds: cards.map((card) => card.id) };
  await repository.saveRoom(room);

  const seeded: { title: string; conversations: number; messages: number; memories: number }[] = [];
  let clock = START;
  let sequence = 0;

  // 第一条线直接用世界自带的那条对话
  const lines: Line[] = [MAI, RIVER, SIDE, HUJI];
  const conversations = [start.conversation];

  for (const line of lines.slice(1)) {
    const planned = planNewConversation({
      room,
      existingInstances: allInstances,
      title: line.title,
      kind: line.kind,
      cast: allInstances,
      sceneTitle: line.place === '' ? '起草' : line.place,
      location: line.place,
    });
    await repository.saveRoom(planned.room);
    await repository.saveConversation(planned.conversation);
    await repository.saveScene(planned.scene);
    room = planned.room;
    conversations.push(planned.conversation);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const conversation = conversations[index]!;
    let messages = 0;
    let memories = 0;

    for (const turn of line.turns) {
      const turnId = newId();
      const audience = allInstances.map((instance) => instance.id);
      // 说话人跟着这一轮第一条视角走，读起来与抽取结果对得上
      const speaker = byName.get(turn.observations[0]?.speaker ?? '') ?? allInstances[0]!;
      clock += TURN_MS;
      await repository.appendMessages(room.id, [
        messageOf({
          roomId: room.id,
          conversationId: conversation.id,
          sceneId: conversation.activeSceneId,
          turnId,
          role: 'player',
          speakerInstanceId: null,
          speakerName: persona.name,
          audience,
          content: turn.player,
          at: clock,
        }),
        messageOf({
          roomId: room.id,
          conversationId: conversation.id,
          sceneId: conversation.activeSceneId,
          turnId,
          role: 'character',
          speakerInstanceId: speaker.id,
          speakerName: speaker.displayName,
          audience,
          content: turn.reply,
          at: clock + 1000,
          usage: { promptTokens: 1180 + sequence * 37, completionTokens: 96 + sequence * 11 },
        }),
      ]);
      messages += 2;
      clock += 1000;

      if (turn.summary === '') continue;

      sequence += 1;
      const built = buildMemoryEvents({
        roomId: room.id,
        sceneId: conversation.activeSceneId,
        conversationId: conversation.id,
        worldTime: `第九日·${String(sequence)}`,
        sequence,
        participants: allInstances,
        extraction: {
          summary: turn.summary,
          importance: 0.5,
          location: line.place,
          observations: turn.observations,
        },
        turnId,
        createdAt: new Date(clock).toISOString(),
      });
      await repository.saveMemories(built.events);
      memories += built.events.length;
    }

    if (line.kind === 'main' && line.title === HUJI.title) {
      await repository.archiveConversation(conversation.id);
    }

    seeded.push({ title: line.title, conversations: 1, messages, memories });
  }

  // 世界自带的第一条对话改名为「主线」，与线的定义对齐
  await repository.saveConversation({ ...start.conversation, title: MAI.title });
  await repository.saveRoom({ ...room, title: WORLD_TITLE, activeConversationId: start.conversation.id });

  const total = seeded.reduce(
    (sum, item) => ({
      messages: sum.messages + item.messages,
      memories: sum.memories + item.memories,
    }),
    { messages: 0, memories: 0 },
  );

  show(
    [
      `世界：${WORLD_TITLE}`,
      `角色卡：${cards.map((card) => card.name).join(' / ')}`,
      ...seeded.map((item) => `  ${item.title}：${String(item.messages)} 条消息 / ${String(item.memories)} 条记忆`),
      `合计：${String(total.messages)} 条消息 / ${String(total.memories)} 条记忆`,
      '',
      `worldId=${room.id}`,
      `conversationIds=${conversations.map((item) => item.id).join(',')}`,
    ].join('\n'),
  );
}

void main().catch((error: unknown) => {
  show(`种数据失败：${error instanceof Error ? error.message : String(error)}`);
});
