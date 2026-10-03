export interface LazyModuleAddress {
  url: string;
  dependencies: readonly string[];
}

type ModuleNetwork<Module> = {
  fetch: (url: string, options: Pick<RequestInit, 'cache'>) => Promise<Pick<Response, 'ok' | 'status' | 'arrayBuffer'>>;
  import: (url: string) => Promise<Module>;
};

/** 原生 ModuleMap 会记住失败；预检依赖后再导入，重试使用新的目标 URL。 */
export function createLazyModule<Module, Panel>(
  address: LazyModuleAddress,
  select: (module: Module) => Panel,
  network: ModuleNetwork<Module> = {
    fetch: (url, options) => fetch(url, options),
    import: (url) => import(/* @vite-ignore */ url),
  },
): () => Promise<{ default: Panel }> {
  let failures = 0;
  let pending: Promise<{ default: Panel }> | null = null;
  return () => {
    if (pending !== null) return pending;
    const url = new URL(address.url, import.meta.url);
    if (failures > 0) url.searchParams.set('dramatis-retry', String(failures));
    // 用普通 fetch 预热 HTTP 缓存，不用 modulepreload，避免静态依赖失败
    // 先进入无法清除的 ModuleMap。首屏已经成功加载的依赖由构建插件排除。
    pending = Promise.all(
      [url.href, ...address.dependencies].map(async (dependency) => {
        // HTTP 缓存也可能记住 503；重试须刷新原依赖地址，
        // 原生静态 import 随后才能利用更新后的成功响应。
        const response = await network.fetch(dependency, { cache: failures > 0 ? 'reload' : 'force-cache' });
        if (!response.ok) throw new Error(`模块下载失败（${response.status}）`);
        await response.arrayBuffer();
      }),
    )
      .then(() => network.import(url.href))
      .then((module) => ({ default: select(module) }))
      .catch((error: unknown) => {
        failures += 1;
        pending = null;
        throw error;
      });
    return pending;
  };
}
