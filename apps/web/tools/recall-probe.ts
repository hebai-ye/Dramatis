import { heuristicTokenCounter, type MemoryEvent, recallMemories, selectWithinBudget } from '@dramatis/core';

/**
 * 召回探针（ROADMAP P1-11 的决策工具，开发用页面，不进应用构建）。
 *
 * 打开 `http://127.0.0.1:5273/tools/recall-probe.html` 就会：
 * 1. 从本机库（IndexedDB）里读出**真实的记忆**；
 * 2. 用真实的内核实现（`recallMemories` + `selectWithinBudget`，与线上同一份代码）
 *    跑一批探针问题；
 * 3. 把「该想起来的排第几、有没有进预算、带进来多少噪音」打成表。
 *
 * 它存在的意义：P1-11「向量检索」是有条件才做的——只有当**真实数据**上关键词
 * 确实不够用时才值得上。这个页面就是那份证据的来源，而不是靠感觉。
 */

/** 一条探针：问题 + 该由谁回答 + 期望命中的内容（在本人视角里按关键字找）。 */
interface Probe {
  text: string;
  /** 角色显示名；探针会解析成实例 id。 */
  observer: string;
  /** 期望命中的记忆：在**本人视角**里同时满足这些关键字。 */
  expectAll: string[];
  /** 不该出现的内容（视角隔离的底线）。 */
  forbidAll?: string[];
  note?: string;
}

/**
 * 探针取自第四轮五十回合长跑里真实发生、并被验证过的线索。
 *
 * 这些是「玩家回头问起时，角色应该答得上来」的事；每一条都写明期望命中的关键字，
 * 而不是写死记忆 id——库是活的，重抽、补写都会换 id，但内容该在。
 */
const PROBES: Probe[] = [
  { text: '你船上后艄那截舱板底下，是能藏东西的地方吗？', observer: '陈九', expectAll: ['舱板'] },
  { text: '明早进那院儿，谁先开口问锁？', observer: '陈九', expectAll: ['问锁'] },
  { text: '巷口那半堵新墙是哪一年砌的？', observer: '小满', expectAll: ['墙'] },
  { text: '你先生把那批盖着鹿印的货单怎么处置了？', observer: '小满', expectAll: ['鹿印'] },
  { text: '那本河道旧图去哪了？', observer: '小满', expectAll: ['旧图'] },
  { text: '那三十箱没有清单的货，是谁先提起来的？', observer: '小满', expectAll: ['三十'] },
  {
    text: '我在胡记院里看见的那间上锁小屋，门牌上刻的是什么？',
    observer: '秦娘',
    expectAll: ['门牌'],
    forbidAll: ['门牌'],
    note: '负向：换场之后秦娘不在戏里，门牌的事她不该有记忆',
  },
];

interface EntityRecord {
  collection: string;
  id: string;
  value: unknown;
}

async function readCollection<T>(name: string): Promise<T[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('dramatis', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const records = await new Promise<EntityRecord[]>((resolve, reject) => {
    const tx = db.transaction('entities', 'readonly');
    const all = tx.objectStore('entities').index('byCollection').getAll(name);
    all.onsuccess = () => resolve(all.result as EntityRecord[]);
    all.onerror = () => reject(all.error);
  });

  db.close();
  return records.map((record) => record.value as T);
}

async function main(): Promise<void> {
  const output = document.getElementById('out');
  const write = (text: string): void => {
    if (output) output.textContent = text;
    console.log(text);
  };

  const memories = await readCollection<MemoryEvent>('memories');
  const instances = await readCollection<{ id: string; displayName: string; presence: string }>('instances');
  const nameOf = new Map(instances.map((instance) => [instance.id, instance.displayName]));
  const byName = new Map(instances.map((instance) => [instance.displayName, instance]));
  const onstage = instances.filter((instance) => instance.presence === 'onstage').map((instance) => instance.id);

  const now = new Date().toISOString();
  const counter = heuristicTokenCounter;
  const lines: string[] = [
    `# 召回探针·真实数据`,
    `库里有 ${String(memories.length)} 条记忆、${String(instances.length)} 个角色`,
    '',
    '| 探针 | 该答的人 | 视角内候选 | 命题排名 | 首条命中 | 进预算 | 噪音 | token |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  let hits = 0;
  let top1Hits = 0;
  let inBudget = 0;
  let leaks = 0;
  let noiseTotal = 0;
  let positives = 0;

  for (const probe of PROBES) {
    const instance = byName.get(probe.observer);
    if (!instance) {
      lines.push(`| ${probe.text} | ${probe.observer} | （找不到这个角色） | - | - | - | - |`);
      continue;
    }

    const mine = memories.filter((memory) => memory.observerId === instance.id);
    const expected = mine
      .filter((memory) => probe.expectAll.every((word) => `${memory.summary}${memory.perception}`.includes(word)))
      .map((memory) => memory.id);
    // 注意：禁用词表为空时不能当成「匹配所有」——那会把每一题都误报成串味
    const forbidWords = probe.forbidAll ?? [];
    const forbidden = new Set(
      forbidWords.length === 0
        ? []
        : mine
            .filter((memory) => forbidWords.every((word) => `${memory.summary}${memory.perception}`.includes(word)))
            .map((memory) => memory.id),
    );

    const ranked = recallMemories(memories, {
      observerId: instance.id,
      text: probe.text,
      participantIds: onstage,
      location: '',
      now,
    });
    const selected = selectWithinBudget(ranked, 800, counter);
    const selectedIds = selected.map((item) => item.event.id);

    const firstHit = ranked.findIndex((item) => expected.includes(item.event.id));
    // 排在第一的是不是期望条目：重复提过的线索会命中多条，所以「首条命中」比
    // 「命题里有没有」更接近「模型第一眼看到什么」
    const top1 = ranked[0] === undefined ? false : expected.includes(ranked[0].event.id);
    const inBudgetHit = expected.some((id) => selectedIds.includes(id));
    const leaked = selectedIds.filter((id) => forbidden.has(id));
    const noise = selectedIds.filter((id) => !expected.includes(id) && !forbidden.has(id));
    const tokens = selected.reduce(
      (total, item) => total + counter.count(item.event.summary) + counter.count(item.event.perception),
      0,
    );

    if (probe.expectAll.length > 0) positives += 1;
    if (firstHit >= 0) hits += 1;
    if (top1) top1Hits += 1;
    if (inBudgetHit) inBudget += 1;
    if (leaked.length > 0) leaks += 1;
    noiseTotal += noise.length;

    lines.push(
      `| ${probe.text.slice(0, 16)}… | ${probe.observer} | ${String(mine.length)} | ${
        firstHit < 0 ? '未命中' : `#${String(firstHit + 1)}`
      } | ${top1 ? '✅' : '—'} | ${inBudgetHit ? '✅' : '❌'} | ${String(noise.length)} | ${String(tokens)} |`,
    );
  }

  const denom = positives === 0 ? 1 : positives;
  lines.push(
    '',
    `命题命中 ${String(Math.round((hits / denom) * 100))}% · 首条命中 ${String(Math.round((top1Hits / denom) * 100))}% · 进预算 ${String(Math.round((inBudget / denom) * 100))}% · 串味 ${String(leaks)} 题 · 平均噪音 ${(noiseTotal / PROBES.length).toFixed(1)} 条`,
  );
  lines.push('', `（角色名解析：${[...nameOf.values()].join('、')}）`);

  write(lines.join('\n'));
}

void main();
