# 安卓版：Capacitor 壳

> 对应 [ROADMAP.md](./ROADMAP.md) P2-10。**这条路已经开工**：壳搭起来了、APK 在本机真的构建出来了。
> 这篇记的是「怎么用、验到哪一步、还差什么」。复核日期：2026-09-20。

## 为什么走 Capacitor 而不是等 TWA

两条路的分水岭是**要不要一个已部署的 HTTPS 域名**：

| | Capacitor 壳 | TWA（Bubblewrap） |
| --- | --- | --- |
| 内容从哪来 | 打**进 APK**（`apps/web/dist`） | 在线网页 |
| 网页的源 | `https://localhost`（WebView 自己造的，**安全上下文**） | 你自己的域名 |
| 需要域名 + 证书 + assetlinks.json | **不需要** | 需要，而且得等域名审核 |
| 装不上网能用吗 | 能（资源在包里） | 不能 |

「域名 + HTTPS + 备案」那条线还卡在审核上，而 Capacitor 这条路**今天就通**，
所以先做它。等域名下来再考虑 TWA 也不冲突——同一套 Web 产物，两条路都吃。

## 目录与命令

```
apps/android/
  package.json            # @dramatis/android：sync / add:android / open / apk
  capacitor.config.json   # appId、webDir=../web/dist、androidScheme=https
  android/                # 原生工程（**gitignore 掉了**，用 add:android 还原）
```

```bash
# 0) 依赖（只第一次）
pnpm install --filter @dramatis/android --store-dir .pnpm-store/v11

# 1) 生成原生工程（只第一次；android/ 被 gitignore，换机器要重新生成）
pnpm --filter @dramatis/android add:android

# 2) 改完 Web 之后：构建 + 拷进壳（日常就这一条）
pnpm --filter @dramatis/android sync

# 3) 构建调试包
cd apps/android/android && ./gradlew assembleDebug
#    产物：apps/android/android/app/build/outputs/apk/debug/app-debug.apk

# 4) 装到手机（手机开「开发者选项 → USB 调试」，数据线连上）
adb install -r apps/android/android/app/build/outputs/apk/debug/app-debug.apk

# 或者用 Android Studio 打开原生工程直接跑
pnpm --filter @dramatis/android open
```

## 本机这次真的做到了哪一步

| 步骤 | 结果 |
| --- | --- |
| `cap add android` | ✅ 生成原生工程 + 把 `apps/web/dist` 拷进 `assets/public` |
| `cap sync android` | ✅ 重复跑也正常（先构建 Web 再拷贝） |
| `gradlew assembleDebug` | ✅ **BUILD SUCCESSFUL**，产出 `app-debug.apk`（4.8 MB） |
| APK 内容 | ✅ 里面有 `assets/public/index.html`、`assets/index-C3H9BKqC.js`（与生产构建同一个哈希）、manifest、图标、`sw.js`；`assets/capacitor.config.json` 里 `androidScheme=https` |

构建这一关本机踩了两个坑，都记在这儿省得再摸：

1. **JDK 必须是 21**：Capacitor 7 的子工程按 Java 21 编译。机器上那个
   Eclipse JustJ 的 `jre.full` 是 JRE（没有 `jlink`，AGP 的
   `JdkImageTransform` 直接报 "jlink does not exist"），
   `C:\Program Files (x86)\Android\openjdk\jdk-17...` 是完整 JDK 但版本不够。
   最后用的是 **Android Studio 自带的 JBR**：`C:\Program Files\Android\Android Studio\jbr`。
2. **AGP 版本与本地缓存**：模板写 `com.android.tools.build:gradle:8.7.2`，
   而本机 `~/.gradle` 缓存里只有 8.7.3；另外模板里那行 `google-services:4.4.2`
   本机没有、这个项目也用不到（没有 Firebase）。离线构建先用 8.7.3 + 去掉那行才跑通，
   之后就整条通了。**这两处只动在被 gitignore 的生成目录里**，不是仓库内容；
   在有正常网络的机器上按模板默认值就行。

## 四项能力逐条验（在「和 WebView 同源」的环境里）

真机这一轮**没做到**：本机没有连手机（`adb devices` 是空的），也没有模拟器
（SDK 里没有 system image，也没有 `sdkmanager`/`avdmanager`，
而且 `HypervisorPresent=False`，起了也只能软件模拟）。

