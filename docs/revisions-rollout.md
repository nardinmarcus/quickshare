# Share 内容版本切换（#30 / 父 #24 §11 步骤 1–5）

本文是运维手册，不是生产动作已发生的证据。生产切换另需单独授权。

## Contract

- `pages.current_revision` 为 `BIGINT NOT NULL DEFAULT 1 CHECK (> 0)`，`pages.published` 为 `BOOLEAN NOT NULL DEFAULT TRUE`；两者随迁移 `007_share_revisions.sql` 附加加入，已有 Share 保持原 ID、URL、正文与状态。本里程碑不提供任何上下架（unpublish/republish）操作；`published` 持久化并参与备份恢复，但没有任何运行时入口能改变它。
- `share_revisions(share_id, revision)` 保存不可变快照：正文、创建时固定的 `code_type`、标题、简介、Markdown 主题与 `created_at`，外加父规格 §3 要求的行级元数据——`snapshot_hash`（对固定载荷的规范 SHA-256，两 Adapter 一致）、`source`（真实写入路径：`web`/`api`/`clone`/`dashboard-edit`/`dashboard-restore`/`title-backfill`/`baseline-backfill`）、`actor`（可信身份：managed Key 逻辑 ID `api-key:<id>`、`owner-dashboard` 或维护身份；绝不含 Key 明文/cookie/密码/虚构个人身份）与可空 `restored_from`（#33 恢复入口写入来源版本；其他写入为 NULL）。保护、有效期、Favorite Share、浏览量与凭据永远不进正文历史。Share 删除时快照随外键级联清除。
- 网页创建、Share API 创建、克隆都写入 Revision 1；后台内容保存与标题 backfill `--write` 等一切内容写入口在发布事务内推进 `current_revision` 并写快照，不存在绕过版本的无版本写入。版本以 BIGINT 精确递增，JSON 里一律为十进制字符串（含超过 2^53 的值，绝不经过 Number）；相同快照不增版。
- 后台详情显示内容版本；内容保存要求具体强 If-Match `"content:<Share ID>:<Revision>"`。缺失 428（`CONTENT_PRECONDITION_REQUIRED`），弱标签/通配符/列表/裸 token/单引号/错误族/错误 Share 400（`INVALID_CONTENT_REVISION`），陈旧基线 412（`CONTENT_REVISION_CONFLICT`，响应携带当前远端内容投影供差异展示）。内容与访问设置分开保存；兼容组合更新必须内容与访问两类基线都通过才原子提交，任一不符整笔拒绝且无半提交。仪表盘正文载荷保持候选身份：textarea 会把 CRLF/CR 归一为 LF，因此未编辑（或改后撤销回原样）的正文提交原始字节（`page-data` 序列化的 `htmlContent`），实际编辑才提交编辑值——普通保存不虚增版本；「仍要保存我的版本」提交的正是所有者刚比较确认的完整候选（用户元数据 + 原样正文），绝不静默沿用远端正文拼接。创建/存储端不统一换行符。
- 冲突体验为本票交付，不依赖后续历史浏览：失败方稿件保留，差异用本地 vendor 的官方 `diff@9.0.0`（BSD-3-Clause，`public/vendor/diff/`）在 Web Worker 内按纯文本行级比较，Worker 算法预算 1000ms、页面外层终止期限 2000ms；超限显示「差异过大，未完成比较」，绝不把未完成冒充无差异；切换比较对象后旧 Worker 结果按 id 丢弃。差异仅由所有者 dashboard 触发与读取，不产生任何 API Key 管理面。

## 基线切换流程（固定顺序，不可跳步）

