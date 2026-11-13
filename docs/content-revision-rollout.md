# Content Revision 上线与回滚说明（T06 / Issue #30）

## 机制

- 每个 Share 新增内容版本 `current_revision`（数据库 `BIGINT`，JSON 中为十进制字符串），由迁移 `007_share_revisions.sql` 引入；`published`（`BOOLEAN NOT NULL DEFAULT TRUE`）记录发布状态，本票不提供取消发布操作。存量 Share 的 `current_revision` 在迁移后为 `NULL`（尚无基线），由基线回填补齐为 `1`（见下方上线顺序），应用代码不会为 `NULL` 静默代入任何版本。
- 每次内容变更同步写入三样东西，且在同一事务内完成：物化投影（`pages` 行本身）、不可变快照（`share_revisions` 表中 `(share_id, revision)` 一行）、审计（`page.content.update`）。没有第二条绕过 Revision 的内容写路径：网页创建、Share API 创建、后台克隆都写 Revision 1 基线快照；离线写标题脚本 `backfill-page-titles.js --write` 在 007 结构下同样走版本化写入。
- 快照只包含内容本身：正文字节（精确保存，含 CRLF）、定型 `code_type`、标题、描述、Markdown Theme Preset；另有完整性哈希 `snapshot_hash`（对 Share ID + 版本 + 内容载荷计算）、操作来源/身份（`source`、`actor_type`、`actor_id`）、可空的恢复来源 `restored_from_revision`（本票无恢复操作，恒为 `NULL`）与捕获时间。保护、有效期、收藏、浏览量是访问/运行状态，永不进入内容历史。
- 版本单调递增；保存内容与当前快照逐字节相同时不推进版本（响应 `contentChanged: false`，不写新快照）。
- 内容强 ETag 格式固定为 `"content:<Share ID>:<Revision>"`（含双引号的强校验形式）。

## 后台保存协议

- 后台详情页显示内容版本（Revision 与 ETag）与发布状态。内容与访问设置分开保存：内容保存只提交内容字段并带 `If-Match`；访问保存仍按 T01 提交 `expectedAccessRevision`（见 [访问版本说明](access-revision-rollout.md)）。两套前置条件互相独立、可以组合：组合保存时任一前置条件失败，整个保存被拒绝、不落库任何一部分。
- 内容保存的前置条件校验顺序：写维护暂停时先返回 503 `maintenance`（T04 闸口优先于一切前置条件校验）；`If-Match` 缺失返回 `428 content_precondition_required`；弱校验、通配符、列表、裸写/单引号、访问族标签、他人 Share 的标签、陈旧版本一律返回 `412 content_conflict`，响应体携带远端当前快照（`current`）与当前版本/ETag。服务端从不替请求方填入最新版本。
- 冲突时浏览器保留用户稿件原文（字节精确，含 textarea 的 CRLF），展示远端与稿件的纯文本行级差异，并由用户显式二选一：「放弃我的稿件，加载远端最新版」或「以我的版本保存」（后者以冲突响应给出的新 ETag 重新提交原稿）。不做自动合并/变基。
- 差异比较使用本地固定版本 jsdiff（`diff@9.0.0`，`public/js/vendor/` 字节级 vendoring，无 CDN），在 Web Worker 中运行：算法预算 1000ms，主线程外层期限 2000ms。超限或 jsdiff 中止时显示「差异过大，未完成比较」，绝不把未完成的比较显示成「无差异」；切换比较目标会丢弃旧结果，迟到的 Worker 回包被忽略。
- 授权元数据（`GET /api/pages/:id`）在访问有效时附带 `contentRevision` 字段与内容 `ETag` 响应头；锁定 Share 的中性投影两者都不带（T02 语义不变）。

## 上线顺序（父规格 #24 §11，严格按序）

1. 备份数据库（见 [备份与恢复](backup-restore.md)）；生产切换需要另行明确指令，本票不执行生产迁移或部署。
2. 运行 `npm run db:migrate` 应用扩展迁移 `007`（只加列/加表，可重复运行；旧代码忽略新列可以继续运行）。
3. 部署理解 Revision 协议、且写路径经过写维护闸的代码。
4. 按 [写维护手册](maintenance.md) 进入写维护：`npm run db:maintenance -- pause`，等待在途写入排空（暂停返回即证明已排空）。
5. 在维护窗口内运行基线回填：`npm run db:backfill-revisions`。该脚本要求实例已处于暂停状态（未暂停直接拒绝），自身不暂停也不恢复；它为每个 `current_revision IS NULL` 的 Share 写 Revision 1 基线快照，捕获时间为回填实际运行时刻（不伪造为 Share 创建时间），ID/URL/正文/状态原样保留；可重复运行，第二遍全部跳过。
6. 核对回填报告（`baselined`/`skipped` 计数）后退出维护：`npm run db:maintenance -- resume`。

注意顺序不可交换：基线 DML 不放进迁移运行器，迁移也不得自动暂停/恢复。

## 回滚红线

- **禁止回滚到不写 Revision 快照的旧代码后又切回**：中间产生的内容变更会没有快照、指针与投影不一致；核对（`db:verify-backup` 的 Revision 完整性检查）会因此报错。
- 回滚应用代码时保留 `007` 的列与 `share_revisions` 表不删；删除等于销毁全部内容历史。
- 已推进的 `current_revision` 保持单调，不重置为 `1`；快照行永不修改（含回滚期间）。
- 恢复备份时 Revision 对象与其他对象同等核对：`current_revision` 指针（含 64 位精确值）、快照行摘要、快照哈希重算、指针快照与物化投影一致性都在 `db:verify-backup` 的核对范围内；恢复库照常 `safeToServe: false`。
