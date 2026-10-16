import { describe, expect, it } from 'vitest';
import { makeCases } from './fixtures';
import { makeBlindSamples, type QualityManifest, scoreDownload } from './presentation';
import type { QualityFixture } from './types';

describe('blind scoring shared task context', () => {
  it('shows personality/history/task and ignores changed candidate inputs and side prompts', () => {
    const baseline: QualityFixture[] = makeCases();
    const candidate = structuredClone(baseline);
    for (const fixture of baseline) fixture.request.messages = [{ role: 'system', content: 'BASELINE-PRIVATE-PROMPT' }];
    for (const fixture of candidate)
      fixture.request.messages = [{ role: 'system', content: 'CANDIDATE-PRIVATE-PROMPT' }];
    const changed = candidate.find((fixture) => fixture.caseId === 'admin-3');
    if (changed?.input?.cards)
      changed.input.cards = changed.input.cards.map((card) => ({ ...card, name: 'CANDIDATE-PRIVATE-NAME' }));
    const manifest: QualityManifest = {
      baseline,
      candidate,
      comparison: baseline.map((f) => ({ caseId: f.caseId, identical: false })),
    };
    const samples = makeBlindSamples(manifest, () => 0);
    const sides = samples.filter((s) => s.fixture.caseId === 'roleplay-1' && s.repeat === 1);
    expect(sides).toHaveLength(2);
    expect(sides[0]?.background).toEqual(sides[1]?.background);
    expect(JSON.stringify(sides[0]?.background)).toContain('话少');
    expect(JSON.stringify(sides[0]?.background)).toContain('别问信里写了什么');
    expect(JSON.stringify(sides[0]?.background)).toContain('北门是谁看见他们的');
    expect(JSON.stringify(samples.map((s) => s.background))).not.toMatch(/PRIVATE|git-blob|working-tree/);
    const admins = samples.filter((s) => s.fixture.caseId === 'admin-3');
    expect(JSON.stringify(admins[0]?.background)).toContain('把当前场景地点改为旧城北门');
  });
  it('exports scoring background/evidence without exposing side labels or secrets', () => {
    const line = scoreDownload(
      [
        {
          blindId: 'B001',
          background: { task: '保留旧设定' },
          evidence: 'FAKE-SECRET good',
          assessor: 'tester',
          rubric: { personality: 'N/A' },
        },
      ],
      'FAKE-SECRET',
    );
    const parsed = JSON.parse(line);
    expect(parsed.background.task).toBe('保留旧设定');
    expect(parsed.evidence).toBe('[REDACTED] good');
    expect(parsed.rubric.personality).toBe('N/A');
    expect(parsed.side).toBeUndefined();
  });
  it('exports execution and upstream provenance without leaking key or private chain', () => {
    const parsed = JSON.parse(
      scoreDownload(
        [
          {
            blindId: 'B-example',
            rounds: [
              {
                executionProfile: {
                  profileId: 'deepseek-flash-low-output-4096-v1',
                  maxOutputTokens: 4096,
                  model: 'deepseek-flash',
                  reasoningEffort: 'low',
                },
                wireHash: 'a'.repeat(64),
                upstreamWireHash: 'b'.repeat(64),
                wire: { messages: [{ role: 'assistant', content: 'FAKE-SECRET reply', reasoning_content: 'PRIVATE' }] },
              },
            ],
          },
        ],
        'FAKE-SECRET',
      ),
    );
    expect(parsed.rounds[0].executionProfile.maxOutputTokens).toBe(4096);
    expect(parsed.rounds[0].wireHash).toBe('a'.repeat(64));
    expect(parsed.rounds[0].upstreamWireHash).toBe('b'.repeat(64));
    expect(JSON.stringify(parsed)).not.toMatch(/FAKE-SECRET|PRIVATE|reasoning_content/);
  });
});