1. **向后兼容扩展迁移。**在可信迁移环境以临时 owner 凭据执行 `npm run db:migrate`；再次执行必须全部 skipped（`007` 不得有副作用）。迁移只加列/加表，不回填数据；应用启动与请求仍不执行 DDL。空库/旧库在迁移后保持可用（旧应用忽略新列）。
2. **部署认识维护闸与新协议的兼容应用。**验证全部写入口在暂停时返回 `PUBLISHING_MAINTENANCE` 503；此时部署完成不等于可回填（下一步才是前提）。
3. **暂停并证明旧写入者已退出。**`npm run maintenance -- pause` 成功输出即同事务排空了已进入的发布事务；但**不认识维护闸的旧部署必须先退出可写路径**——停止/隔离旧函数实例、预览域名、定时或手动 CLI 与直连脚本，并保留连接身份、停止时间与 `pg_stat_activity`（按应用身份核对在途写事务与锁状态）的证据。旧代码不取维护锁，pause 无法替它排空。无法证明隔离/排空时，保持维护状态，不继续第 4 步。本流程不提供也不允许自动 pause/resume。
4. **独立基线回填 DML。**在同一受控主机执行：

   ```bash
   npm run backfill-revisions                 # dry-run：只读报告，不要求暂停
   npm run backfill-revisions -- --write      # 要求 live paused=true，否则 BASELINE_WINDOW_REQUIRED
   npm run backfill-revisions -- --write      # 重复运行必须全部 skipped / no Shares are missing Revision 1
   ```

   脚本在同一维护闸事务内核实 `publishing_writes_paused=true`，按原 ID/URL/正文/标题/简介/主题补写 Revision 1（`created_at` 为实际受控捕获时刻，Share 原始创建时间保留在 `pages.created_at`，绝不把升级时正文伪装成创建以来的历史版本）及 `page.revision.backfill` 审计；快照带 `source='baseline-backfill'` 行级来源；不改 `current_revision`（保持 1）、不做任何上下架；发现指针异常（`current_revision ≠ 1` 且缺基线）即 `BASELINE_INCONSISTENT` 整批拒绝。回填后读回：每个 Share 恰有一条 Revision 1 且与投影一致、ID/URL/正文逐字符保持。
5. **部署新写入协议并恢复。**先隔离 Preview 验证（创建写 Revision 1、编辑走 If-Match、冲突保稿与差异、四类内容/主题/移动端），确认没有旧写入者后由人工执行 `npm run maintenance -- resume` 并验证创建/编辑/收藏恢复正常。resume 是人工动作；任何自动化恢复都超出本票授权。

**本票不执行、也不授权生产 pause/回填/resume；第 3–5 步的证据（旧写入者隔离、排空核对、回填读回、resume 后 smoke）是发布门槛，不是本仓库代码可自证的结论。**

## 安全回滚

- 迁移失败：显式 runner 在 COMMIT 前整体回滚，修正后重跑；无请求/启动 DDL，无破坏性 down migration。
- 内容版本投入使用后，**忽略内容基线的旧版本不是安全回滚候选**：它会无版本改写正文并悄悄绕过快照。回滚候选必须保留维护闸、访问版本语义与内容 If-Match 协议；无法提供兼容候选时保持维护状态向前修复。保留 `007` 与台账，不删列、不删 `share_revisions`。
- 恢复旧备份不是重新上线许可：`safeToServe:false`、恢复验证（含 `shareRevisions`/`revisionCurrentPointer` 具名检查与快照/指针/`published` 字段级篡改拒绝）与所有者复核流程见 [备份与恢复](backup-restore.md)；恢复后同样先维持维护/私有状态。

## 本地验证

```sh
# 纯 Node/Memory 套件（清除继承的数据库配置）
env -u DATABASE_URL -u POSTGRES_URL -u DATABASE_MIGRATION_URL \
  -u DATABASE_URL_UNPOOLED -u POSTGRES_URL_NON_POOLING npm test

# PostgreSQL 套件：仅 localhost 且库名以 _test 结尾；destructive 套件串行
env -u DATABASE_URL -u POSTGRES_URL -u DATABASE_MIGRATION_URL \
  -u DATABASE_URL_UNPOOLED -u POSTGRES_URL_NON_POOLING \
  POSTGRES_TEST_URL='postgresql://< isolated >/<name>_test?sslmode=disable' npm run test:postgres
```

