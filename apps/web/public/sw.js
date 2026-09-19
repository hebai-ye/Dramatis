/**
 * Service Worker（ROADMAP P2-2）。
 *
 * 只做一件事：让**应用外壳**离线可用——手机装到桌面之后，断网也能打开、
 * 看到已经存在本地的世界线。
 *
 * 一条硬规矩：**模型请求一律不缓存，也不拦截**。
 *
 * 那是用户自己花钱买的调用，把回答缓存下来既没有意义（每次都要新生成），
 * 又会让人以为「离线也能聊」——而实际上没有网就是没有网。所以：
 *
 * - 只处理同源 GET；跨域（api.deepseek.com、localhost:11434 上的本地模型）一律放行
 * - 非 GET（模型调用都是 POST）直接在第一步就返回，连 respondWith 都不进
 * - 导航请求网络优先，离线时才回落到缓存里的外壳——不会让人看着旧页面以为数据是新的
 */
const CACHE = 'dramatis-shell-v1';

/**
 * 应用外壳要缓存哪些文件——**装的时候自己从 index.html 里读出来**。
 *
 * 一开始是把清单写死在 Service Worker 里（`['/', '/index.html', ...]`），断网打开
 * 白屏：真正的界面是 `/assets/index-<哈希>.js`，哈希只有构建后才知道，写死的清单里
 * 没有它；而首次加载时 Service Worker 还没接管页面，运行时缓存也抓不到。
 *
 * 改成自己发现之后，构建产物叫什么名字都不用管：装的时候抓一次首页，把里面的
 * `<script src>` 与 `<link href>` 全收进来。同源 GET 才收，模型接口一个都不碰。
 */
async function discoverShell(html) {
  const urls = new Set(['/', '/index.html', '/manifest.webmanifest']);
  const patterns = [/<script[^>]+src="([^"]+)"/g, /<link[^>]+href="([^"]+)"/g];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const url = match[1];
      if (url.startsWith('/')) urls.add(url);
    }
  }

  // manifest 里声明的图标也一起收：装到桌面之后断网打开，图标不该是破图
  try {
    const manifest = await (await fetch('/manifest.webmanifest', { cache: 'no-store' })).json();
    for (const icon of manifest.icons ?? []) {
      if (typeof icon.src === 'string' && icon.src.startsWith('/')) urls.add(icon.src);
    }
  } catch {
    // manifest 读不到不影响外壳：图标顶多离线时退化
  }

  return [...urls];
}

/**
 * 抓一份最新的外壳并把过期的产物清掉。
 *
 * 每次 activate 都跑一遍：部署新版本时 sw.js 本身可能一个字都没变（浏览器就不会
 * 重新安装），靠 install 一次是不够的——那会一直拿着上一版的哈希文件。
 */
async function refreshShell() {
  const response = await fetch('/index.html', { cache: 'no-store' });
  const urls = await discoverShell(await response.text());
  const cache = await caches.open(CACHE);

  await cache.addAll(urls);
  for (const request of await cache.keys()) {
    if (!urls.includes(new URL(request.url).pathname)) await cache.delete(request);
  }
  return urls;
}

self.addEventListener('install', (event) => {
  event.waitUntil(refreshShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 别的版本留下的缓存整体删掉，只留当前这一份
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await refreshShell();
      await self.clients.claim();
    })(),
  );
});

/**
 * 诊断钩子：页面可以问一句「你最近处理了哪些请求、命中了没有」。
 *
 * 加它是因为排 PWA 问题**只能靠猜**：缓存里明明有那个文件，页面却白屏，
 * 而 Service Worker 内部发生了什么从外面完全看不见。留一个最近 20 条的环形
 * 记录，代价可以忽略，下次再出问题一眼就能看出来。
 */
const recent = [];

self.addEventListener('message', (event) => {
  if (event.data !== 'dramatis:debug') return;
  event.source?.postMessage({ type: 'dramatis:debug', cache: CACHE, recent });
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  const record = (outcome) => {
    recent.push(`${request.method} ${new URL(request.url).pathname} [${request.mode}] -> ${outcome}`);
    if (recent.length > 20) recent.shift();
  };

  // 模型调用是 POST：不碰
  if (request.method !== 'GET') {
    record('pass:非 GET');
    return;
  }

  const url = new URL(request.url);
  // 跨域一律放行：模型接口、本地模型、任何第三方
  if (url.origin !== self.location.origin) {
    record('pass:跨域');
    return;
  }

  // 页面导航：网络优先；断网时给缓存的外壳
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match('/index.html', { ignoreVary: true });
        record(cached ? 'navigate:缓存兜底' : 'navigate:无兜底');
        return cached ?? Response.error();
      }),
    );
    return;
  }

  /**
   * 静态资源：缓存优先（构建产物带哈希，长缓存是安全的）。
   *
   * **必须 ignoreVary。** 静态文件带 `Vary: Origin`，而我们预缓存时那个请求没有
   * `Origin` 头（Service Worker 自己发起的同源请求不带），页面请求**带**（`crossorigin`
   * 的 module script 是 cors 模式）——于是按 Vary 一比就「不匹配」，白白白屏一次。
   * 这条是实测抓出来的：缓存里明明躺着那个文件，页面却加载失败。
   */
  event.respondWith(
    caches.match(request, { ignoreVary: true }).then((cached) => {
      if (cached) {
        record('cache hit');
        return cached;
      }
      return fetch(request)
        .then((response) => {
          record('network ' + String(response.status));
          // 只缓存成功的同源响应；opaque 与错误响应不入库
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch((error) => {
          record('network 失败: ' + String(error).slice(0, 40));
          throw error;
        });
    }),
  );
});
