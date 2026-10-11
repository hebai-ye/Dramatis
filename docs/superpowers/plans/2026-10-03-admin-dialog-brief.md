# A09 / A10 / D03 实施要求

允许packages/core/src/admin/**、web/lib/admin.ts及session.ts、components/**、App.tsx、styles.css；报告在docs。本批不得改core其他路径/root清单或锁、sync-server/admin。禁止提交/push和子代理。先行为red测试再green。此前UI导航批已改bridge守卫和focus接口，保留。

## A09 条目级世界书与diff

工具upsert_world_book改为entries是upserts，不是整本替换。已有条目通过entryId，rename保id，省略条目/字段保留全部原值与高级字段。新条目无entryId；删除只经deleteEntryIds显式列表。book.name可省略于修改，新建必填name；新entry content必填，合并后每entry须有constant或keys。重复upsert/delete/未知entryId/同id增改和删、未知book或修改无完整base都拒绝，不能静默生成另一本。提示库条目列稳定id，提示词说明字段合并与显式删除。
AdminDraft世界书带previous原书，baseUpdatedAt，新建previous=null。artifact用已有previousPayload存before，仍生成完整payload让repository既有adopt兼容。不修改AdminArtifact模型定义。修改草稿缺previous/baseline的历史artifact禁采纳并提示重新起草；不要把新建草稿误判旧修改。pending UI显示条目新增/字段修改/明确删除diff（含书名变更），能展开看具体内容；不能只条数。UI真实base缺失/版本变化时阻止，repository已有非原子stalecheck不冒充CAS。
Q5A：修改世界书采纳后禁用立即revoke，提供“起草反向修改”。新建书仍走既有撤回。API层session.revokeArtifact同样守卫修改book，不能仅隐藏按钮。反向draft使用before/after对比，只逆原改动，保留其它条目及字段后续编辑。先fresh读取current并断言原变更的受影响值仍等于after；原新增entry后被改、原删除entry被重建/原字段后续改、缺可信before/after都拒绝。生成反向payload基于freshcurrent，baseUpdatedAt=current.updatedAt，再走普通待采纳diff及stalecheck；不直接全before替换并套新版本。对书名/entry顺序/新删entry边界谨慎，不能重排其它用户条目。反向draft存到原消息的artifacts或新的admin消息都可，但只写当前世界相关数据，旧世界异步完成不覆盖当前UI。依赖repository原子CAS尚未有，报告明确TOCTOU归部分一。
测试省略条目保留/rename高级字段/显式delete/重复未知reject/diff/旧draft禁止/修改revoke拒绝/反向保无关编辑且拒绝触及变更。

## A10 明确场景目标

副对话UI目标选择：0主对话禁场景并说明；单条非归档主对话自动选；多条必须显式选择，无隐式最近fallback。send(text,targetConversationId?)捕获目标与roomId供API和桥接共用，桥接持久状态也存target，不从回填时当前选项推断。提示上下文显示选定目标的名字与实际scene；世界书/角色等工具不受缺目标影响，set_scene要说明必须先选。
session.setWorldScene(patch,targetConversationId,expectedRoomId?)执行重新核对同room、main、nonarchived、存在；已删除/归档/跨世界目标返回null/可读失败，不改其它主线。请求期间世界/目标改变不可fallback。executeDraft/result artifactsummary写目标名，场景即时生效，prompt不再说全部只产草稿。AdminPromptInput允许targetName/id可选，API/bridge一致。新场景若target.activeSceneId为空使用已有repository操作，延迟写入UI需scope guard（B07后强化）。

## D03 通用Modal

账户与设置已用DialogShell，禁止重做。Modal接DialogShell，扩展shell可选head/footer/closeLabel保持旧默认，不套嵌套dialog、不重复标题与关闭键；支持modal尺寸/类既有布局。打开Modal捕获触发元素作returnFocus；关闭/遮罩/Esc都经same onClose，SceneDialog flush不可被绕过。头含头像/可编辑名字不丢。焦点环/aria-modal/inert/portal使用shell已有逻辑。测试SSR接口结构与回调，真焦点/Tab/Esc/还焦点由D01浏览器补验，不冒充真浏览器。

报告docs/superpowers/plans/2026-10-03-admin-dialog-report.md，含文件、关键接口、red/green命令/结果、边界未完成项。只跑admin针对测试与web新/相关测试+typecheck，不重跑全仓。

2026-10-07用户最新策略覆盖此前测试执行要求：子任务仅实现/准备测试和报告，不单独运行测试/typecheck/lint/build；root在多个功能完成后统一总测。历史执行证据保留日期，新收尾不假称已通过。只读规格/质量审查仍可进行。
