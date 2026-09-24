import type { ReactNode, Ref } from 'react';
import { useCoarsePointer } from '../lib/viewport';
import { IconSend, IconStop } from './Icons';

/**
 * 输入区（顺序 65 收敛重复）。
 *
 * 主对话与副对话的输入区原本是两块几乎逐字一样的 JSX：同一个盒子、同一套
 * 「回车发送（手机上回车换行，点右下角那颗）」「忙的时候那颗键变成停止」
 * 「没配 Key 时那颗键写生成提示词」的规则。差异只有左边那排控件和占位文字，
 * 所以那两样由调用方给，剩下的收在这里——以后改输入行为只用改一个地方。
 */
export interface ComposerProps {
  value: string;
  onChange: (next: string) => void;
  inputRef?: Ref<HTMLTextAreaElement>;
  placeholder: string;
  /** 没准备好（世界/对话还没加载）或已归档时不让人打字。 */
  disabled: boolean;
  busy: boolean;
  /** 桥接正等着贴回来：这时不让再发一句，否则那一步会被冲掉。 */
  bridgeOpen: boolean;
  /** 没配 Key：那颗键不是「发送」而是「生成提示词」。 */
  manualMode: boolean;
  onSend: () => void;
  onStop: () => void;
  /** 桥接正等着时那颗发送键的 title（两处的说法不同：「放弃这一轮」/「放弃这次起草」）。 */
  bridgeTitle?: string;
  /** 左边那排控件（主对话是模式与场景两颗芯片，副对话只显示对话名）。 */
  tools?: ReactNode;
}

export function Composer({
  value,
  onChange,
  inputRef,
  placeholder,
  disabled,
  busy,
  bridgeOpen,
  manualMode,
  onSend,
  onStop,
  bridgeTitle = '先把这一轮贴回来（或点「放弃」）再发下一句',
  tools,
}: ComposerProps) {
  /*
   * 粗指针（手机 / 平板）上回车是换行：输入法里选字也按回车，抢那一下会把人打断。
   * 所以手机上发送只认右下角那颗键，桌面上回车即发送。
   */
  const coarsePointer = useCoarsePointer();

  const sendLabel = manualMode ? '生成提示词' : '发送';

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={inputRef}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            if (coarsePointer) return;
            event.preventDefault();
            onSend();
          }}
        />

        <div className="composer-tools">
          {tools}

          <div className="topbar-spacer" />

          {busy ? (
            <button
              type="button"
              className="composer-action stop"
              title="停止这一轮"
              aria-label="停止"
              onClick={onStop}
            >
              <IconStop />
            </button>
          ) : (
            <button
              type="button"
              disabled={disabled || value.trim() === '' || bridgeOpen}
              title={bridgeOpen ? bridgeTitle : undefined}
              aria-label={sendLabel}
              className={manualMode ? 'composer-action labelled' : 'composer-action'}
              onClick={onSend}
            >
              <IconSend />
              {manualMode ? <span>生成提示词</span> : null}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
