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
// v2（审计 A2）：v1 会把同源 GET 的同步接口（/sync/...）也缓存下来，版本号一换，
// activate 时旧缓存整体删除，被污染的 head / pull 响应随之清掉。
const CACHE = 'dramatis-shell-v2';

/**
 * 白名单：只有这些**静态**路径允许进缓存（审计 A2）。
 *
 * 以前是「同源 GET 一律缓存优先」，结果 `/sync/spaces/x/head` 第一次成功后永远命中
 * 缓存，本机永远以为远端没变；明文还留在 Cache Storage 里。改成白名单之后，任何
 * 新接口默认都不缓存，从根上杜绝。
 */
const STATIC_FILES = new Set([
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
]);

/**
 * 可以进缓存的**目录前缀**（2026-09-26 补：头像与立绘）。
 *
 * `/portraits/**`（立绘 / 缩略图 / 头像）与 `/brand/**` 是**运行时按需加载**的：
 * 它们不出现在 index.html 里，`discoverShell` 抓不到，只能在第一次用到时顺手存下来。
 * 不写进白名单的后果很具体——装到桌面之后断网打开，所有头像与立绘都变成破图。
 *
 * 这些名字是**稳定**的（`/portraits/01.webp`，不是带哈希的构建产物），所以顺手存下来
 * 有可能拿到旧图；不要紧：`refreshShell()` 每次 activate 都会把「不在外壳清单里」的缓存
 * 删掉，换过一次部署就自愈了。
 */
const STATIC_PREFIXES = ['/assets/', '/portraits/', '/brand/'];

/** 路径是否属于可缓存的静态外壳：构建产物 `/assets/*`、头像立绘 `/portraits/*`、`/brand/*`，以及上面列出的文件。 */
function isCacheablePath(pathname) {
  if (pathname.startsWith('/sync') || pathname.startsWith('/api')) return false;
  if (pathname.includes('..')) return false;
  if (STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  return STATIC_FILES.has(pathname);
}

/**
 * 一个请求该怎么处理：'pass'（不碰）、'navigate'（网络优先 + 外壳兜底）、'cache'（缓存优先）。
 * 单独拎出来是为了能在测试里直接验证策略。
 */
function classifyRequest(method, href, mode, origin) {
  if (method !== 'GET') return 'pass';
  const url = new URL(href);
  if (url.origin !== origin) return 'pass';
  if (url.pathname.startsWith('/sync') || url.pathname.startsWith('/api')) return 'pass';
  if (mode === 'navigate') return 'navigate';
  return isCacheablePath(url.pathname) ? 'cache' : 'pass';
}

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
      if (url.startsWith('/') && isCacheablePath(url.split('?')[0])) urls.add(url);
    }
  }

  // manifest 里声明的图标也一起收：装到桌面之后断网打开，图标不该是破图
  try {
    const manifest = await (await fetch('/manifest.webmanifest', { cache: 'no-store' })).json();
    for (const icon of manifest.icons ?? []) {
      if (typeof icon.src === 'string' && icon.src.startsWith('/') && isCacheablePath(icon.src)) {
        urls.add(icon.src);
      }
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

  const policy = classifyRequest(request.method, request.url, request.mode, self.location.origin);
  // 非 GET（模型调用）、跨域、同步接口、任何不在白名单里的路径：一律不碰
  if (policy === 'pass') {
    record('pass');
    return;
  }

  // 页面导航：网络优先；断网时给缓存的外壳
  if (policy === 'navigate') {
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
          record(`network ${String(response.status)}`);
          // 只缓存成功的同源响应；opaque 与错误响应不入库
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch((error) => {
          record(`network 失败: ${String(error).slice(0, 40)}`);
          throw error;
        });
    }),
  );
});
