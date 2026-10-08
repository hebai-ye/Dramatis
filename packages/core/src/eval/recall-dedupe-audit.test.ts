import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_DEDUPE_THRESHOLD,
  DEFAULT_FALLBACK_LIMIT,
  dedupeRecalled,
  limitFallbackItems,
  recallForPrompt,
  recallMemories,
  selectWithinBudget,
  textSimilarity,
} from '../memory/recall.js';
import { eventId } from '../model/ids.js';
import { createMemoryEntityStore } from '../platform/memory-store.js';
import { COLLECTIONS, Repository } from '../storage/repository.js';
import { heuristicTokenCounter } from '../token/estimate.js';
import {
  auditMemoryTokens,
  createRecallDedupeAuditScenarios,
  evaluateRecallDedupeScenario,
  formatRecallDedupeAudit,
  type RecallDedupeAuditReport,
  type RecallDedupeScenario,
  runRecallDedupeAudit,
} from './recall-dedupe-audit.js';

const fixtures = createRecallDedupeAuditScenarios();
let report: RecallDedupeAuditReport;

function row(id: string) {
  const result = report.results.find((item) => item.input.id === id);
  if (!result) throw new Error(`Missing audit row: ${id}`);
  return result;
}

function customScenario(texts: string[], labels?: string[][]): RecallDedupeScenario {
  const template = createRecallDedupeAuditScenarios()[0];
  const example = template?.memories[0];
  if (!template || !example) throw new Error('Missing synthetic fixture template.');
  return {
    ...template,
    id: 'audit-test-only',
    query: { ...template.query, text: '' },
    memories: texts.map((summary, index) => ({
      event: {
        ...structuredClone(example.event),
        id: eventId(`b12-custom-${index}`),
        summary,
        perception: '',
        importance: 1 - index * 0.1,
      },
      factIds: labels?.[index] ?? [`custom-fact-${index}`],
    })),
  };
}

beforeAll(async () => {
  report = await runRecallDedupeAudit();
});

