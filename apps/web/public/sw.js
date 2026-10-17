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
// v4：桌面图标改为近景取图，并使用新的安装图标路径。
// v5：预缓存懒加载模块，保留上一版模块供已经打开的页面使用。
const CACHE = 'dramatis-shell-v5';
const SHELL_ASSETS = '/assets/shell-assets.json';
const PREVIOUS_ASSETS = '/assets/shell-previous.json';
const GENERATION_PREFIX = 'dramatis-shell-generation-v1-';
const CONTROL_CACHE = 'dramatis-shell-control-v1';
const ACTIVE_POINTER = '/__dramatis/active-shell';
const IMAGE_CACHE = 'dramatis-images-v1';
const STATIC_CACHE = 'dramatis-static-runtime-v1';
const REFRESH_LOCK = 'dramatis-shell-publish-v1';
const IMAGE_LOCK_PREFIX = 'dramatis-image-update-v1:';
const REFRESH_INTERVAL = 30_000;

function isShellModule(path) {
  return typeof path === 'string' && /^\/assets\/[a-zA-Z0-9._-]+\.(js|css)$/.test(path) && !path.includes('..');
}

async function moduleList(response) {
  if (!response?.ok) throw new Error('离线模块清单读取失败');
  const manifest = await response.json();
  if (!Array.isArray(manifest.files) || !manifest.files.every(isShellModule)) throw new Error('离线模块清单无效');
  return [...new Set(manifest.files)];
}

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
  '/icon-home-192.png',
  '/icon-home-512.png',
  '/icon-home-maskable-192.png',
  '/icon-home-maskable-512.png',
  '/apple-touch-icon.png',
]);

/**
 * 可以进缓存的**目录前缀**：头像、立绘、品牌与版本化内置背景。
 *
 * `/portraits/**`（立绘 / 缩略图 / 头像）与 `/brand/**` 是**运行时按需加载**的：
 * 它们不出现在 index.html 里，`discoverShell` 抓不到，只能在第一次用到时顺手存下来。
 * 不写进白名单的后果很具体——装到桌面之后断网打开，所有头像与立绘都变成破图。
 *
 * 这些名字是**稳定**的（`/portraits/01.webp`，不是带哈希的构建产物），所以顺手存下来
 * 通过独立运行时图片缓存与 no-store 后台更新保持新鲜，换外壳不会删除已加载的图片。
 */
// 内置背景原图与缩略图同样按需加载；版本目录限定在已发布的 v1。
const STATIC_PREFIXES = ['/assets/', '/portraits/', '/brand/', '/backgrounds/v1/'];

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
// biome-ignore lint/correctness/noUnusedVariables: Keep the discovery contract covered by the existing policy tests; publication uses stricter staging validation.
async function discoverShell(html) {
  const urls = new Set(['/', '/index.html', '/manifest.webmanifest']);
  const patterns = [/<script[^>]+src="([^"]+)"/g, /<link[^>]+href="([^"]+)"/g];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const url = match[1];
      if (url.startsWith('/') && isCacheablePath(url.split('?')[0])) urls.add(url);
    }
  }

  // HTML 不列出动态 import；构建清单覆盖两个弹窗和每个面板。
  const modules = await moduleList(await fetch(SHELL_ASSETS, { cache: 'no-store' }));
  for (const file of modules) urls.add(file);
  urls.add(SHELL_ASSETS);

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

function isRuntimeImage(path) {
  return path.startsWith('/portraits/') || path.startsWith('/brand/') || path.startsWith('/backgrounds/v1/');
}

function validNetworkResponse(response) {
  return (
    response.ok && response.type === 'basic' && (!response.url || new URL(response.url).origin === self.location.origin)
  );
}

function imageResponse(response) {
  return validNetworkResponse(response) && /^image\//i.test(response.headers.get('content-type') ?? '');
}

function validateDownload(path, response) {
  if (!validNetworkResponse(response)) throw new Error(`离线资源下载失败: ${path}`);
  const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (
    (path === '/index.html' && mime !== 'text/html') ||
    (path.endsWith('.js') &&
      !['text/javascript', 'application/javascript', 'application/ecmascript', 'text/ecmascript'].includes(mime)) ||
    (path.endsWith('.css') && mime !== 'text/css') ||
    (/\.(png|webp|jpe?g|gif|svg|ico)$/i.test(path) && !mime.startsWith('image/'))
  ) {
    throw new Error(`离线资源类型无效: ${path}`);
  }
}

async function readPointer() {
  const response = await (await caches.open(CONTROL_CACHE)).match(ACTIVE_POINTER, { ignoreVary: true });
  if (!response) return undefined;
  const pointer = await response.json();
  if (
    typeof pointer.active !== 'string' ||
    !pointer.active.startsWith(GENERATION_PREFIX) ||
    (pointer.previous != null &&
      (typeof pointer.previous !== 'string' || !pointer.previous.startsWith(GENERATION_PREFIX)))
  ) {
    throw new Error('离线外壳指针无效');
  }
  return pointer;
}

