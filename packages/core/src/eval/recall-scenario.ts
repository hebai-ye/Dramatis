import { conversationId, eventId, type InstanceId, instanceId, roomId, sceneId } from '../model/ids.js';
import type { MemoryEvent } from '../model/message.js';
import type { RecallDataset } from './recall-eval.js';

/**
 * 召回评测的题库（P1-11 的决策依据）。
 *
 * 素材取自第四轮五十回合长跑里真实出现过、并且后来**被验证过**的线索：
 * 三十箱没有清单的货、陈九船上的夹层、巷口那半堵新墙、秦娘赊出去的那壶酒、
 * 小满的先生烧掉的那批鹿印货单、胡记上锁小屋的门牌……这些是「该想起来」的。
 *
 * 两题是**负向的**：秦娘在换场之后就不在戏里了，门牌上的鹿印她不该知道——
 * 召回如果把她不该有的东西端出来，那是视角隔离出了问题，比漏一条严重得多。
 */

const OBSERVED = '2026-09-17T20:00:00.000Z';

/**
 * 三个角色的稳定 id：题库要可复现，所以不用随机 id，直接用可读的短名。
 * 探针里写的 `qin` / `man` / `chen` 就是这三个值，两边对得上。
 */
const CAST = [instanceId('qin'), instanceId('man'), instanceId('chen')] as const;

function memory(input: {
  id: string;
  summary: string;
  observerId: 'qin' | 'man' | 'chen' | null;
  perception?: string;
  importance?: number;
  location?: string;
  participants?: readonly InstanceId[];
  createdAt?: string;
  recallCount?: number;
}): MemoryEvent {
  return {
    id: eventId(input.id),
    roomId: roomId('room-oldcity'),
    conversationId: conversationId('conv-main'),
    sceneId: sceneId('scene-oldcity'),
    timeline: { worldTime: '第三日 · 深夜', sequence: 1 },
    location: input.location ?? '西岸河滩',
    participants: [...(input.participants ?? CAST)],
    summary: input.summary,
    observerId: input.observerId === null ? null : instanceId(input.observerId),
    perception: input.perception ?? '',
    importance: input.importance ?? 0.6,
    pinned: false,
    importanceLocked: false,
    affects: [],
    sourceTurnIds: ['turn-1'],
    createdAt: input.createdAt ?? OBSERVED,
    updatedAt: input.createdAt ?? OBSERVED,
    lastRecalledAt: null,
    recallCount: input.recallCount ?? 0,
  };
}

/** 同一条事实在三个人眼里各是什么样——这是本项目与「一个角色的多个分身」的分界。 */
const MEMORIES: MemoryEvent[] = [
  memory({
    id: 'obj-thirty-crates',
    observerId: null,
    summary: '玩家提起一批三十箱没有清单的货，货从胡记货栈经西岸过河。',
    importance: 0.8,
  }),
  memory({
    id: 'qin-thirty-crates',
    observerId: 'qin',
    summary: '玩家问起三十箱没有清单的货。秦娘说货是胡记的，她只管酒钱，不管货。',
    perception: '他不像来喝酒的，倒像来查账的。三十箱这个数他张口就来，说明早有耳闻。',
    importance: 0.7,
  }),
  memory({
    id: 'man-thirty-crates',
    observerId: 'man',
    summary: '小满说先生收旧书时听过一句话：有些货过河是不记账的。',
    perception: '说出口就后悔了——这话本不该对外人讲。',
    importance: 0.75,
  }),
  memory({
    id: 'chen-thirty-crates',
    observerId: 'chen',
    summary: '陈九说三十箱这个数头一回是玩家自己在酒馆提的，他只是接话。',
    perception: '他先说的三十箱，回头倒像是来问我的。这账得记清，别落到我头上。',
    importance: 0.6,
  }),
  memory({
    id: 'chen-cabin',
    observerId: 'chen',
    summary: '陈九说跑船的都在后艄舱板底下留夹层，能塞两个麻包，外头看不出来。',
    perception: '话一出口就有点后悔——这夹层要是被拿去用，出了事船就是他的。',
    importance: 0.7,
  }),
  memory({
    id: 'qin-wine-debt',
    observerId: 'qin',
    summary: '秦娘把一壶酒赊给玩家，说人回来酒再温；玩家说若回不来就记在账上。',
    perception: '赊酒是小事，他要真回不来，这壶酒我记给谁看。',
    importance: 0.65,
  }),
  memory({
    id: 'chen-promise',
    observerId: 'chen',
    summary: '陈九答应陪玩家去胡记，条件写明：进院后头一个开口问锁的必须是玩家，他只站到门口。',
    perception: '陪到门口可以，名分不能含糊——问锁、撬锁都得是他自己开口。',
    importance: 0.8,
  }),
  memory({
    id: 'man-wall',
    observerId: 'man',
    summary: '小满说巷口那半堵新墙是前年砌的，顶上砖还是松的；上个月又去过，墙没拆也没补完。',
    perception: '我记得比他们清楚，可我不想显得记得这么清楚。',
    importance: 0.7,
  }),
  memory({
    id: 'qin-wall',
    observerId: 'qin',
    summary: '秦娘说那堵墙砌一半，说明是后来才想堵的；要看货栈藏没藏东西，得从河滩那侧过去。',
    perception: '小满记得那堵墙，这比她说出口的话有用。',
    importance: 0.7,
  }),
  memory({
    id: 'man-burned-list',
    observerId: 'man',
    summary: '小满说先生收过一批盖着断角鹿印的货单，看过一晚，第二天叫她一张不剩地烧了。',
    perception: '那摞纸是我一张一张放进火盆的，印角被火吃掉的样子我一直记得。',
    importance: 0.85,
  }),
  memory({
    id: 'man-old-map',
    observerId: 'man',
    summary: '小满说那本河道旧图去年冬天被一个收旧图的买走了；画图的第人后来也来问过，来晚了。',
    perception: '买图的人和画图的人前后脚来问，这事我一直觉得不对。',
    importance: 0.7,
  }),
  memory({
    id: 'chen-door',
    observerId: 'chen',
    summary: '玩家说胡记院里有一间上锁的小屋，门牌上刻着一只断了角的鹿；陈九说他卸过货，没见过那间屋。',
    perception: '断角的鹿——这记号要是别处也有人见过，就不是我们两个能捂住的事。',
    importance: 0.85,
  }),
  memory({
    id: 'man-inner-court',
    observerId: 'man',
    summary: '小满说她只在檐下站着，没进院，也没看见院里发生了什么。',
    perception: '我一句都没敢往前挪，可被问了三遍，倒像是我藏了什么。',
    importance: 0.5,
  }),
  memory({
    id: 'qin-farewell',
    observerId: 'qin',
    summary: '秦娘留在店里看店，让小满跟着去；她说店里三个人吃饭，天不亮就得生火。',
    perception: '我走了这店谁看。让他们去，我守着灯。',
    importance: 0.55,
  }),
];

