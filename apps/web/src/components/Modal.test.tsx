import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Modal } from './Modal';

describe('Modal shell contract (SSR only)', () => {
  it('uses one modal dialog with custom editable head and footer', () => {
    const html = renderToString(
      <Modal
        label="角色详情"
        onClose={() => {}}
        head={<input defaultValue="姓名" aria-label="姓名" />}
        footer={<button type="button">保存</button>}
        closeLabel="取消"
      >
        正文
      </Modal>,
    );
    expect(html.match(/role="dialog"/g)).toHaveLength(1);
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('dialog-backdrop');
    expect(html).toContain('aria-label="姓名"');
    expect(html).toContain('保存');
    expect(html.match(/>取消</g)).toHaveLength(1);
  });
});
