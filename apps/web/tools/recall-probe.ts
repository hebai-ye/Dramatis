import {
  heuristicTokenCounter,
  limitFallbackItems,
  type MemoryEvent,
  type RecalledMemory,
  recallMemories,
  selectWithinBudget,
  textSimilarity,
} from '@dramatis/core';

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

/** 一轮评测的汇总数字。 */
interface Metrics {
  hits: number;
  top1: number;
  inBudget: number;
  leaks: number;
  noise: number;
  tokens: number;
  positives: number;
  /** 进预算的条目里，有多少条是「命中关键词」进来的（其余靠重要度/时效兜底）。 */
  keywordItems: number;
  /** 同一题里两条选中条目之间的最高相似度（判断噪音是不是近重复）。 */
  maxPairSimilarity: number;
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

  /**
   * 跑一遍全部探针。`limit` 为 null 表示不限制兜底条目。
   *
   * 这一步放在**预算裁剪之前**：省下来的额度才能让给别的东西——若放在之后，
   * 预算早就被占满，限制只是让最终条数变少。
   */
  const run = (limit: number | null): { metrics: Metrics; rows: string[] } => {
    const metrics: Metrics = {
      hits: 0,
      top1: 0,
      inBudget: 0,
      leaks: 0,
      noise: 0,
      tokens: 0,
      positives: 0,
      keywordItems: 0,
      maxPairSimilarity: 0,
    };
    const rows: string[] = [];

    for (const probe of PROBES) {
      const instance = byName.get(probe.observer);
      if (!instance) {
        rows.push(`| ${probe.text} | ${probe.observer} | （找不到这个角色） | - | - | - | - |`);
        continue;
      }

      const mine = memories.filter((memory) => memory.observerId === instance.id);
      const expected = mine
        .filter((memory) => probe.expectAll.every((word) => searchable(memory).includes(word)))
        .map((memory) => memory.id);
      // 注意：禁用词表为空时不能当成「匹配所有」——那会把每一题都误报成串味
      const forbidWords = probe.forbidAll ?? [];
      const forbidden = new Set(
        forbidWords.length === 0
          ? []
          : mine
              .filter((memory) => forbidWords.every((word) => searchable(memory).includes(word)))
              .map((memory) => memory.id),
      );

      const ranked = recallMemories(memories, {
        observerId: instance.id,
        text: probe.text,
        participantIds: onstage,
        location: '',
        now,
      });
      const candidates: RecalledMemory[] = limit === null ? ranked : limitFallbackItems(ranked, limit);
      const selected = selectWithinBudget(candidates, 800, counter);
      const selectedIds = selected.map((item) => item.event.id);

      const firstHit = candidates.findIndex((item) => expected.includes(item.event.id));
      // 排在第一的是不是期望条目：重复提过的线索会命中多条，所以「首条命中」比
      // 「命题里有没有」更接近「模型第一眼看到什么」
      const top1 = candidates[0] === undefined ? false : expected.includes(candidates[0].event.id);
      const inBudgetHit = expected.some((id) => selectedIds.includes(id));
      const leaked = selectedIds.filter((id) => forbidden.has(id));
      const noise = selectedIds.filter((id) => !expected.includes(id) && !forbidden.has(id));
      const tokens = selected.reduce(
        (total, item) => total + counter.count(item.event.summary) + counter.count(item.event.perception),
        0,
      );

      if (probe.expectAll.length > 0) metrics.positives += 1;
      if (firstHit >= 0) metrics.hits += 1;
      if (top1) metrics.top1 += 1;
      if (inBudgetHit) metrics.inBudget += 1;
      if (leaked.length > 0) metrics.leaks += 1;
      metrics.noise += noise.length;
      metrics.tokens += tokens;
      metrics.keywordItems += selected.filter((item) =>
        item.reasons.some((reason) => reason.code === 'keyword'),
      ).length;

      // 同一题里选中条目之间的最高相似度：如果噪音是「同一件事换个说法」，
      // 这个数会很高，去重才有意义；不高就说明噪音是别的东西。
      for (let left = 0; left < selected.length; left += 1) {
        for (let right = left + 1; right < selected.length; right += 1) {
          const a = selected[left];
          const b = selected[right];
          if (!a || !b) continue;
          const similarity = textSimilarity(
            `${a.event.summary} ${a.event.perception}`,
            `${b.event.summary} ${b.event.perception}`,
          );
          if (similarity > metrics.maxPairSimilarity) metrics.maxPairSimilarity = similarity;
        }
      }

      rows.push(
        `| ${probe.text.slice(0, 16)}… | ${probe.observer} | ${String(mine.length)} | ${
          firstHit < 0 ? '未命中' : `#${String(firstHit + 1)}`
        } | ${top1 ? '✅' : '—'} | ${inBudgetHit ? '✅' : '❌'} | ${String(noise.length)} | ${String(tokens)} |`,
      );
    }

    return { metrics, rows };
  };

  const percent = (value: number, total: number): string =>
    `${String(Math.round((value / (total === 0 ? 1 : total)) * 100))}%`;

  const lines: string[] = [
    '# 召回探针·真实数据',
    `库里有 ${String(memories.length)} 条记忆、${String(instances.length)} 个角色（${[...nameOf.values()].join('、')}）`,
    '',
    '## 策略扫描（T22 兜底条目上限）',
    '',
    '| 兜底上限 | 命题命中 | 首条命中 | 进预算 | 串味 | 平均噪音 | 关键词条目 | 选中项最高相似度 | 平均 token |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const limit of [null, 6, 4, 3, 2, 1, 0]) {
    const { metrics } = run(limit);
    lines.push(
      `| ${limit === null ? '不限' : `≤${String(limit)}`} | ${percent(metrics.hits, metrics.positives)} | ${percent(
        metrics.top1,
        metrics.positives,
      )} | ${percent(metrics.inBudget, metrics.positives)} | ${String(metrics.leaks)} | ${(
        metrics.noise / PROBES.length
      ).toFixed(1)} | ${(metrics.keywordItems / PROBES.length).toFixed(1)} | ${(
        metrics.maxPairSimilarity / PROBES.length
      ).toFixed(2)} | ${String(Math.round(metrics.tokens / PROBES.length))} |`,
    );
  }

  const chosen = new URLSearchParams(location.search).get('fallback');
  const chosenLimit = chosen === null ? null : Number(chosen);
  const detail = run(chosenLimit);
  lines.push(
    '',
    `## 逐题（兜底上限 ${chosenLimit === null ? '不限' : `≤${String(chosenLimit)}`}）`,
    '',
    '| 探针 | 该答的人 | 视角内候选 | 命题排名 | 首条命中 | 进预算 | 噪音 | token |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...detail.rows,
  );

  write(lines.join('\n'));
}

/** 探针关键字在这条记忆里找：摘要 + 观感。 */
function searchable(memory: MemoryEvent): string {
  return `${memory.summary}${memory.perception}`;
}

void main();