async function matchShell(request) {
  let pointer;
  try {
    pointer = await readPointer();
  } catch {
    /* v5 仍可作为迁移前的离线兜底。 */
  }
  for (const name of [pointer?.active, pointer?.previous, CACHE].filter(Boolean)) {
    try {
      const response = await (await caches.open(name)).match(request, { ignoreVary: true });
      if (response) return response;
    } catch {
      /* 单个缓存不可读时继续尝试上一代。 */
    }
  }
  return undefined;
}

function withImageLock(request, task) {
  const url = new URL(typeof request === 'string' ? request : request.url, self.location.origin).href;
  if (typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function')
    return navigator.locks.request(`${IMAGE_LOCK_PREFIX}${url}`, { mode: 'exclusive' }, task);
  // 无锁平台不执行 shell 迁移；运行时保持既有按 worker 去重的降级行为。
  return Promise.resolve().then(task);
}

// 只在持有跨 worker 的同源锁时调用。导航响应本身不作为 staging 输入。
async function stageShell() {
  const pointer = await readPointer();
  const prior = await caches.open(pointer?.active ?? CACHE);
  const index = await fetch('/index.html', { cache: 'no-store' });
  validateDownload('/index.html', index);
  const html = await index.clone().text();
  const assets = await fetch(SHELL_ASSETS, { cache: 'no-store' });
  validateDownload(SHELL_ASSETS, assets);
  const modules = (await moduleList(assets.clone())).sort();
  const manifestResponse = await fetch('/manifest.webmanifest', { cache: 'no-store' });
  validateDownload('/manifest.webmanifest', manifestResponse);
  const manifest = await manifestResponse.clone().json();
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    (manifest.icons != null && !Array.isArray(manifest.icons))
  )
    throw new Error('应用 manifest 无效');

  const urls = new Set(['/', '/index.html', '/manifest.webmanifest', SHELL_ASSETS, ...modules]);
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const url = new URL(match[1], `${self.location.origin}/index.html`);
    if (url.origin !== self.location.origin) continue;
    // 即使部署切换只发生在 index 与清单之间，也不能发布混合外壳。
    if (/\.(js|css)$/i.test(url.pathname) && !modules.includes(url.pathname))
      throw new Error('HTML 与模块清单版本不一致');
    if (isCacheablePath(url.pathname)) urls.add(`${url.pathname}${url.search}`);
  }
  for (const icon of manifest.icons ?? []) {
    if (typeof icon?.src !== 'string') throw new Error('应用图标路径无效');
    const url = new URL(icon.src, `${self.location.origin}/manifest.webmanifest`);
    if (url.origin === self.location.origin && isCacheablePath(url.pathname)) urls.add(`${url.pathname}${url.search}`);
  }

  const priorManifest = await prior.match(SHELL_ASSETS, { ignoreVary: true });
  const priorModules = priorManifest ? (await moduleList(priorManifest)).sort() : [];
  const previousManifest = await prior.match(PREVIOUS_ASSETS, { ignoreVary: true });
  const changed = JSON.stringify(priorModules) !== JSON.stringify(modules);
  const previous = changed ? priorModules : previousManifest ? await moduleList(previousManifest) : [];
  const name = `${GENERATION_PREFIX}${crypto.randomUUID()}`;
  const staged = await caches.open(name);
  // Cache API 没有跨 cache 事务：只写未引用的新 generation，最后一次 pointer put 才发布。
  const downloads = new Map([
    ['/', index.clone()],
    ['/index.html', index],
    [SHELL_ASSETS, assets],
    ['/manifest.webmanifest', manifestResponse],
  ]);
  for (const path of urls) {
    const response = downloads.get(path) ?? (await fetch(path, { cache: 'no-store' }));
    validateDownload(new URL(path, self.location.origin).pathname, response);
    await staged.put(path, response);
  }
  for (const path of previous) {
    if (modules.includes(path)) continue;
    const cached = await prior.match(path, { ignoreVary: true });
    if (!cached) throw new Error(`上一代模块不可用: ${path}`);
    validateDownload(path, cached);
    await staged.put(path, cached);
  }
  await staged.put(PREVIOUS_ASSETS, Response.json({ files: previous }));

  // 旧 v5 与先前 generation 中按需存过的头像单独迁移，清理外壳不会删除图片。
  const images = await caches.open(IMAGE_CACHE);
  for (const oldName of new Set([CACHE, pointer?.active, pointer?.previous].filter(Boolean))) {
    const old = await caches.open(oldName);
    for (const request of await old.keys()) {
      if (!isRuntimeImage(new URL(request.url).pathname)) continue;
      await withImageLock(request, async () => {
        if (await images.match(request, { ignoreVary: true })) return;
        const cached = await old.match(request, { ignoreVary: true });
        if (cached && imageResponse(cached)) await images.put(request, cached);
      });
    }
  }
  await (await caches.open(CONTROL_CACHE)).put(
    ACTIVE_POINTER,
    Response.json({ active: name, previous: pointer?.active ?? null }),
  );

  // 发布以后才清理本应用未引用的 generation。失败只留下垃圾，不回滚有效 pointer。
  try {
    for (const key of await caches.keys()) {
      if (key.startsWith(GENERATION_PREFIX) && key !== name && key !== pointer?.active) await caches.delete(key);
    }
  } catch {
    /* 下一次成功发布会再次清理。v5、图片及其它应用缓存不在删除范围。 */
  }
  return [...urls];
}

