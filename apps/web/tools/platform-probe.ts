/**
 * 平台能力探针（开发用页面，不进应用构建）。
 *
 * P2-9 的 Tauri 是**条件触发**的，触发条件有四个（按现实可能性排序）：
 *
 * 1. 标签页被回收 / 冻结，后台任务中断
 * 2. 需要 OS 级密钥存储（Windows 凭据管理器）
 * 3. 需要直接调用本地模型
 * 4. 需要监控本地文件夹
 *
 * 「需不需要」不能靠感觉：这个页面把它们变成可以在真机上读到的布尔值。
 * 计时器那一条光看页面看不出来，得从外面把页面冻住（CDP 的
 * `Page.setWebLifecycleState: frozen`），所以这里额外暴露 `window.__beats`——
 * 每 500 毫秒 +1，冻住期间它不涨，就是「后台队列会停」的直接证据。
 */

export {};

const out = document.querySelector('#out');

declare global {
  interface Window {
    __beats: number;
    __probe: () => Record<string, unknown>;
    __freezeReport: () => Record<string, unknown>;
  }
}

window.__beats = 0;
let hidden = 0;
let visibilityEvents = 0;

window.setInterval(() => {
  window.__beats += 1;
}, 500);

document.addEventListener('visibilitychange', () => {
  visibilityEvents += 1;
  if (document.visibilityState === 'hidden') hidden += 1;
});

function has(path: string): boolean {
  try {
    return (
      path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], window) !==
      undefined
    );
  } catch {
    return false;
  }
}

/** Service Worker 上的能力挂在 `ServiceWorkerRegistration.prototype` 上，不在 window 上。 */
function swHas(name: string): boolean {
  if (navigator.serviceWorker === undefined) return false;
  const proto = (globalThis as { ServiceWorkerRegistration?: { prototype: object } }).ServiceWorkerRegistration
    ?.prototype;
  return proto !== undefined && name in proto;
}

interface Row {
  area: string;
  what: string;
  yes: boolean;
  note: string;
}

