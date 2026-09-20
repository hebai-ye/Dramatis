# apps/android —— Dramatis 的安卓壳

Capacitor 工程：把 `apps/web/dist` 装进 WebView，源的 scheme 是 `https`，
所以在壳里跑的就是**同一个安全上下文**（IndexedDB、WebCrypto、Service Worker 都能用），
不需要已部署的域名。

```bash
pnpm --filter @dramatis/android add:android   # 生成 android/（被 gitignore，只需一次）
pnpm --filter @dramatis/android sync          # 改完 Web 后：构建 + 拷进壳
pnpm --filter @dramatis/android open          # 用 Android Studio 打开
pnpm --filter @dramatis/android apk           # sync + assembleDebug
```

细节（为什么这么选、本机验到哪一步、真机上要盯什么）见
[docs/ANDROID.md](../../docs/ANDROID.md)。
