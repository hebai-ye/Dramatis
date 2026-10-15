# UI 首批收尾实施与验收（2026-10-11）

用户批准“按此实施”的四项已完成。本批改进素材操作、场景编辑、桥接反馈与世界书差异阅读，沿用叙事剧场、三主题、手机全屏弹窗及既有抽屉/阅读/输入流程。没有新增依赖、提交、部署或本批真实模型请求。原26项的外部验收和部分一交接没有因此关闭，参见[状态与预分析](./2026-10-10-task-status-ui-preanalysis.md)。

## 最终行为与文件

| 项 | 已实施行为 | 文件 |
| --- | --- | --- |
| 素材操作 | App返回实际Promise，按world/message/artifact共享在途Promise；卡片同步防重复点击，显示该项忙态及可读失败。其他卡片可用；成功由保存后的artifact.status决定，resolve不等于采纳成功。版本冲突拒绝、丢弃/撤回/反向草稿语义保持 | `apps/web/src/App.tsx`、`components/SideChat.tsx` |
| 场景编辑 | 场景名/地点/时间显式保存；同行勾选只用于切场，保存当前场景后仍须确认放弃同行改动才能关闭。Esc/遮罩/标题关闭接入既有DialogShell的dirty/busy guard。摘要串行自动保存，关闭/保存/切场等待提交，失败留窗保留输入并可重试，组合输入不提交 | `components/SceneDialog.tsx`、`App.tsx` |
| 场景目标与部分失败 | 固定开窗sceneId，外部换场保留原三字段/摘要/同行，锁定后续写入；确认放弃后关闭不flush新目标。主动切场成功后旁白/收尾失败返回partial，明确已切场、留窗禁重复，展示规范化新场输入。正常成功关闭；unavailable/异常保留编辑 | 同上 |
| 弹窗焦点 | 控件被禁用/移除后浏览器可能将焦点移到body且不发focusin；每次提交后检查焦点，必要时回标题关闭按钮。保留既有确认、Tab循环、背景inert和返回触发器机制 | `components/DialogShell.tsx` |
| 桥接 | 区分待采纳素材与立即应用的场景修改。复制失败显示下一步并展开原提示词；复制请求在提示词/阶段变化或卸载时失效。本地助手等待时禁收下/放弃，同步防重；过期助手响应不提交到新阶段 | `components/WebBridgePanel.tsx` |
| 世界书差异 | 补中文字段标签；新增/修改/删除按entryId去重计条目，书级另计；新增/删除先展示正文/关键词，完整JSON、ID和扩展仍可查。布尔变化显示是/否，连续长文本换行 | `components/WorldBookDiff.tsx`、`apps/web/src/styles.css` |

上述components路径均在`apps/web/src/components/`。测试文件为该目录的`Modal-callbacks.test.tsx`以及`apps/web/tests/ui/{main.tsx,optimization.html,optimization.tsx}`、`apps/web/tests/browser/ui-optimization.browser.ts`。既有main夹具仅对齐Promise合同；新增夹具不读取个人配置或真实数据。

## 集中验证

子任务只实现和静态复核，不测试、不启动浏览器或服务器。root在四项完成后集中验证；模型配置为6.1 Sol（场景/最终复审）及Luna（桥接/diff/首轮独立复核），没有Astra。

| 检查 | 实测结果及范围 |
| --- | --- |
| Web单测 | 整合首轮49文件、341项通过、退出0；场景/焦点及固定目标补丁后针对实际关闭回调与dialog-controller的2文件、7项再次通过，未重跑其余稳定单测 |
| 类型 | Web `tsc --noEmit`、`tsc -p tsconfig.tools.json`通过；最终场景补丁后Web及本轮新增browser/fixture专用类型再次通过 |
| 格式/lint | 本批11个TS/TSX/CSS文件Biome通过；差异空白检查通过。新增HTML与Markdown不计入这个文件数 |
| 实际Edge UI | 最终23/23、退出0：12个既有阅读/键盘/手机抽屉/弹窗回归，加11个本批保存失败/重试/串行/输入法/同行确认/partial/外部换场/素材防重与权威状态/复制失败与迟到/助手过期/diff/主题用例。其中主题矩阵是一个用例内的6种组合，不按截图数虚增通过数 |
| 视觉与可达性 | 360酒馆场景、390浅色桥接失败、640深色展开diff、1280酒馆素材/浅色场景/深色桥接失败，六张截图人工核对。长连续英文正文保持局部换行，无页面横向溢出；窄桥接面板内可滚到放弃按钮，新增断言后该主题用例独立1/1通过。截图在ignored `logs/ui-20261011-visual/` |
| 构建 | 最终190模块构建通过，主JS 520.57 kB、gzip 167.80 kB；仍有既有500 kB chunk提醒，不据此关闭D05剩余范围 |
| 收尾 | UI runner正常退出0；TCP回环6287拒绝连接，测试服务已释放。Windows Get-NetTCPConnection权限不足，未据此声称全进程清点通过 |

新增浏览器夹具拦截外部HTTP和WebSocket；助手响应仅由路由合成，不访问8791真实服务或模型。全部是实际组件+受控回调的浏览器验证，不代替真实App存储/同步和真模型端到端。

## 失败与复审记录

- 首次Biome启动经pnpm找不到bin，改用已安装的Node入口；未安装依赖。初轮hook依赖lint按实际scene捕获修正。
- 首轮浏览器20通过、2失败：摘要重试移除按钮和partial禁用按钮后焦点落body，Esc没有进入DialogShell。修复focus检查后原两例2/2通过，随后完整22/22；补固定目标后完整23/23。没有删除或放宽失败断言。
- 初次临时扩大到旧浏览器夹具的额外类型检查暴露其已有元素/数组边界类型问题；本轮专用类型范围收窄到新增夹具，产品两套类型门禁保持通过，未顺手修改旧无关测试。
- Luna首轮发现助手等待期间仍可手动提交/放弃的竞态，已修并加入真实浏览器受控响应例。6.1 Sol独立最终复审及固定目标补丁复审未见阻断；root集中实测后再核对截图。

## 边界与回退

固定sceneId和App UI scope只阻止目标失效后的新UI提交；已经进入底层onSave的写入不会被取消、回滚或变成事务。这不是expectedSceneId持久CAS。B07/D01存储交接、真实桥接DOM、C05真BYOK/CSP、C06旧历史/RPO/RTO、D02质量和Android真机仍按原台账验收。App共享Promise Map的跨重挂载分支本批只有静态复核，browser素材例测试真实SideChat的卡片防重，没有调用完整App存储路径。

本批未恢复、重置或修改付费账本。共享工作树只读汇总观察到D02账本已从旧固定SHA继续到sequence6、2次/quality2次、¥0.01667，摘要SHA为`3047d61c6f8ae0e22fba254b61d61f2e67d8ec70e73d8088506e5b54f6a0afb4`（mtime UTC 2026-10-11 05:54:58）；旧SHA探针因此不再适用。该观察不归为UI调用或评分证据，也没有撤销其他会话的推进。

回退时只撤本批组件/App异步接口与对应夹具增量，保持前一轮A09/A10/D03及旧工作树全部差异；不能对detached基线执行reset/clean。没有数据迁移或数据库回退需求，已成功提交的场景/素材数据不因UI回退撤销。root的App/SideChat/styles实施前副本及六张截图在ignored logs中保留供差异定位。