function rows(): Row[] {
  const nav = navigator as Navigator & {
    storage?: {
      persist?: () => Promise<boolean>;
      estimate?: () => Promise<unknown>;
      persisted?: () => Promise<boolean>;
    };
    serviceWorker?: { register?: unknown; ready?: unknown };
    userAgentData?: { platform?: string };
    credentials?: unknown;
  };

  return [
    {
      area: '上下文',
      what: '安全上下文（isSecureContext）',
      yes: window.isSecureContext,
      note: 'PWA 安装、Service Worker、WebCrypto 都要求它；https 与 http://localhost / 127.0.0.1 都算',
    },
    {
      area: '上下文',
      what: '来源（origin）',
      yes: true,
      note: `实际是 ${location.origin}${nav.userAgentData?.platform === undefined ? '' : ` · ${nav.userAgentData.platform}`}`,
    },
    {
      area: '后台执行',
      what: 'Service Worker',
      yes: navigator.serviceWorker !== undefined,
      note: '能离线、能被后台唤醒，但**只在事件里干活**，不能常驻跑我们的队列',
    },
    {
      area: '后台执行',
      what: 'Background Sync（SyncManager）',
      yes: swHas('sync'),
      note: 'Chrome 支持「联网后替我发一次」，但要装在 SW 里、且只给一次性的重试场景',
    },
    {
      area: '后台执行',
      what: 'Periodic Background Sync',
      yes: swHas('periodicSync'),
      note: '安卓 Chrome 装了 PWA 才有，且由浏览器决定频率；桌面 Chrome 不支持',
    },
    {
      area: '后台执行',
      what: 'Notification（系统通知）',
      yes: 'Notification' in window,
      note: '只有通知，没有「开机自启」这类常驻能力',
    },
    {
      area: '后台执行',
      what: '页面被丢弃过（document.wasDiscarded）',
      yes: 'wasDiscarded' in document,
      note: `这一份页面：${(document as Document & { wasDiscarded?: boolean }).wasDiscarded === true ? '是被恢复的' : '不是被恢复的'}`,
    },
    {
      area: '本地模型',
      what: 'WebGPU（navigator.gpu）',
      yes: has('navigator.gpu'),
      note: '有它才有可能「模型直接跑在页面里」（WebLLM 那条路），否则只能连本地 HTTP 服务',
    },
    {
      area: '本地模型',
      what: '能连 127.0.0.1 的本地服务',
      yes: true,
      note: 'Ollama / LM Studio 都提供 OpenAI 兼容的 HTTP 接口，不加壳也能用——见下面的实测',
    },
    {
      area: '密钥存储',
      what: 'navigator.credentials',
      yes: nav.credentials !== undefined,
      note: '只管 WebAuthn 与浏览器自动填充的密码，**没有「存一段任意密钥」的接口**',
    },
    {
      area: '密钥存储',
      what: 'chrome.runtime（扩展上下文）',
      yes: has('chrome.runtime'),
      note: '有它说明我们是扩展，才能碰 chrome.storage；普通页面拿不到',
    },
    {
      area: '密钥存储',
      what: 'IndexedDB（能存，但不加密）',
      yes: 'indexedDB' in window,
      note: '默认的落盘方式：方便，但任何能读到这台机器磁盘的进程都能看见',
    },
    {
      area: '密钥存储',
      what: 'WebCrypto（能自己加密）',
      yes: has('crypto.subtle'),
      note: '「口令加密后落盘」（P2-8 的建议方案）靠它，不需要原生壳',
    },
    {
      area: '文件夹',
      what: 'showSaveFilePicker（选路径保存）',
      yes: has('showSaveFilePicker'),
      note: '导封存/导正文能直接落进用户选的目录，Win 上的 Chrome/Edge 有',
    },
    {
      area: '文件夹',
      what: 'showDirectoryPicker（整目录授权）',
      yes: has('showDirectoryPicker'),
      note: '拿到目录句柄之后可以读写整个目录',
    },
    {
      area: '文件夹',
      what: 'FileSystemObserver（目录变更通知）',
      yes: has('FileSystemObserver'),
      note: '有它才能做「文件夹里一放卡就自动导入」；没有就只能定时轮询',
    },
    {
      area: '存储配额',
      what: 'storage.persist / estimate',
      yes: nav.storage?.persist !== undefined && nav.storage?.estimate !== undefined,
      note: '能申请持久化、能看配额',
    },
  ];
}

/** 计时器与可见性状态：外面冻住页面时会用到。 */
window.__freezeReport = () => ({
  beats: window.__beats,
  visibility: document.visibilityState,
  visibilityEvents,
  hiddenCount: hidden,
});

window.__probe = () => ({
  ...window.__freezeReport(),
  isSecureContext: window.isSecureContext,
  origin: location.origin,
  userAgent: navigator.userAgent,
  features: Object.fromEntries(rows().map((row) => [`${row.area}·${row.what}`, row.yes])),
});

void (async () => {
  const list = rows();
  const storage =
    navigator.storage === undefined
      ? null
      : {
          persisted: await navigator.storage.persisted?.().catch(() => null),
          quota: (await navigator.storage.estimate?.().catch(() => null)) as { quota?: number } | null,
        };

  if (out !== null) {
    out.textContent = [
      `来源：${location.origin}（${window.isSecureContext ? '安全上下文' : '非安全上下文'}）`,
      `UA：${navigator.userAgent}`,
      `存储：persisted=${String(storage?.persisted ?? '未知')} · quota=${String(storage?.quota?.quota ?? '未知')}`,
      '',
      ...list.map((row) => `${row.yes ? '✅' : '❌'} [${row.area}] ${row.what} —— ${row.note}`),
      '',
      '计时器心跳：window.__beats（每 500ms +1，用来验证「页面被冻结时后台是否停摆」）',
    ].join('\n');
  }
})();
