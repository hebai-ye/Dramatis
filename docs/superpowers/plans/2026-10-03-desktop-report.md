# B03 桌面构建新鲜度报告

## 结果

- `tools/desktop/build-inputs.mjs` 以规范化相对路径及文件内容 SHA-256 计算生产构建指纹，纳入 web `src`、`public`、`tools`、core `src`、根与工作区清单/锁文件、包清单、Vite 配置、入口、实际 tsconfig 继承/引用链、Vite 生产环境文件、Node/Vite 版本及相关构建环境。环境值仅进入最终哈希，未写入日志或 provenance。
- `launch.mjs --prod` 仅在指纹匹配且 `dist/index.html`、`sw.js`、`assets/shell-assets.json` 与清单所有安全路径均可读取、SW 生成尾注与清单一致时复用构建。旧 `dist` 无 provenance 会重建。
- 重建前删除旧 provenance；Vite 失败、输入在构建期间改变、产物缺失或不一致时不写新 provenance，也不启动 preview。成功校验后在 `dist` 内以临时文件加 rename 原子写入 provenance。
- 地址已有服务时，启动器提示其构建来源无法确认、可能为旧版；不据本地 `dist` 判断该进程，也不终止该进程。

## Red / green 与检查

- Red：`node --test tools/desktop/build-inputs.test.mjs`，最初因缺少 `build-inputs.mjs` 失败；增加“缺少 `public/sw.js` 应失败”的测试时，也观察到明确的 `Missing expected rejection`。
- Green：同一命令通过，7 个 `node:test` 场景覆盖保留 mtime 的内容修改、web 公共头像与 tools 增删、根锁/环境/tsconfig 变化、必需文件缺失、危险链接、无 provenance、成功复用、构建失败与中途变化、缺失或不安全的资源、SW 尾注不一致，以及已有服务来源提示与保留。
- `node --check tools/desktop/launch.mjs` 与 `node --check tools/desktop/build-inputs.mjs` 通过。
- `node` 对真实工作树计算指纹成功；`biome check` 对三个改动脚本通过；`git diff --check` 通过。

## 边界

测试使用 `node:test` 临时仓库夹具，未在这次并行修改中的真实 web 工作树执行生产 Vite 构建。临时目录清理前校验其绝对路径位于系统 temp 且名称具有专用前缀。没有修改 `apps/web/public/sw.js`，也没有提交或推送。

## fix1：入口和产物完整性

- HTML 校验现在要求真实的外部模块 JS 入口；入口脚本、样式和模块预加载链接都必须列在安全的 shell 清单中，并与引用的文件类型一致。HTML 注释中的假入口不计入。
- 成功构建时，将除 provenance 及本程序临时 metadata 外的全部 `dist` 文件按路径与内容计算摘要，随输入指纹一同原子保存。复用时重新计算；JS、SW 正文以及清单外的其他 `dist` 文件有增删或字节变化，都判为过期。
- `launch.mjs` 先探测已有服务，再检查本地 `node_modules`。因此本地依赖缺失时仍能打开已有服务，并明确提示其构建来源未知，不终止该服务。
- Red：`node --test tools/desktop/build-inputs.test.mjs`，新增 3 个场景初跑 `6 pass / 3 fail`，分别暴露了入口未验证、产物字节变化被判新鲜和依赖检查早退。随后补充注释假入口与错误 JS 类型测试，初跑 `8 pass / 1 fail`。
- Green：同一命令 `9 pass / 0 fail`；`node_modules/.bin/biome.CMD check tools/desktop/build-inputs.mjs tools/desktop/build-inputs.test.mjs tools/desktop/launch.mjs` 通过；两个脚本的 `node --check` 与 `git diff --check` 通过。真实全仓 Vite build 留待 product 冻结后统一验证。
