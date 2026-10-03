import { Component, type ComponentType, lazy, type ReactNode, Suspense, useMemo, useState } from 'react';

interface BoundaryProps {
  label: string;
  retry: () => void;
  children: ReactNode;
}
class PanelBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="notice error" role="alert">
        <p>{this.props.label}加载失败，已保存的数据不受影响。请检查网络后重试。</p>
        <button type="button" onClick={this.props.retry}>
          重试加载
        </button>
      </div>
    );
  }
}

/** 外壳不参与 Suspense；重建 React 边界，模块 loader 自己负责原生缓存的重试。 */
export function LazyPanel<P extends object>({
  load,
  panelProps,
  label,
}: {
  load: () => Promise<{ default: ComponentType<P> }>;
  panelProps: P;
  label: string;
}) {
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt显式重建已失败的lazy组件以重试模块加载
  const Panel = useMemo(() => lazy(load), [load, attempt]);
  return (
    <PanelBoundary key={attempt} label={label} retry={() => setAttempt((value) => value + 1)}>
      <Suspense
        fallback={
          <p className="hint dialog-loading" role="status">
            正在加载{label}…
          </p>
        }
      >
        <Panel {...panelProps} />
      </Suspense>
    </PanelBoundary>
  );
}