let refreshPromise;
let lastRefresh = 0;
function refreshShell() {
  if (refreshPromise) return refreshPromise;
  // 无 Web Locks 时保留已有外壳；不能拿单 worker promise 冒充跨 worker 互斥。
  if (typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function') return Promise.resolve(null);
  refreshPromise = navigator.locks
    .request(REFRESH_LOCK, { mode: 'exclusive' }, stageShell)
    .then((urls) => {
      lastRefresh = Date.now();
      return urls;
    })
    .finally(() => {
      refreshPromise = undefined;
    });
  return refreshPromise;
}

function navigationRefresh() {
  if (refreshPromise) return refreshPromise;
  return Date.now() - lastRefresh < REFRESH_INTERVAL ? Promise.resolve(null) : refreshShell();
}

self.addEventListener('install', (event) => {
  event.waitUntil(refreshShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
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
const imageRefreshes = new Map();

function refreshImage(request) {
  const key = request.url;
  if (imageRefreshes.has(key)) return imageRefreshes.get(key);
  const pending = withImageLock(request, async () => {
    const response = await fetch(request, { cache: 'no-store' });
    if (imageResponse(response)) {
      try {
        await (await caches.open(IMAGE_CACHE)).put(request, response.clone());
      } catch {
        /* 配额失败保留旧图，网络响应仍可使用。 */
      }
    }
    return response;
  }).finally(() => {
    imageRefreshes.delete(key);
  });
  imageRefreshes.set(key, pending);
  return pending;
}

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
    const network = fetch(request);
    // waitUntil 在 dispatch 内同步注册，接续网络成功后的 refresh；不能在 .then 内晚注册。
    event.waitUntil(
      network
        .then((response) => {
          if (validNetworkResponse(response) && (event.clientId || event.resultingClientId)) return navigationRefresh();
          return undefined;
        })
        .catch(() => {
          /* 离线 / HTTP 错误 / staging 失败均保留原外壳，下一导航可重试。 */
        }),
    );
    event.respondWith(
      network.catch(async () => {
        const cached = await matchShell('/index.html');
        record(cached ? 'navigate:缓存兜底' : 'navigate:无兜底');
        return cached ?? Response.error();
      }),
    );
    return;
  }

  if (isRuntimeImage(new URL(request.url).pathname)) {
    // 先捕获当前缓存响应，再启动网络更新，避免极快的网络把本次旧图返回值替换。
    const cached = (async () => {
      try {
        const images = await caches.open(IMAGE_CACHE);
        const image = await images.match(request, { ignoreVary: true });
        if (image) return image;
      } catch {
        /* 图片缓存不可用时仍尝试旧壳和在线网络。 */
      }
      return matchShell(request);
    })();
    const network = cached.then(() => refreshImage(request));
    // 缓存命中立即返回旧图；后台仅以 basic/image 的成功响应替换。
    event.waitUntil(network.then(() => undefined).catch(() => {}));
    event.respondWith(
      cached.then(async (response) => {
        if (response) {
          record('image:缓存命中，后台更新');
          return response;
        }
        return (await network).clone();
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
  const staticResponse = (async () => {
    let cached = await matchShell(request);
    if (!cached) {
      try {
        cached = await (await caches.open(STATIC_CACHE)).match(request, { ignoreVary: true });
      } catch {
        /* 运行时缓存不可读仍继续网络，不让在线页面因为缓存错误白屏。 */
      }
    }
    if (cached) {
      record('cache hit');
      return cached;
    }
    return fetch(request)
      .then(async (response) => {
        record(`network ${String(response.status)}`);
        // 只缓存成功的同源响应；opaque 与错误响应不入库
        if (validNetworkResponse(response)) {
          // 已发布 generation 保持不变；运行时 miss 写独立缓存。
          try {
            await (await caches.open(STATIC_CACHE)).put(request, response.clone());
          } catch {
            /* 配额失败仍返回网络响应。 */
          }
        }
        return response;
      })
      .catch((error) => {
        record(`network 失败: ${String(error).slice(0, 40)}`);
        throw error;
      });
  })();
  event.waitUntil(staticResponse.then(() => undefined).catch(() => {}));
  event.respondWith(staticResponse);
});