覆盖：空库/legacy 两阶段/重复迁移与回填、双连接内容 CAS 竞争、快照写失败与 COMMIT 故障的整笔回滚、精确大版本算术、组合基线原子拒绝、备份新对象/字段专属篡改。并发与竞争必须至少两个独立连接；真实故障用测试专用 trigger/约束注入，不把 mock 等同数据库证明。界面验收使用隔离浏览器与私有合成夹具（双标签冲突、稿件保留、手动处置、四类型/元字段/主题/移动端、Worker 超时与旧结果丢弃），不使用生产或他人标签页。

## 本票不做

历史浏览/恢复/清除、幂等请求记录、grants 与管理 API、上下架、客户端能力（#31–#43）均不在本票范围；`published` 仅有列与备份语义，没有任何应用入口。

## #31 增量：Owner 历史只读面（T07）

在 #30 快照与冲突差异之上，#31 交付所有者的历史浏览/比较/单版预览，全部只读，不新增任何 schema、迁移或持久化字段。

- **仓储层**：两 Adapter 新增 `listContentRevisionPage(shareId, { limit, offset })`（默认 20、上限 100、按精确 BIGINT 版本号倒序，列表投影仅含 `share_id/revision/created_at/source/restored_from`（迁移 `009` 起另加只读墓碑标记 `purged_at`），SQL 与内存路径都不读正文）与 `getContentRevision(shareId, revision)`（先以 `isContentRevision` 校验再读单行完整快照）。旧 `listContentRevisions`（升序、含正文，供 backfill/测试）保持不变。
- **路由**（全部在 `/admin` 的 `private, no-store` 之下，认证先于任何敏感读取）：
  - `GET /admin/pages/:id/history`：`requireDashboardAdmin`，服务端渲染历史页（首页元信息表格 + 上一页/下一页链接）。
  - `GET /admin/pages/:id/revisions`：`requireDashboardApiAdmin` 401 JSON，仅元信息分页；`page/limit` 非法回退默认，`limit>100` 截到 100。
  - `GET /admin/pages/:id/revisions/:revision`：`requireDashboardApiAdmin`，单版完整快照 JSON；非法版本号 400（`INVALID_CONTENT_REVISION`），不存在 404。
  - `GET /admin/pages/:id/revisions/:revision/preview`：`requireDashboardAdmin`，复用 `prepareSandboxContent` + `renderSandboxedDocument`；不传 `pageUrl`（无公开统计脚本）、不传 `viewEventUrl`（无浏览计数）、`socialImageUrl` 为空；srcdoc 转义、无 `allow-same-origin`、`no-referrer`，直接打开 URL 与内嵌同权安全。
  - 前端 cookie、create-only managed/legacy API Key、已解锁公开访问都不是历史身份；只读操作不触碰 `current_revision`/`access_revision`/保护/Favorite/浏览量/发布状态与快照行；写维护暂停时仍可读。空历史如实呈现，不猜测旧历史。
- **前端**：`views/admin-page-history.ejs` + `public/js/admin-history.js` 沿用现有 shell 与 CSS 变量；分页用服务端链接（无 JS 也可用）；比较/预览/原稿的每个异步流持单调 token，旧 HTTP/Worker 结果一律丢弃；未完成比较显示「差异过大，未完成比较」并保留分别查看原稿的入口，绝不冒充无差异；meta 比较用 `SourceDiff.renderMetaChanges` 的新可选 `{ previousLabel, currentLabel }` 以「版本 A/版本 B」标注两侧（默认值保持 #30 冲突文案，向后兼容）。
- **渲染分块**：`SourceDiff.renderParts` 改为有界分块渲染（首块同步、余量经 `requestAnimationFrame`/`setTimeout` 续渲染，`MAX_RENDERED_ROWS=2000` 截断并显式提示「仅显示前 2000 行」，截断不是「无差异」）；新增 `SourceDiff.cancelRender` 供切换/关闭时取消在途渲染。Worker 算法预算 1000ms、外层终止期限 2000ms、本地 vendor 与 diff@9.0.0 均不变。
- **rework 增量（bounded rework R1–R4）**：历史比较输入为自由版本号输入+datalist（可跨页、超过 2^53 的版本号逐字传递，缺失/非法版本有带版本标签的明确状态，比较面板提供双方「原稿/预览」入口）；Worker 错误事件按 worker 代际归属（旧/已终止 worker 的迟到 error 不会 reject 新 worker 的比较）；`SourceDiff.compare` 的 reject 在两个消费者中归为明确的「差异比较失败，未完成比较」终态（与「差异过大」区分，稿件/面板不卡在比较中，旧目标的拒绝不覆盖新目标）；后台详情候选正文提取为单一 `candidateBody()` 解析（发送、冲突比较、本地原稿三处同源，未编辑/回退送原始字节，展示=提交）；冲突面板提供双方完整只读原稿（冻结远端快照+本地解析候选，带版本身份），取代「打开公开页面」的旧提示。