// Explicit opt-in only. Ordinary core/root test runs do not write report files.
// Fixed URLs cannot select a user database or write outside the two authorized artifact names.
afterAll(async () => {
  const runtime = (globalThis as unknown as { process?: { env: Record<string, string | undefined>; version: string } })
    .process;
  if (runtime?.env.DRAMATIS_RECALL_DEDUPE_AUDIT_REPORT !== '1' || report === undefined) return;
  // Report-only Node ports stay local: core deliberately has no Node ambient types or new dependency.
  const cryptoModule = 'node:crypto';
  const fsModule = 'node:fs/promises';
  const { createHash } = (await import(/* @vite-ignore */ cryptoModule)) as {
    createHash(algorithm: 'sha256'): { update(bytes: Uint8Array): { digest(encoding: 'hex'): string } };
  };
  const { readFile, writeFile } = (await import(/* @vite-ignore */ fsModule)) as {
    readFile(path: URL): Promise<Uint8Array>;
    writeFile(path: URL, data: string, encoding: 'utf8'): Promise<void>;
  };
  const root = new URL('../../../../', import.meta.url);
  const files = [
    'packages/core/src/eval/recall-dedupe-audit.ts',
    'packages/core/src/eval/recall-dedupe-audit.test.ts',
    'packages/core/src/memory/recall.ts',
    'packages/core/src/token/estimate.ts',
    'packages/core/src/storage/repository.ts',
    'packages/core/src/platform/memory-store.ts',
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(new URL(file, root)))
          .digest('hex'),
      ]),
    ),
  );
  await writeFile(
    new URL('build/task-120/recall-dedupe-audit-results.json', root),
    `${JSON.stringify(
      {
        environment: { node: runtime.version, syntheticOnly: true, noModelCalls: true },
        sourceHashes,
        report,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    new URL('build/task-120/recall-dedupe-audit-results.txt', root),
    formatRecallDedupeAudit(report),
    'utf8',
  );
});

describe('B12 audit: real production baseline and fair offline-only candidate', () => {
  it.each(fixtures)(
    '$id reuses production selection, defaults, time, pool and budget without changing input',
    async (fixture) => {
      const before = structuredClone(fixture);
      const store = createMemoryEntityStore();
      await store.bulkPut(
        COLLECTIONS.memories,
        fixture.memories.map((item) => item.event),
      );
      const repository = new Repository(store);
      const pool = await repository.listMemories(fixture.roomId, { conversationId: fixture.conversationId });
      const poolBefore = structuredClone(pool);
      const baseline = recallForPrompt(pool, fixture.query, {
        budgetTokens: fixture.budgetTokens,
        counter: heuristicTokenCounter,
        mentionText: fixture.query.text,
      });
      const ranked = limitFallbackItems(recallMemories(pool, fixture.query));
      const deduped = dedupeRecalled(ranked);
      const candidate = selectWithinBudget(deduped, fixture.budgetTokens, heuristicTokenCounter);
      const result = row(fixture.id);
      expect(result.input).toEqual(before);
      expect(result.baselineMatchesUndedupedRegularPath).toBe(true);
      expect(baseline.candidates.mention).toBe(0);
      expect(baseline.candidates.source).toBe(0);
      expect(result.baseline.selectedIds).toEqual(baseline.selected.map((item) => item.event.id));
      expect(result.candidate.selectedIds).toEqual(candidate.map((item) => item.event.id));
      expect(result.beforeBudget.baselineIds).toEqual(ranked.map((item) => item.event.id));
      expect(result.beforeBudget.candidateIds).toEqual(deduped.map((item) => item.event.id));
      for (const [measured, selected] of [
        [result.baseline, baseline.selected],
        [result.candidate, candidate],
      ] as const) {
        const tokens = selected.reduce(
          (sum, item) =>
            sum + heuristicTokenCounter.count(item.event.summary) + heuristicTokenCounter.count(item.event.perception),
          0,
        );
        expect(measured.estimatedTokens).toBe(tokens);
        expect(tokens).toBeLessThanOrEqual(fixture.budgetTokens);
        expect(
          selected.every(
            (item) =>
              item.event.observerId === fixture.query.observerId &&
              item.event.roomId === fixture.roomId &&
              item.event.conversationId === fixture.conversationId &&
              item.event.deletedAt === null,
          ),
        ).toBe(true);
      }
      expect(result.delta.estimatedTokens).toBe(result.candidate.estimatedTokens - result.baseline.estimatedTokens);
      expect(pool).toEqual(poolBefore);
      expect(await repository.listMemories(fixture.roomId, { conversationId: fixture.conversationId })).toEqual(
        poolBefore,
      );
      expect(fixture).toEqual(before);
    },
  );

  it('records the actual defaults and is deterministic on a second run', async () => {
    expect(report.method.counter).toBe(heuristicTokenCounter.name);
    expect(report.method.dedupeThreshold).toBe(DEFAULT_DEDUPE_THRESHOLD);
    expect(report.method.fallbackLimit).toBe(DEFAULT_FALLBACK_LIMIT);
    expect(await runRecallDedupeAudit()).toEqual(report);
  });

  it('snapshots input before awaiting instead of allowing one arm to observe changed inputs', async () => {
    const input = customScenario(['alpha beta', 'quartz violin']);
    const before = structuredClone(input);
    const pending = evaluateRecallDedupeScenario(input);
    input.budgetTokens = 0;
    input.query.observerId = 'not-the-original-observer';
    input.memories[0]?.factIds.push('mutated-oracle');
    const result = await pending;
    expect(result.input).toEqual(before);
    expect(result.baseline.selectedCount).toBe(2);
    expect(result.candidate.selectedCount).toBe(2);
  });

  it('human labels affect only oracle metrics, never ranking, dedupe, or token selection', async () => {
    const original = row('near-with-key-fact');
    const relabeled = structuredClone(original.input);
    relabeled.memories.forEach((item, index) => {
      item.factIds = [`invented-label-${index}`];
    });
    const result = await evaluateRecallDedupeScenario(relabeled);
    expect(result.beforeBudget).toEqual(original.beforeBudget);
    for (const arm of ['baseline', 'candidate'] as const) {
      expect(result[arm].selectedIds).toEqual(original[arm].selectedIds);
      expect(result[arm].estimatedTokens).toBe(original[arm].estimatedTokens);
    }
    expect(result.availableFactIds).not.toEqual(original.availableFactIds);
  });
});

describe('B12 audit: measured fixture outcomes, not inferred production gains', () => {
  it('all-unique remains identical with no algorithm-removable budget', () => {
    const result = row('all-unique');
    expect(result.baseline).toEqual(result.candidate);
    expect(result.baseline.selectedCount).toBe(6);
    expect(result.baseline.duplicateGroupItemShare).toBe(0);
    expect(result.baseline.algorithmRemovableEstimatedTokens).toBe(0);
    expect(result.baseline.retainedUniqueFactIds).toHaveLength(6);
  });

  it('exact copies use selected-count/token denominators and keep both individually supported facts', () => {
    const result = row('exact-duplicates');
    const first = result.input.memories[0];
    if (!first) throw new Error('Missing exact fixture.');
    expect(result.baseline.selectedCount).toBe(12);
    expect(result.candidate.selectedCount).toBe(3);
    expect(result.baseline.duplicateGroups).toHaveLength(1);
    expect(result.baseline.duplicateGroupMemberCount).toBe(10);
    expect(result.baseline.duplicateGroupItemShare).toBe(10 / 12);
    expect(result.baseline.algorithmRemovableCount).toBe(9);
    expect(result.baseline.algorithmRemovableEstimatedTokens).toBe(9 * auditMemoryTokens(first.event));
    expect(result.baseline.algorithmRemovableTokenShare).toBe(
      result.baseline.algorithmRemovableEstimatedTokens / result.baseline.estimatedTokens,
    );
    expect(result.availableFactIds).toHaveLength(3);
    expect(result.availableUniqueFactIds).toEqual(['ferry-tuesday', 'medicine-cold']);
    expect(result.candidate.uniqueFactRetention).toBe(1);
    expect(result.candidate.duplicateGroups).toEqual([]);
  });

  it('near-duplicate removal can lose a labeled key fact even while reclaiming tokens', () => {
    const result = row('near-with-key-fact');
    const first = result.input.memories[0];
    const critical = result.input.memories.find((item) => item.factIds.includes('emergency-code'));
    if (!first || !critical) throw new Error('Missing critical fixture.');
    expect(first.event.summary).not.toBe(critical.event.summary);
    expect(textSimilarity(first.event.summary, critical.event.summary)).toBeGreaterThanOrEqual(
      DEFAULT_DEDUPE_THRESHOLD,
    );
    expect(result.baseline.selectedCount).toBe(12);
    expect(result.candidate.selectedCount).toBe(3);
    expect(result.baseline.uniqueFactRetention).toBe(1);
    expect(result.candidate.uniqueFactRetention).toBe(2 / 3);
    expect(result.delta.lostUniqueFactIds).toEqual(['emergency-code']);
    expect(result.candidate.missingFactIds).toContain('emergency-code');
    expect(result.baseline.algorithmRemovableEstimatedTokens).toBeGreaterThan(0);
  });

  it('under a deliberately scarce budget, removed copies can make room for two fixture facts', () => {
    const result = row('scarce-budget');
    expect(result.baseline.selectedCount).toBe(3);
    expect(result.candidate.selectedCount).toBe(3);
    expect(result.availableUniqueFactIds).toHaveLength(2);
    expect(result.baseline.retainedUniqueFactIds).toEqual([]);
    expect(result.candidate.uniqueFactRetention).toBe(1);
    expect(result.delta.gainedUniqueFactIds).toEqual(['ferry-tuesday', 'medicine-cold']);
    expect(result.candidate.estimatedTokens).toBeLessThan(result.baseline.estimatedTokens);
  });

  it.each(['scope-a', 'scope-b'])(
    '%s keeps foreign/private/deleted records out of both arms and denominators',
    (id) => {
      const result = row(id);
      expect(result.input.memories).toHaveLength(9);
      expect(result.repositoryPoolIds).toHaveLength(6);
      expect(result.repositoryPoolIds).not.toContain('b12-foreign-room');
      expect(result.repositoryPoolIds).not.toContain('b12-foreign-conversation');
      expect(result.repositoryPoolIds).not.toContain('b12-tombstone');
      const expectedPrefix = id === 'scope-a' ? 'a-' : 'b-';
      expect(result.availableFactIds.every((fact) => fact.startsWith(expectedPrefix))).toBe(true);
      expect(result.baseline.uniqueFactRetention).toBe(1);
      expect(result.candidate.uniqueFactRetention).toBe(1);
      for (const arm of [result.baseline, result.candidate]) {
        expect(arm.selectedIds.every((selected) => selected.startsWith(`b12-${expectedPrefix}`))).toBe(true);
        expect(arm.retainedFactIds).not.toContain('objective-only');
      }
    },
  );

  it('same raw input does not dedupe across observers or share their fact denominators', () => {
    const a = row('scope-a');
    const b = row('scope-b');
    expect(a.input.memories).toEqual(b.input.memories);
    expect(a.input.budgetTokens).toBe(b.input.budgetTokens);
    expect(a.input.query.now).toBe(b.input.query.now);
    expect(a.observerVisibleIds).toHaveLength(3);
    expect(b.observerVisibleIds).toHaveLength(2);
    expect(a.availableUniqueFactIds).toHaveLength(1);
    expect(b.availableUniqueFactIds).toHaveLength(2);
    expect(a.candidate.selectedCount).toBe(2);
    expect(b.candidate.selectedCount).toBe(2);
  });
});

describe('B12 audit: empty sets, applicability, and non-transitive greedy grouping', () => {
  it('empty pool is unmeasured, not a fabricated zero-percent fact score', () => {
    const result = row('empty');
    for (const arm of [result.baseline, result.candidate]) {
      expect(arm.selectedCount).toBe(0);
      expect(arm.estimatedTokens).toBe(0);
      expect(arm.duplicateGroupItemShare).toBeNull();
      expect(arm.algorithmRemovableTokenShare).toBeNull();
      expect(arm.labeledFactRetention).toBeNull();
      expect(arm.uniqueFactRetention).toBeNull();
    }
  });

  it('zero budget with available facts has zero retention, not an empty fact denominator', () => {
    const result = row('zero-budget');
    expect(result.availableUniqueFactIds).toHaveLength(2);
    for (const arm of [result.baseline, result.candidate]) {
      expect(arm.selectedCount).toBe(0);
      expect(arm.estimatedTokens).toBe(0);
      expect(arm.uniqueFactRetention).toBe(0);
      expect(arm.labeledFactRetention).toBe(0);
      expect(arm.duplicateGroupItemShare).toBeNull();
      expect(arm.algorithmRemovableTokenShare).toBeNull();
    }
  });

  it('nonempty zero-token entries keep separate item/token/fact denominators', async () => {
    const input = customScenario(['', ''], [['synthetic-label'], ['synthetic-label']]);
    input.budgetTokens = 0;
    const result = await evaluateRecallDedupeScenario(input);
    expect(result.baseline.selectedCount).toBe(2);
    expect(result.baseline.estimatedTokens).toBe(0);
    expect(result.baseline.duplicateGroupItemShare).toBe(0);
    expect(result.baseline.algorithmRemovableTokenShare).toBeNull();
    expect(result.baseline.labeledFactRetention).toBe(1);
    expect(result.baseline.uniqueFactRetention).toBeNull();
    expect(result.candidate).toEqual(result.baseline);
  });

  it('unlabeled inputs are not assigned fabricated semantic facts', async () => {
    const input = customScenario(['alpha beta', 'violet quartz'], [[], []]);
    const result = await evaluateRecallDedupeScenario(input);
    expect(result.baseline.selectedCount).toBe(2);
    expect(result.availableFactIds).toEqual([]);
    expect(result.baseline.labeledFactRetention).toBeNull();
    expect(result.candidate.uniqueFactRetention).toBeNull();
  });

  it('keeps the real fallback cap instead of increasing it to make the candidate look better', async () => {
    const input = customScenario(['beacon', 'kiwi mango', 'quartz cello', 'silver rabbit', 'mauve violin']);
    input.query.text = 'beacon';
    const result = await evaluateRecallDedupeScenario(input);
    expect(result.beforeBudget.baselineIds).toHaveLength(1 + DEFAULT_FALLBACK_LIMIT);
    expect(result.baseline.selectedCount).toBe(1 + DEFAULT_FALLBACK_LIMIT);
    expect(result.candidate).toEqual(result.baseline);
    expect(result.availableUniqueFactIds).toHaveLength(5);
  });

  it('explains greedy retained representatives without inventing transitive duplicate clusters', async () => {
    const result = await evaluateRecallDedupeScenario(customScenario(['alpha beta', 'alpha beta gamma', 'beta gamma']));
    expect(result.baseline.duplicateGroups).toEqual([
      {
        representativeId: 'b12-custom-0',
        memberIds: ['b12-custom-0', 'b12-custom-1'],
        removableIds: ['b12-custom-1'],
        removableEstimatedTokens: heuristicTokenCounter.count('alpha beta gamma'),
      },
    ]);
    expect(result.baseline.duplicateGroupItemShare).toBe(2 / 3);
    expect(result.candidate.selectedIds).toEqual(['b12-custom-0', 'b12-custom-2']);
    expect(result.delta.lostUniqueFactIds).toEqual(['custom-fact-1']);
  });

  it.each(['supersededBy', 'supersedes'] as const)(
    'explicitly refuses %s provenance instead of copying the production reservation algorithm',
    async (field) => {
      const input = customScenario(['beacon']);
      const first = input.memories[0];
      if (!first) throw new Error('Missing test input.');
      if (field === 'supersededBy') first.event.supersededBy = eventId('impression');
      else first.event.supersedes = [eventId('source')];
      await expect(evaluateRecallDedupeScenario(input)).rejects.toThrow('Supplement/source chains');
    },
  );

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid audit budget %s', async (budgetTokens) => {
    const input = customScenario(['beacon']);
    input.budgetTokens = budgetTokens;
    await expect(evaluateRecallDedupeScenario(input)).rejects.toThrow('nonnegative safe integer');
  });

  it('requires an explicit valid evaluation time', async () => {
    const input = customScenario(['beacon']);
    input.query.now = 'invalid';
    await expect(evaluateRecallDedupeScenario(input)).rejects.toThrow('query.now');
  });

  it('rejects duplicate fixture IDs rather than silently overwriting records in the fixture store', async () => {
    const input = customScenario(['beacon']);
    input.memories.push(structuredClone(input.memories[0] as NonNullable<(typeof input.memories)[0]>));
    await expect(evaluateRecallDedupeScenario(input)).rejects.toThrow('Duplicate fixture record ID');
  });

  it('does not double-count the same oracle label repeated within one record', async () => {
    const input = customScenario(['beacon'], [['same', 'same']]);
    await expect(evaluateRecallDedupeScenario(input)).rejects.toThrow('unique within one record');
  });

  it('formats null denominators honestly and carries synthetic-only, provenance and safety limits', () => {
    const text = formatRecallDedupeAudit(report);
    expect(text).toContain('\n| 场景 |');
    expect(text).toContain('不适用(0/0)');
    expect(text).toContain('不等于安全回收');
    expect(text).toContain('真实语义评判');
    expect(text).toContain('独立预留预算');
    expect(text).not.toMatch(/NaN|Infinity/);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
