# 服务器管理台（顺序 100）

Node ≥22.5，使用内置 node:sqlite。A 形态已接入正式 Windows：独立 WinSW 服务 DramatisSyncAdmin，仅监听127.0.0.1:8788，经既有管理SSH隧道访问；不挂 /sync，不配置公网反代。真实地址、身份和token只在 gitignore 的 deploy/LOCAL-NOTES.md。

## 功能与边界

- 账户ID／显示名＋空间关联、搜索分页、创建时间、含墓碑记录数、配额计量、密文JSON长度、集合／设备统计、同步存活与备份文件元数据。
- 已认领空间可改服务器登记显示名；未认领空间只能配容量，不能代认领。所有者登录／注册并明确同意后，用现有同步凭证登记最小资料。
- 单空间容量继承默认或自定义0～1024 GB（1 GB = 1024³字节），在同步写事务中执行。0禁止用量增长；降低至已用量以下保留数据，允许不增长的替换／缩减。记录数、请求体、限流护栏继续执行。
- 没有删除、数据库下载、恢复、重启、VIP或托管API入口；不显示／导出实体正文、sealed、凭证、钥匙封装、API Key；无管理员解密能力。

容量是最新同步记录的计量上限，含行元数据与密文JSON，不是RAM、SQLite文件、WAL或备份的磁盘大小。设备标识不代表在线设备；客户端更新时间不代表最近服务器写入。

## 每次运维

1. 用已配置的跳板与Windows身份开SSH转发：

       ssh -N -T -J <旧机SSH别名> -p 22023 -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:8788:127.0.0.1:8788 <Windows用户>@127.0.0.1

2. 打开 http://127.0.0.1:8788/，输入管理token。它只在页面内存保存，退出／刷新后重输。转发端口必须与管理端口相同。
3. 点“查看”，编辑后“预览修改”，核对前后值，输入完整空间句柄再“备份并保存”。票据2分钟有效、只能消费一次。结束时退出网页并关隧道。

服务端强制 VACUUM INTO 到唯一.partial文件，经quick_check改为.bak；持久追加意图审计，再拿写锁重检世代及资料／策略版本，原子保存。备份或意图审计失败不写。提交成功但结果审计失败明确返回 applied: true 与提示，不能当作未提交盲目再点。并发修改、过期或错误句柄需重新预览。无网页备份下载。

## 配置与Windows服务

DRAMATIS_ADMIN_DATA／_TOKEN／_AUDIT必填；_HOST只允许127.0.0.1；_PORT默认8788，_SYNC_PORT默认8787；_WRITE默认0只读，1编辑且必须有_BACKUPS。_DEFAULT_MAX_MB默认256，**必须与同步服务 DRAMATIS_SYNC_MAX_MB 或其默认值一致**；更改同步全局额度时更新此值并重启管理服务。

独立目录放dist/、web/、start.mjs及包含 type=module 的package.json。参考 windows/DramatisSyncAdmin.xml.example 替换绝对路径，WinSW可放统一服务目录；Node用 --env-file 读取受保护环境文件。使用已核验来源的Node／WinSW。

随机token由32字节随机数生成，不用同步凭证，不写仓库／URL／服务日志／截图／浏览器存储。Windows用NTFS ACL：

- 环境文件仅管理员、SYSTEM、指定服务身份可读；服务身份不能改程序或环境。
- 数据目录按SQLite实际需要支持WAL及受控写；查询连接仍readOnly＋query_only，不迁移、不创建不存在的库。
- 程序只读执行，审计／操作备份目录独立可写。设置目录继承后检查**子文件实际ACL**；不能递归移除继承后留下空DACL。
- 正式使用既有非管理员LocalService，系统内其它LocalService服务共享该身份，尚未隔离为专属账户；应用审计只追加，但不是对服务身份不可改写的存储。

正式操作备份放独立目录，与既有每6小时、30份的生产定时备份分开，保留原生产备份权限／策略。操作快照目前**不自动清理**，需监测磁盘并另定保留策略；不要覆盖旧快照或生产库。

## 接口与数据

读接口：GET /api/overview、/api/spaces?q=&limit=&offset=、/api/spaces/<spaceHandle>，单页与设备详情各最多100。
写接口：POST /api/changes/prepare、/commit；仅启用编辑后开放，Bearer token＋精确回环Origin、JSON白名单、4KB上限，无任意SQL／路径／凭证字段。

account_profiles存最小运营资料，space_policies存世代绑定的自定义字节额度与版本，均由同步宿主创建。随机epoch变化使旧资料／策略失效；重复自助认领不会覆盖管理员名称。用户自助POST /accounts/claim沿用公开同步通道，要求所有权证明与明确同意，它不是管理接口。

SQL显式投影，sealed仅在SQL内聚合长度。审计不记姓名、内容、token、请求体、凭证或封装；写审计额外只记操作ID、目标句柄、备份文件名、数值额度和结果。CSP、no-store、严格Host／Origin、无公网CORS及查询审计失败关闭保持。

## 验收与回滚

    pnpm typecheck
    pnpm lint
    pnpm test
    pnpm build
    pnpm build:sync-server
    node tools/sync-admin/smoke.mjs

smoke仅在系统临时目录造假库，监听回环17880／17887／17888；fixture-*是公开测试假值。Ctrl+C停止，保留目录便于核对。正式编辑测试只用隔离库。顺序100证据见EVAL第九十二节，包括正式Node22、WinSW／ACL、SSH与公网隔离。

回滚先停独立管理服务并关转发，再换回保留的同步／网页程序；表留存，不删表／不覆盖生产库。**旧同步程序不执行单空间额度**，回退前明确这一影响。生产恢复须另行停写、保存当前库与WAL，在独立路径校验后人工切换；本轮验证快照一致性，未做生产恢复演练。实际回滚目录在私有笔记。

后续独立顺序做VIP权益（有效期／额度／撤销）、服务目录与网关；Key只在服务端秘密配置，托管输入须另行说明发给运营服务／模型提供方。可选Tauri壳复用管理API。任务73的全面部署文档漂移仍待办。