## #33 增量：Owner 恢复与保存幂等（T09）

在 #30/#31 之上，#33 交付两条写路径：所有者恢复历史版本，以及后台内容保存的操作标识幂等。无新迁移（复用 007 `restored_from` 与 008 `publish_operations`）。

- **恢复语义**：`POST /admin/pages/:id/restore`（`requireDashboardApiAdmin`，未登录返回 401 JSON；CSRF + 必需的 `Idempotency-Key` + `If-Match` 当前内容标签 + JSON `{ revision }`）。来源快照必须存在且带载荷——缺失或未来被清除（无载荷墓碑）的来源一律 `404 RESTORE_SOURCE_INVALID`，绝不当作空内容。写入新当前 Revision（`source='dashboard-restore'`、`actor='owner-dashboard'`、`restored_from=来源版本`），同事务写入审计 `page.restore`。与当前快照相同的恢复是批准的 no-op：`changed:false`、不产生新版本，但记录成功操作。恢复不改变 URL、密码、有效期、`access_revision`、发布状态、Favorite 或浏览量。
- **恢复确认 UI**：历史页每行新增「恢复」按钮；确认对话框同时标明来源版本与当前版本，并明示「访问策略不变」。成功产生新版本或确认旧结果后重载页面；fresh no-op 留下可见的「未产生新版本，已确认完成」。失败不重载、不清空原请求；`412` 显示远端版本但保持原授权基线，所有者需主动刷新并核对最新状态后重新选择恢复，不自动重试。
- **保存/恢复幂等**：两个动作复用 #32 操作台账，`action='content-update'|'restore'`、`target=Share ID`，命名空间仍为 `dashboard-session:<fingerprint>`。摘要覆盖预期版本、字段存在性与规范化输入（content-update 含精确候选字节；Markdown 主题以提交字面量入摘要，避免事务前读 Share）。重放先于任何 Share 读与 CAS：已提交请求以旧 If-Match 重放确认原结果（`replayed:true`，响应内容来自提交时的快照行 + 台账记录），不误报首次失败；同标识不同输入 `409`；结果已删除 `410`。content-update 的加密回执存 `changed` 与提交时的策略展示值；生成密码的回显规则与 #32 创建相同（访问策略未变才回显）。
- **前端身份**：`publishing-request.js` 新增按（kind, share）分桶的后台意图：相同草稿+基线重试复用原请求标识；草稿变化轮换新标识并提示；属于其他后台会话（session tag 不符）的意图被阻止认领，保持只读。保存/恢复的未确认（丢响应）状态保留原稿与原 ID，`401/403/409/410/412/428` 不自动重试、不换基线；详情页编辑表单显示四态待定状态行。组合保存（内容+访问字段）与纯访问保存不接受请求标识（`400 UNSUPPORTED_REQUEST_ID_SCOPE`），避免部分重放。
- **验证入口**：Memory HTTP（history-routes/admin-routes）、前端 VM（content-revision-ui/history-ui/publishing-request-ui）、真实 PostgreSQL（postgres-operations：两条不同 backend PID 的竞争、COMMIT 时失败与成功 COMMIT 后响应失败的分别注入、连接切断、旧标签重放、no-op、大数版本、维护闸）。备份 drill fixture 包含 `restore`/`content-update` 操作行与具名回执篡改。浏览器验收需另外提供绑定源码与新 listener 的编辑/恢复、丢响应重试、no-op、冲突保稿和移动端截图；本手册不是这些检查已通过的证明。