退而求其次，用**最接近 WebView 的环境**验：把 APK 里的 `assets/public/` 原样解出来，
用自签证书在 `https://localhost`（**与 Capacitor 的 WebView 完全同源**）上跑一遍，
浏览器用本机 Chrome、视口 390×844、`isMobile + hasTouch`。差异只有一个：
是 Chrome 而不是 Android System WebView。

| 项 | 结果 | 说明 |
| --- | --- | --- |
| 安全上下文 | ✅ `isSecureContext=true`、`crypto.subtle` 在 | 同步的加密、IndexedDB 都靠它 |
| **IndexedDB 持久化** | ✅ 导入角色卡 → 开出一条世界线 → **整页重载后还在**（房间 / 卡 / 对话都读了出来） | `navigator.storage.persisted()` 是 `false`：拿持久化要用户点「申请持久化存储」，或把应用装起来 |
| **文件导入** | ✅ 走 `input[type=file]` 导入 ST 卡（V2 JSON）成功，并自动开出一条线 | 与 PWA 同一条代码路径 |
| **文件导出** | ✅ 两条路都验了：有 File System Access 时写盘 4.4 KB；**把 picker 删掉（模拟安卓 WebView）后走下载回退**，同样拿到 `dramatis-秦娘-*.json`，内容是正确的封存 JSON | 见下面的「真机上要盯的点」 |
| **同步可用** | ✅ 从 `https://localhost` 连到 `http://127.0.0.1:5273/sync`：建空间、推 7 条、拉 7 条、状态「已连接」 | **顺带验掉一个关键疑问**：https 页面 fetch `http://127.0.0.1` **没有被当成混合内容拦掉**（Chromium 把 127.0.0.1 视为可信来源） |
| 后台队列 | ⚠️ 只在「页面活着 / 页面关掉」两种情形验过（见 DESKTOP.md），**切后台没验** | 队列是页面内的定时器，安卓上取决于 WebView 被切后台后还跑不跑定时器——只能真机看 |

## 真机上要盯的点（拿到手机就按这个清单跑）

1. **文件导出到底落哪了**：安卓 WebView 没有 File System Access，应用会走
   「`<a download>` + blob」那条回退。WebView 默认**不一定**处理这种下载
   （桌面 Chrome 会弹下载栏，WebView 需要宿主实现 `DownloadListener`）。
   如果导出没反应，这就是原因——解法是加 `@capacitor/filesystem` + 分享，
   把导出的字节直接写进文件系统。**这是这一轮最可能真出问题的一处**。
2. **文件导入**：`<input type=file>` 在 WebView 里要靠宿主的文件选择器，
   Capacitor 的默认实现是接的。真机点一次「导入素材」看看有没有反应。
3. **切后台再回来**：聊一轮（角色回复落盘）→ 立刻切到别的应用待 2 分钟 →
   回来。看记忆是否补上了（右上「面板 → 记忆」）。再狠一点：从最近任务里
   划掉应用，重新打开，看那一轮的记忆还在不在（应该会被 `recoverInterrupted`
   捡回来）。
4. **键盘与安全区**：输入框在键盘弹起时有没有被遮住；顶部状态栏有没有压住界面。
   Capacitor 默认不做 `viewport-fit`/insets 处理，这一条要在真机上看。
5. **存储被系统清理**：安卓在存储紧张时会清应用数据。三件套是
   「导出封存 + 同步 + `storage.persist()`」，真机上把「本机存储」那一页看一眼
   有没有拿到持久化。

## 没验到的（写清楚免得以后当成验过了）

- **没在安卓真机或模拟器上跑过**：本机没有设备、没有 system image、没有硬件虚拟化。
  上面那四项是在「同源 + 同引擎」的浏览器里验的，**不等于**真机。
- **没验过 WebView 版本差异**：安卓 7 以上的 System WebView 是 Chromium，
  但版本可能是 90+ 的老家伙；`FileSystemObserver` 这类新 API 在真机上大概没有
  （代码里没有依赖它，只是记一笔）。
- **没验过签名与发布**：`assembleDebug` 用的是调试签名，装到手机上要允许「未知来源」。
  发布要另建 keystore（`.gitignore` 已经把 `*.keystore` / `*.jks` 挡住了），
  这一步等真要分发再做。
- **原生工程不进版本库**：`.gitignore` 里原本就写了 `apps/android/android/`，
  这一轮沿用了这个决定。代价是**原生侧的改动（图标、启动图、清单权限）不会被提交**，
  换机器要重新 `add:android` 再改一遍。等开始动原生侧的东西时，
  就该把这个目录改成「提交、只忽略 build 产物」——那时一起改。
