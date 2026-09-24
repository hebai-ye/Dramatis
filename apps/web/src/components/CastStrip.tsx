import type { CastName } from '@dramatis/core';

interface Props {
  /** 此刻在场上的人（顺序 62 起只带 id 与显示名）。 */
  cast: readonly CastName[];
  /** 副对话里没有「在场角色」这回事，只有世界管理员。 */
  isSide: boolean;
  /**
   * 点一下某个角色：把名字插进输入框（就是应用里已有的「点名叫人」），
   * 于是**不用打开任何面板、也不打断这一轮对话**就能直接跟他说话。
   */
  onAsk: (displayName: string) => void;
}

/**
 * 手机顶栏里的在场角色条（用户 2026-09-24 要求：与顶栏齐平、高度只有顶栏一半）。
 *
 * 为什么放在顶栏而不是主区标题栏：640px 以下右缘角色栏是隐藏的，而「谁在场」这件事
 * 只在标题栏里写得下，一多就换行、把对话往下挤。放进顶栏之后它只占半高、能横向滑动，
 * 而且**点一下就能对某人说话**——以前要先开面板、再点一次，等于打断对话。
 */
export function CastStrip({ cast, isSide, onAsk }: Props) {
  if (isSide) return <span className="strip-note">世界管理员 · 不扮演角色</span>;
  if (cast.length === 0) return <span className="strip-note">场景里还没有人</span>;

  // 不给容器挂 role/aria-label：每颗按钮自己带「对XX说话」的名字，够了
  return (
    <div className="cast-strip">
      {cast.map((instance) => (
        <button
          key={instance.id}
          type="button"
          className="cast-chip"
          title={`点一下把「${instance.displayName}」插进输入框，直接对他说话`}
          aria-label={`对${instance.displayName}说话`}
          onClick={() => onAsk(instance.displayName)}
        >
          {instance.displayName}
        </button>
      ))}
    </div>
  );
}