## #34 增量：Owner 清除非当前版本（T10）

在 #30/#31/#33 之上，#34 交付所有者在后台永久清除一个非当前版本：同事务移除该版本在线载荷与指向它的敏感操作回执，只保留不含内容的墓碑。无 API Key 或 CLI 入口。

- **迁移 `009_share_revision_purge.sql`**：`share_revisions` 增加 `purged_at BIGINT` 并将 `html_content`、`snapshot_hash` 放宽为可空（仅清除路径写 NULL；存活行永远带真实字节，空正文是空字符串，绝不与墓碑混淆）；`publish_operations` 增加 `purged_at BIGINT`。`deleted_at` 仍专属于整份 Share 删除墓碑（#32），两种破坏性生命周期在备份与审计中可区分。迁移保持 additive，无 down migration。
- **清除语义**：`POST /admin/pages/:id/revisions/:revision/purge`（`requireDashboardApiAdmin` + CSRF + JSON `{ confirm: "<Share ID>:<Revision>" }`，确认串必须逐字命名目标）。发布事务内先锁 Share 行，再在同一锁内复检当前指针：当前版本 409（`CURRENT_REVISION_PURGE_FORBIDDEN`），绝不依预先读取放行。清除将载荷四字段与 `snapshot_hash` 置 NULL 并写 `purged_at`；同事务把所有 `result_share_id`+`result_revision` 精确指向该版本的 `publish_operations` 回执置 NULL 并记 `purged_at`（跨 actor 命名空间；其他版本与其他 Share 的回执不动，绝不改写 `result_revision`）。同事务写审计 `page.revision.purge`（仅非内容身份字段）。重复清除同一墓碑是 `200 changed:false alreadyPurged:true` 的确认成功：无重复副作用、不新增审计，也绝不表现为失败。
- **墓碑读面**：单版读取与预览对墓碑返回 410（`REVISION_PURGED`，`private, no-store`），只确认非内容身份；历史列表每行携带 `purged` 布尔（服务端渲染「已清除」状态行，原稿/预览/恢复/清除动作全部移除）。恢复来源校验要求字符串载荷，墓碑一律 `404 RESTORE_SOURCE_INVALID`；清除与恢复/保存的竞争在同一 Share 行锁内串行，不能绕过当前版本或来源检查。版本号永不复用。
- **重放闭环**：提交结果的版本随后被清除时，create/content-update/restore 的重放一律 `410 RESULT_UNAVAILABLE`（确认操作发生过，但不回传任何载荷或回执字节、不重建）。
- **前端**：`admin-history.js` 新增清除对话框——逐字确认输入门控确认按钮，Enter（确认匹配时）与 Escape（空闲时）键盘可达，busy 期间两个键与取消均失效；成功文案只承诺「在线保存的该版本内容已清除、仅保留墓碑」，并明示其他 Revision 中相同片段、离线备份与接收者下载不受影响；已清除行的信息动作与比较 410 目标给出精确状态，绝不冒充「无差异」。
- **备份**：verify 清单新增 `revision-purge-tombstones` 与 `operation-receipt-purges`；`shareRevisions` 对比列含 `purged_at`，墓碑上任何载荷字节复活按字段具名失败；`page.revision.purge` 进入快照点后硬撤销审计词表。drill 夹具含一条真实墓碑与一条回执被清除的操作，具名篡改（墓碑复活/回执复活）必须失败、revert 后验 VERIFY 通过。
- **验证入口**：Memory HTTP（revision-purge）、前端 VM（revision-purge-ui：确认门控、Enter/Escape、busy 保护、拒绝与网络未知、重复清除文案、410 状态）、真实 PostgreSQL（postgres-purge：迁移 009 列、事务原子性注入回滚、双连接行锁竞争、BIGINT 精确版本、跨命名空间回执隔离、重复幂等）、备份集成（postgres-backup 墓碑/回执具名篡改）。浏览器验收需另外提供绑定源码的逐字确认、当前版本禁用与 390/明暗截图；本手册不是这些检查已通过的证明。

