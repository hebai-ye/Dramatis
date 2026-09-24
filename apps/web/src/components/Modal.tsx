import type { ReactNode } from 'react';

/**
 * 模态框的外壳（顺序 65 收敛重复）。
 *
 * 「遮罩 + 右上角关闭」这套东西原本在三个弹窗里各写了一遍（新对话 / 场景 / 角色详情），
 * 三份一字不差。收成一个组件之后，改遮罩行为（比如顺序 69 要加的焦点陷阱与 Esc）
 * 只需要动这一个文件。
 *
 * 刻意**只做外壳**：标题栏里放什么（标题 + 说明、还是头像 + 可改的名字）由调用方给，
 * 三处的差异太大，硬套会变成一堆开关。
 */
export interface ModalProps {
  /** 无障碍标签：`aria-label` 与遮罩按钮的「关闭 ××」都由它拼出来。 */
  label: string;
  onClose: () => void;
  /** 标题栏左侧的内容（标题、说明、头像、输入框都行）。 */
  head: ReactNode;
  /** 标题栏右侧那颗退出按钮写什么字（默认「关闭」；新对话那处写「取消」）。 */
  closeLabel?: string;
  children: ReactNode;
  /** 底部按钮那一行；不传就不渲染 `modal-foot`（角色详情就是这种）。 */
  footer?: ReactNode;
}

export function Modal({ label, onClose, head, closeLabel = '关闭', children, footer }: ModalProps) {
  return (
    <div className="modal-backdrop">
      <button type="button" className="modal-scrim" aria-label={`关闭${label}`} onClick={onClose} />
      <section className="modal" role="dialog" aria-label={label}>
        <header className="modal-head">
          {head}
          <div className="topbar-spacer" />
          <button type="button" className="ghost" onClick={onClose}>
            {closeLabel}
          </button>
        </header>

        <div className="modal-body">{children}</div>

        {footer === undefined ? null : <footer className="modal-foot">{footer}</footer>}
      </section>
    </div>
  );
}
