import { describe, expect, it } from 'vitest';
import { deleteWithFeedback } from './deletion-feedback';

describe('归档删除的真实结果', () => {
  it('删除和刷新完成后才报告成功', async () => {
    const events: string[] = [];
    const result = await deleteWithFeedback(
      async () => {
        events.push('remove');
      },
      async () => {
        events.push('refresh');
      },
    );
    expect(events).toEqual(['remove', 'refresh']);
    expect(result).toMatchObject({ ok: true, applied: true });
  });
  it('删除失败不刷新，不报告成功', async () => {
    const events: string[] = [];
    const result = await deleteWithFeedback(
      async () => {
        throw new Error('存储拒绝写入');
      },
      async () => {
        events.push('refresh');
      },
    );
    expect(events).toEqual([]);
    expect(result).toMatchObject({ ok: false, applied: false });
    expect(result.message).toContain('存储拒绝写入');
  });
  it('删除已落库但刷新失败时明确说明部分完成', async () => {
    const events: string[] = [];
    const result = await deleteWithFeedback(
      async () => {
        events.push('removed');
      },
      async () => {
        throw new Error('读取失败');
      },
    );
    expect(events).toEqual(['removed']);
    expect(result).toMatchObject({ ok: false, applied: true });
    expect(result.message).toContain('已删除');
    expect(result.message).toContain('读取失败');
  });
});
