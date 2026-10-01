import { describe, expect, it } from 'vitest';
import { createDialogController } from './dialog-controller';

describe('弹窗受控离开', () => {
  it('忙碌时阻止关闭并提供说明，解除后才关闭', () => {
    const events: string[] = [];
    const controller = createDialogController();
    controller.setGuard({ kind: 'busy', message: '正在保存，请稍候。' });
    controller.request(() => events.push('closed'));
    expect(events).toEqual([]);
    expect(controller.state().notice).toContain('正在保存');
    controller.setGuard(null);
    controller.request(() => events.push('closed'));
    expect(events).toEqual(['closed']);
  });

  it('取消恢复码离开确认不丢码、不执行待动作', () => {
    const events: string[] = [];
    const controller = createDialogController();
    controller.setGuard({ kind: 'recovery', message: '请保存恢复码。', discard: () => events.push('cleared') });
    controller.request(() => events.push('reload'));
    expect(controller.state().pending).not.toBeNull();
    controller.cancel();
    expect(events).toEqual([]);
    expect(controller.state().guard?.kind).toBe('recovery');
  });

  it('明确确认后先清草稿再切分类，并且不能重复执行', () => {
    const events: string[] = [];
    const controller = createDialogController();
    controller.setGuard({ kind: 'dirty', message: '尚未保存。', discard: () => events.push('discard') });
    controller.request(() => events.push('category'));
    controller.confirm();
    controller.confirm();
    expect(events).toEqual(['discard', 'category']);
    expect(controller.state().pending).toBeNull();
  });

  it('确认打开后变忙也不能跳过保护', () => {
    const events: string[] = [];
    const controller = createDialogController();
    controller.setGuard({ kind: 'dirty', message: '未保存。' });
    controller.request(() => events.push('closed'));
    controller.setGuard({ kind: 'busy', message: '保存中。' });
    controller.confirm();
    expect(events).toEqual([]);
    expect(controller.state().notice).toContain('保存中');
  });
});
