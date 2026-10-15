import { scrub } from './evidence';
import type { Family, QualityFixture } from './types';

export interface QualityManifest {
  baseline: QualityFixture[];
  candidate: QualityFixture[];
  comparison: Array<{ caseId: string; identical: boolean }>;
}
export interface NeutralBackground {
  characters: Array<{ name: string; description: string; personality: string }>;
  worldBooks: Array<{ name: string; entries: Array<{ title: string; content: string }> }>;
  scene: { title: string; location: string; worldTime: string; summary: string } | null;
  player: { name: string; persona: string };
  history: Array<{ speaker: string; content: string }>;
  task: string;
  constraints: string[];
}
export interface BlindSample {
  blindId: string;
  side: 'shared' | 'baseline' | 'candidate';
  repeat: number;
  fixture: QualityFixture;
  background: NeutralBackground;
}
const taskConstraints: Record<Family, string[]> = {
  roleplay: [
    '依据原卡性格与已知经历判断；不替玩家或其他角色决定。',
    '只按共同背景核对记忆，不把猜测当已经发生的事实。',
  ],
  extraction: ['提取客观经过、重要性、地点变化及角色视角；不要添加未发生的事件。'],
  affect: ['依据共同对话判断真正受影响的角色、变化方向和原因，单轮变化幅度上限0.3。'],
  admin: ['完成用户要求并保留未要求删除的已有素材。', '工具仅生成隔离摘要，未写库；评分看任务正确性和完整性。'],
};
export function neutralBackground(manifest: QualityManifest, caseId: string): NeutralBackground {
  const fixture = manifest.baseline.find((item) => item.caseId === caseId);
  if (!fixture) throw Error('missing-common-fixture');
  const related = manifest.baseline.find((item) => item.caseId === `roleplay-${caseId.split('-').at(-1)}`);
  const input = fixture.input ?? {};
  const common = related?.input ?? input;
  const cards = input.cards ?? (common.card ? [common.card] : []);
  const scene = input.scene ?? common.scene;
  return {
    characters: cards.map((card) => ({
      name: card.name,
      description: card.description,
      personality: card.personality,
    })),
    worldBooks: (input.worldBooks ?? []).map((book) => ({
      name: book.name,
      entries: book.entries.map((entry) => ({ title: entry.title, content: entry.content })),
    })),
    scene: scene
      ? { title: scene.title, location: scene.location, worldTime: scene.worldTime, summary: scene.summary }
      : null,
    player: { name: input.playerName ?? common.room?.playerName ?? '', persona: common.room?.playerPersona ?? '' },
    history: (input.history ?? input.messages ?? []).map((message) => ({
      speaker: message.speakerName,
      content: message.content,
    })),
    task:
      input.userInput ??
      input.playerInput ??
      (fixture.family === 'extraction' ? '提取这段共同对话的记忆。' : '推演这段共同对话后的情绪与关系变化。'),
    constraints: taskConstraints[fixture.family],
  };
}
export function makeBlindSamples(
  manifest: QualityManifest,
  random: () => number = () => crypto.getRandomValues(new Uint32Array(1)).at(0) ?? 0,
): BlindSample[] {
  const samples: BlindSample[] = [];
  for (const entry of manifest.comparison) {
    const sides: Array<'baseline' | 'candidate'> = entry.identical ? ['baseline'] : ['baseline', 'candidate'];
    const background = neutralBackground(manifest, entry.caseId);
    for (const side of sides) {
      const fixture = manifest[side].find((item) => item.caseId === entry.caseId);
      if (!fixture) throw Error('missing-side-fixture');
      for (let repeat = 1; repeat <= 2; repeat++)
        samples.push({ blindId: '', side: entry.identical ? 'shared' : side, repeat, fixture, background });
    }
  }
  for (let i = samples.length - 1; i > 0; i--) {
    const j = random() % (i + 1);
    const left = samples[i],
      right = samples[j];
    if (!left || !right) throw Error('invalid-shuffle-index');
    samples[i] = right;
    samples[j] = left;
  }
  return samples.map((sample, i) => ({ ...sample, blindId: `B${String(i + 1).padStart(3, '0')}` }));
}
export function scoreDownload(rows: readonly unknown[], key: string): string {
  return `${rows.map((row) => JSON.stringify(scrub(row, key))).join('\n')}\n`;
}
