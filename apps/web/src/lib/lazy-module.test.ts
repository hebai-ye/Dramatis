import { describe, expect, it } from 'vitest';
import { createLazyModule } from './lazy-module';

const url = 'file:///assets/Panel-hash.js';
const address = { url, dependencies: [] };
const available = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) });

// 模块加载器是浏览器边界：模拟其按完整 URL 保留失败的 ModuleMap，
// 让恢复网络后继续请求原 URL 的生产回归必须失败。
function recoveringNetwork() {
  let online = false;
  const modules = new Map<string, Promise<{ Panel: string }>>();
  const requested: string[] = [];
  return {
    recover: () => {
      online = true;
    },
    requested,
    importModule: (address: string) => {
      requested.push(address);
      let pending = modules.get(address);
      if (!pending) {
        pending = online ? Promise.resolve({ Panel: '已恢复的面板' }) : Promise.reject(new Error('模块网络失败'));
        modules.set(address, pending);
      }
      return pending;
    },
  };
}

describe('懒加载模块的网络重试', () => {
  it('在原 URL 的失败仍被缓存时，恢复网络后重试可以得到面板', async () => {
    const network = recoveringNetwork();
    const load = createLazyModule(address, (module) => module.Panel, {
      fetch: available,
      import: network.importModule,
    });
    await expect(load()).rejects.toThrow('模块网络失败');
    network.recover();
    await expect(load()).resolves.toEqual({ default: '已恢复的面板' });
    expect(network.requested).toEqual([url, 'file:///assets/Panel-hash.js?dramatis-retry=1']);
  });

  it('连续两次失败仍允许第三次请求恢复', async () => {
    const network = recoveringNetwork();
    const load = createLazyModule(address, (module) => module.Panel, {
      fetch: available,
      import: network.importModule,
    });
    await expect(load()).rejects.toThrow();
    await expect(load()).rejects.toThrow();
    network.recover();
    await expect(load()).resolves.toEqual({ default: '已恢复的面板' });
    expect(network.requested).toEqual([
      url,
      'file:///assets/Panel-hash.js?dramatis-retry=1',
      'file:///assets/Panel-hash.js?dramatis-retry=2',
    ]);
  });

  it('重试保留已有查询和片段，避免错误地改变模块位置', async () => {
    const network = recoveringNetwork();
    const load = createLazyModule(
      { url: 'file:///assets/Panel-hash.js?v=build#part', dependencies: [] },
      (module) => module.Panel,
      { fetch: available, import: network.importModule },
    );
    await expect(load()).rejects.toThrow();
    network.recover();
    await expect(load()).resolves.toEqual({ default: '已恢复的面板' });
    expect(network.requested[1]).toBe('file:///assets/Panel-hash.js?v=build&dramatis-retry=1#part');
  });

  it('并发打开同一面板共享一个尚未完成的加载', async () => {
    let resolve: (value: { Panel: string }) => void = () => {};
    let requests = 0;
    let started: () => void = () => {};
    const importing = new Promise<void>((done) => {
      started = done;
    });
    const load = createLazyModule(address, (module) => module.Panel, {
      fetch: available,
      import: () => {
        requests++;
        started();
        return new Promise<{ Panel: string }>((done) => {
          resolve = done;
        });
      },
    });
    const first = load();
    const second = load();
    expect(first).toBe(second);
    await importing;
    resolve({ Panel: '面板' });
    await expect(first).resolves.toEqual({ default: '面板' });
    expect(requests).toBe(1);
  });

  it('静态依赖网络失败不会调用原生导入，恢复后仍能打开面板', async () => {
    let dependencyOnline = false;
    let imports = 0;
    const load = createLazyModule(
      { url, dependencies: ['file:///assets/library-editor-hash.js'] },
      (module: { Panel: string }) => module.Panel,
      {
        fetch: async (request) => ({
          arrayBuffer: async () => new ArrayBuffer(0),
          ok: request !== 'file:///assets/library-editor-hash.js' || dependencyOnline,
          status: request === 'file:///assets/library-editor-hash.js' && !dependencyOnline ? 503 : 200,
        }),
        import: async () => {
          imports++;
          return { Panel: '依赖恢复后的面板' };
        },
      },
    );
    await expect(load()).rejects.toThrow('503');
    expect(imports).toBe(0);
    dependencyOnline = true;
    await expect(load()).resolves.toEqual({ default: '依赖恢复后的面板' });
    expect(imports).toBe(1);
  });

  it('共享依赖的 HTTP 503 已被缓存时，重试刷新原地址缓存后再导入', async () => {
    const dependency = 'file:///assets/library-transfer-hash.js';
    const cached = new Map<string, number>();
    const requested: { url: string; cache: RequestCache | undefined }[] = [];
    let online = false;
    const load = createLazyModule({ url, dependencies: [dependency] }, (module: { Panel: string }) => module.Panel, {
      fetch: async (request: string, options?: Pick<RequestInit, 'cache'>) => {
        requested.push({ url: request, cache: options?.cache });
        let status = cached.get(request);
        if (status === undefined || options?.cache === 'reload') {
          status = request === dependency && !online ? 503 : 200;
          cached.set(request, status);
        }
        return { ok: status === 200, status, arrayBuffer: async () => new ArrayBuffer(0) };
      },
      import: async () => {
        // 原生模块的静态 import 仍然请求原依赖地址；给依赖加 query
        // 或只绕过缓存而没有更新原地址，都无法让这次导入成功。
        if (cached.get(dependency) !== 200) throw new Error('原依赖地址仍缓存了 503');
        return { Panel: '原地址缓存已恢复的面板' };
      },
    });
    await expect(load()).rejects.toThrow('503');
    online = true;
    await expect(load()).resolves.toEqual({ default: '原地址缓存已恢复的面板' });
    expect(requested).toEqual([
      { url, cache: 'force-cache' },
      { url: dependency, cache: 'force-cache' },
      { url: 'file:///assets/Panel-hash.js?dramatis-retry=1', cache: 'reload' },
      { url: dependency, cache: 'reload' },
    ]);
  });

  it('成功后关闭和重新打开沿用成功模块，无额外加载', async () => {
    const network = recoveringNetwork();
    network.recover();
    const load = createLazyModule(address, (module) => module.Panel, {
      fetch: available,
      import: network.importModule,
    });
    const first = load();
    await expect(first).resolves.toEqual({ default: '已恢复的面板' });
    expect(load()).toBe(first);
    expect(network.requested).toEqual([url]);
  });
});