## #35 增量：Owner 下架/重新发布与公开语义统一（T11）

在 #30–#34 之上，#35 交付所有者的发布状态生命周期与统一的公开投影。无新迁移（复用 007 的 `pages.published` 与 004 的 `access_revision`）。无 API Key 或 CLI 入口（`share:publish` 作用域与 Key 上下架接口属 #39）。

- **转换语义**：`POST /admin/pages/:id/unpublish|republish`（`requireDashboardApiAdmin` + CSRF + 必需 `Idempotency-Key` + 必需 `expectedAccessRevision`）。发布事务内锁 Share 行、锁内复检访问基线（陈旧 412），同一条语句翻转 `published` 并推进 `access_revision`——密码、有效期、内容版本、历史、Favorite、浏览量一律不动；Share 缺失为 `404 SHARE_NOT_FOUND`。同状态重复（新请求标识）记录 `changed:false` 成功结果：不推进版本、不重复审计。
- **重放闭环**：发布状态操作的结果是状态转换而非内容——重放只要求 Share 仍存在且回执可读，不依赖提交时内容版本的可用性（该版本随后被清除不能否定已确认的下架）。丢响应重试携带原标识与原（已陈旧）基线，先于任何 CAS 确认已提交结果（`replayed:true`，`accessRevision` 为提交时值）；同标识不同基线 409。
- **公开语义统一**：公开读缝（`getPublicById`）对下架 Share 返回空——视图页、OG、元信息 API、密码 POST 全部走中性「不存在」404，任何 404/410 路径无标题/简介/正文衍生信息。下架先于过期判定：过期只作用于已发布 Share，过期+下架读作 404。浏览事件的条件 UPDATE 带 `published` 条件：下架不计数（404），写维护暂停时同样拒绝。两个转换都推进访问版本，#25 版本绑定 Cookie 在任一转换后失效；重新发布沿用原 URL，密码与有效期不变。
- **Owner 保留面**：下架/过期 Share 的读取、编辑、历史、恢复、收藏、克隆全部保持（#31–#34 语义不变）；仅公开投影收窄。列表行与详情页渲染已发布/已下架状态与切换操作，每次点击携带行内展示的访问版本作为基线与 dashboard 命名空间的操作标识；确认后重载真实服务端状态，丢响应保留原请求标识以原请求重试。
- **审计与备份**：`page.unpublish`/`page.republish` 进入快照点后硬撤销审计词表；备份 drill 夹具写入真实下架终态（`published=FALSE` + 推进后的 `access_revision='9007199254740994'`）与一条 #35 `unpublish` 账本行，具名篡改（复活已下架 Share / 篡改推进后的访问版本）必须失败、revert 后 VERIFY 回到 exit 0。忽略 `published` 的旧应用不是安全回滚候选。
- **验证入口**：Memory HTTP（publication-state：路由合同、统一 404/410/200 密码页、旧 Cookie 不复活、维护闸、Owner 保留面）、前端 VM（publication-state-ui：列表/详情渲染、意图复用、412 不静默换基线）、真实 PostgreSQL（postgres-operations：双 backend PID 转换竞争与内容族共存、COMMIT 时注入失败回滚、BIGINT 推进精确、Cookie 复活拒绝）、备份集成（postgres-backup：下架终态成对恢复断言、published 具名篡改 exit1→revert exit0）。浏览器验收需另外提供绑定源码的切换、旧 Cookie 视图、404/410 渲染与 390/明暗截图；本手册不是这些检查已通过的证明。
