import { describe, expect, it } from 'vitest';
import { eventId, instanceId, roomId, sceneId } from '../model/ids.js';
import type { MemoryEvent } from '../model/message.js';
import { evaluateRecall, formatRecallReport, type RecallProbe } from './recall-eval.js';

const memory: MemoryEvent = {
  id: eventId('recall-metric-fixture'),
  roomId: roomId('recall-metric-room'),
  conversationId: null,
  sceneId: sceneId('recall-metric-scene'),
  timeline: { worldTime: '', sequence: 1 },
  location: '',
  participants: [],
  summary: '铜铃',
  observerId: instanceId('recall-metric-observer'),
  perception: '记得',
  importance: 1,
  pinned: false,
  importanceLocked: false,
  affects: [],
  sourceTurnIds: [],
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
  lastRecalledAt: null,
  recallCount: 0,
  deletedAt: null,
};

function probe(id: string, expectIds: readonly string[], forbidIds: readonly string[] = []): RecallProbe {
  return { id, text: '铜铃', observerId: 'recall-metric-observer', expectIds, forbidIds };
}

const options = { counter: { name: 'fixture-length', count: (text: string) => text.length }, fallbackLimit: null };

describe('召回评测的分母与空集（A14）', () => {
  it('命中率只计正向题，串味、噪音与token按全部题目平均', () => {
    const report = evaluateRecall(
      {
        name: 'mixed',
        memories: [memory],
        probes: [
          probe('positive', [memory.id]),
          probe('forbidden-1', [], [memory.id]),
          probe('forbidden-2', [], [memory.id]),
          probe('noise', []),
        ],
      },
      options,
    );
    expect(report.probeCount).toBe(4);
    expect(report.positiveProbeCount).toBe(1);
    expect(report.hitRate).toBe(1);
    expect(report.inBudgetRate).toBe(1);
    expect(report.leakRate).toBe(0.5);
    expect(report.noisePerProbe).toBe(0.25);
    expect(report.tokensPerProbe).toBe(4);
  });

  it('全负向题的命中率未测，不冒充0%，其余指标仍可测', () => {
    const report = evaluateRecall(
      { name: 'negative-only', memories: [memory], probes: [probe('forbidden', [], [memory.id]), probe('noise', [])] },
      options,
    );
    expect(report.positiveProbeCount).toBe(0);
    expect(report.hitRate).toBeNull();
    expect(report.inBudgetRate).toBeNull();
    expect(report.leakRate).toBe(0.5);
    expect(report.noisePerProbe).toBe(0.5);
    expect(report.tokensPerProbe).toBe(4);
    const text = formatRecallReport(report);
    expect(text).toContain('命中 未测');
    expect(text).toContain('进预算 未测');
    expect(text).toContain('串味 50%');
    expect(text).toContain('不适用');
  });

  it('零题目所有汇总均未测，序列化和展示不产生NaN或伪造分母', () => {
    const report = evaluateRecall({ name: 'empty', memories: [memory], probes: [] }, options);
    expect(report.probeCount).toBe(0);
    expect(report.positiveProbeCount).toBe(0);
    for (const key of ['hitRate', 'inBudgetRate', 'leakRate', 'noisePerProbe', 'tokensPerProbe'] as const) {
      expect(report[key]).toBeNull();
      expect(JSON.parse(JSON.stringify(report))[key]).toBeNull();
    }
    const text = formatRecallReport(report);
    expect(text).toContain('探针 0 题（正向 0 题）');
    expect(text).not.toMatch(/NaN|Infinity|0%/);
  });

  it('确实测过但没有命中的正向题仍为0，不与未测混淆', () => {
    const report = evaluateRecall({ name: 'miss', memories: [], probes: [probe('positive', ['absent'])] }, options);
    expect(report.hitRate).toBe(0);
    expect(report.inBudgetRate).toBe(0);
    expect(report.leakRate).toBe(0);
    expect(report.noisePerProbe).toBe(0);
    expect(report.tokensPerProbe).toBe(0);
    expect(formatRecallReport(report)).toContain('命中 0%');
  });

  it('增加负向题不会稀释正向题的命中率', () => {
    const report = evaluateRecall(
      {
        name: 'positive-miss-with-negatives',
        memories: [memory],
        probes: [probe('hit', [memory.id]), probe('miss', ['absent']), probe('negative', [], [memory.id])],
      },
      options,
    );
    expect(report.hitRate).toBe(0.5);
    expect(report.inBudgetRate).toBe(0.5);
    expect(report.leakRate).toBeCloseTo(1 / 3);
  });
});
