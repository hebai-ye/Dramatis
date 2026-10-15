import { eventId, instanceId } from '@dramatis/core';
import { describe, expect, it } from 'vitest';
import { memorySummaryLabel } from './MemoryPanel';

describe('记忆摘要编辑的语义标签', () => {
  it('角色合并印象的summary属于主观印象', () => {
    expect(memorySummaryLabel({ observerId: instanceId('observer'), supersedes: [eventId('source')] })).toBe(
      '这个角色的主观印象',
    );
  });

  it('角色episodic条目的summary仍是客观经过', () => {
    expect(memorySummaryLabel({ observerId: instanceId('observer') })).toBe('客观经过');
    expect(memorySummaryLabel({ observerId: instanceId('observer'), supersedes: [] })).toBe('客观经过');
  });

  it('客观条目即使合并仍保持客观标签', () => {
    expect(memorySummaryLabel({ observerId: null, supersedes: [eventId('source')] })).toBe('客观经过');
    expect(memorySummaryLabel({ observerId: null })).toBe('客观经过');
  });
});