export const RECALL_SCENARIO: RecallDataset = {
  name: '旧城长跑线索（P1-11 题库）',
  memories: MEMORIES,
  probes: [
    {
      id: 'p-cabin',
      text: '你船上有没有能藏东西的地方？后艄那截舱板底下我看不见。',
      observerId: 'chen',
      expectIds: ['chen-cabin'],
      participantIds: ['chen', 'man'],
    },
    {
      id: 'p-promise',
      text: '明早进那院儿之前，我们先把话说清：谁开口问锁？',
      observerId: 'chen',
      expectIds: ['chen-promise'],
      participantIds: ['chen', 'man'],
    },
    {
      id: 'p-crates',
      text: '那三十箱货到底是哪来的，账上怎么没有？',
      observerId: 'man',
      expectIds: ['man-thirty-crates'],
      participantIds: ['chen', 'man'],
    },
    {
      id: 'p-wall',
      text: '巷口那半堵新墙，是哪一年砌的？顶上的砖还在吗？',
      observerId: 'man',
      expectIds: ['man-wall'],
      participantIds: ['chen', 'man'],
      location: '西岸河滩',
    },
    {
      id: 'p-map',
      text: '你先生那本河道旧图去哪了？去年冬天有人来问过吗？',
      observerId: 'man',
      expectIds: ['man-old-map'],
      participantIds: ['chen', 'man'],
    },
    {
      id: 'p-wine',
      text: '我这壶酒是赊的还是现付的？要是回不来，这账怎么算？',
      observerId: 'qin',
      expectIds: ['qin-wine-debt'],
      participantIds: ['qin'],
      location: '旧城酒馆',
    },
    {
      id: 'p-burned-list',
      text: '那批盖着鹿印的货单，你先生后来怎么处置的？',
      observerId: 'man',
      expectIds: ['man-burned-list'],
      participantIds: ['chen', 'man'],
    },
    // 负向：秦娘在换场之后就不在戏里了，门牌上的鹿印她不该知道
    {
      id: 'n-qin-door',
      text: '你在胡记院里看见的那间上锁小屋，门牌上刻的是什么？',
      observerId: 'qin',
      expectIds: [],
      forbidIds: ['chen-door'],
      participantIds: ['qin'],
      location: '旧城酒馆',
    },
    // 负向：小满没进院，院里的事她不该有记忆
    {
      id: 'n-man-door',
      text: '院里那间上锁小屋的门牌，你还记得上面刻着什么吗？',
      observerId: 'man',
      expectIds: [],
      forbidIds: ['chen-door'],
      participantIds: ['chen', 'man'],
    },
  ],
};
