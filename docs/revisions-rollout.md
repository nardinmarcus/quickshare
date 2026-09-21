# Share 内容版本切换（#30 / 父 #24 §11 步骤 1–5）

本文是运维手册，不是生产动作已发生的证据。生产切换另需单独授权。

## Contract

- `pages.current_revision` 为 `BIGINT NOT NULL DEFAULT 1 CHECK (> 0)`，`pages.published` 为 `BOOLEAN NOT NULL DEFAULT TRUE`；两者随迁移 `007_share_revisions.sql` 附加加入，已有 Share 保持原 ID、URL、正文与状态。本里程碑不提供任何上下架（unpublish/republish）操作；`published` 持久化并参与备份恢复，但没有任何运行时入口能改变它。
- `share_revisions(share_id, revision)` 保存不可变快照：正文、创建时固定的 `code_type`、标题、简介、Markdown 主题与 `created_at`，外加父规格 §3 要求的行级元数据——`snapshot_hash`（对固定载荷的规范 SHA-256，两 Adapter 一致）、`source`（真实写入路径：`web`/`api`/`clone`/`dashboard-edit`/`title-backfill`/`baseline-backfill`）、`actor`（可信身份：managed Key 逻辑 ID `api-key:<id>`、`owner-dashboard` 或维护身份；绝不含 Key 明文/cookie/密码/虚构个人身份）与可空 `restored_from`（本票恒为 NULL，不存在恢复入口）。保护、有效期、Favorite Share、浏览量与凭据永远不进正文历史。Share 删除时快照随外键级联清除。
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

- **仓储层**：两 Adapter 新增 `listContentRevisionPage(shareId, { limit, offset })`（默认 20、上限 100、按精确 BIGINT 版本号倒序，列表投影仅含 `share_id/revision/created_at/source/restored_from`，SQL 与内存路径都不读正文）与 `getContentRevision(shareId, revision)`（先以 `isContentRevision` 校验再读单行完整快照）。旧 `listContentRevisions`（升序、含正文，供 backfill/测试）保持不变。
- **路由**（全部在 `/admin` 的 `private, no-store` 之下，认证先于任何敏感读取）：
  - `GET /admin/pages/:id/history`：`requireDashboardAdmin`，服务端渲染历史页（首页元信息表格 + 上一页/下一页链接）。
  - `GET /admin/pages/:id/revisions`：`requireDashboardApiAdmin` 401 JSON，仅元信息分页；`page/limit` 非法回退默认，`limit>100` 截到 100。
  - `GET /admin/pages/:id/revisions/:revision`：`requireDashboardApiAdmin`，单版完整快照 JSON；非法版本号 400（`INVALID_CONTENT_REVISION`），不存在 404。
  - `GET /admin/pages/:id/revisions/:revision/preview`：`requireDashboardAdmin`，复用 `prepareSandboxContent` + `renderSandboxedDocument`；不传 `pageUrl`（无公开统计脚本）、不传 `viewEventUrl`（无浏览计数）、`socialImageUrl` 为空；srcdoc 转义、无 `allow-same-origin`、`no-referrer`，直接打开 URL 与内嵌同权安全。
  - 前端 cookie、create-only managed/legacy API Key、已解锁公开访问都不是历史身份；只读操作不触碰 `current_revision`/`access_revision`/保护/Favorite/浏览量/发布状态与快照行；写维护暂停时仍可读。空历史如实呈现，不猜测旧历史。
- **前端**：`views/admin-page-history.ejs` + `public/js/admin-history.js` 沿用现有 shell 与 CSS 变量；分页用服务端链接（无 JS 也可用）；比较/预览/原稿的每个异步流持单调 token，旧 HTTP/Worker 结果一律丢弃；未完成比较显示「差异过大，未完成比较」并保留分别查看原稿的入口，绝不冒充无差异；meta 比较用 `SourceDiff.renderMetaChanges` 的新可选 `{ previousLabel, currentLabel }` 以「版本 A/版本 B」标注两侧（默认值保持 #30 冲突文案，向后兼容）。
- **渲染分块**：`SourceDiff.renderParts` 改为有界分块渲染（首块同步、余量经 `requestAnimationFrame`/`setTimeout` 续渲染，`MAX_RENDERED_ROWS=2000` 截断并显式提示「仅显示前 2000 行」，截断不是「无差异」）；新增 `SourceDiff.cancelRender` 供切换/关闭时取消在途渲染。Worker 算法预算 1000ms、外层终止期限 2000ms、本地 vendor 与 diff@9.0.0 均不变。
- **rework 增量（bounded rework R1–R4）**：历史比较输入为自由版本号输入+datalist（可跨页、超过 2^53 的版本号逐字传递，缺失/非法版本有带版本标签的明确状态，比较面板提供双方「原稿/预览」入口）；Worker 错误事件按 worker 代际归属（旧/已终止 worker 的迟到 error 不会 reject 新 worker 的比较）；`SourceDiff.compare` 的 reject 在两个消费者中归为明确的「差异比较失败，未完成比较」终态（与「差异过大」区分，稿件/面板不卡在比较中，旧目标的拒绝不覆盖新目标）；后台详情候选正文提取为单一 `candidateBody()` 解析（发送、冲突比较、本地原稿三处同源，未编辑/回退送原始字节，展示=提交）；冲突面板提供双方完整只读原稿（冻结远端快照+本地解析候选，带版本身份），取代「打开公开页面」的旧提示。
