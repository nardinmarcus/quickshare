# 备份与恢复（原生一致性备份）

QuickShare 有两类导出/备份产物，用途完全不同：

| 产物 | 来源 | 包含 | 能否独立恢复 |
| --- | --- | --- | --- |
| **清单导出**（`/admin/pages/export`） | 管理后台「导出清单」按钮 | 仅元数据：ID、标题、简介、类型、保护/收藏状态、时间字段；**不含 Share 正文**，不含凭据材料 | **不能**。它只是一份元数据清单，用于盘点与对账 |
| **原生一致性备份**（`npm run backup:db`） | PostgreSQL `pg_dump`（custom 格式） | 正文、配置、保护状态、Key、审计、站点设置、迁移台账的完整可恢复快照 | 能，且必须按本文流程先在隔离库验证 |

## 可重复恢复检查（推荐入口）

```bash
npm run backup:check
```

该命令端到端完成一次完整演练，并输出快照点与真实耗时：

1. 启动两台仅绑定 `127.0.0.1` 的一次性 PostgreSQL 17 容器（`issue27-pg-src` / `issue27-pg-restore`），创建 `issue27_src_test` / `issue27_restore_test` 数据库（执行者专属环境可用 scratch harness 覆盖 `FIXTURE` 的运行地址/身份后再 `runDrill`，生产源码不携带执行者身份）；
2. 在源库执行真实迁移并植入合成夹具（四类页面、主题、收藏、密码保护、过期、managed Key、审计、站点设置；迁移 `007` 起还包含内容 Revision 快照、超过 2^53 的精确 `current_revision` 指针与非默认 `published=FALSE` 页面；迁移 `008` 起还包含发布操作记录：创建回执、Dashboard restore receipt 与恢复来源、managed-Key restore receipt 与来源、Key content-update receipt，以及删除墓碑；迁移 `009` 起还包含 #34 清除夹具：一条真实清除墓碑——载荷与快照哈希为 NULL、`purged_at` 已记录——以及一条结果版本即该墓碑的 `restore` 操作，其回执已按 Share+Revision 清除并带 `purged_at`；迁移 `010` 起还包含 #36/#38 授权夹具：Key 的非默认 scopes 与 auto-grant 标记，以及一条指向主题 Share 的真实 read+update 授权——即轮换存活夹具）；
3. `scripts/backup-db.js` 执行 `pg_dump -Fc`，记录快照点（时间戳 + WAL LSN）与耗时；
4. `scripts/restore-db.js` 校验 dump SHA-256 后用 `pg_restore` 重建隔离库，记录耗时；
5. `scripts/verify-backup.js` 用两条独立连接核对恢复结果，输出验证报告。

演练使用的会话密钥与密码全部是脚本内定义的合成值；真实 secret 与加密材料不进入夹具、日志或 Issue。演练只创建/停止/删除自己命名的一次性容器，不触碰其他容器或共享引擎。

2026-09-21 实测（OrbStack 29.4.0，postgres:17-alpine，server 17.11 / pg_dump 17.11）：snapshot `0/1A8ACB0`，backup 209ms，restore 183ms，verify 82ms，验证全绿。

## 手动分步执行

```bash
# 1. 备份（默认只接受 localhost 且库名以 _test 结尾）
npm run backup:db -- --url 'postgresql://postgres:pw@127.0.0.1:5541/issue27_src_test' \
  --output-dir /tmp/qs27-backup --docker issue27-pg-src

# 2. 恢复到另一台隔离库（自动校验 dump 摘要；目标库必须不同于备份源库）
npm run restore:db -- --manifest /tmp/qs27-backup/quickshare-backup-*.manifest.json \
  --target-url 'postgresql://postgres:pw@127.0.0.1:5542/issue27_restore_test' \
  --docker issue27-pg-restore --output /tmp/qs27-backup/restore-manifest.json

# 3. 验证（需要夹具 synthetic secret；报告写入 *.verification.json）
#    注意：布尔 flag（如 --reconciled）不接值；报告不会输出“not-required”，
#    重新启用任何恢复内容前必须由所有者复核并显式传入 --reconciled。
npm run verify:backup -- --source-url <src> --restore-url <restore> \
  --manifest <manifest> --fixture fixture.json \
  --session-secret <synthetic-secret> --output verification.json --reconciled
```

若宿主机没有匹配 major 的 `pg_dump` / `pg_restore`，用 `--docker <container>` 在同名版本容器内执行；也可用 `--tool-bin` 显式指定二进制。脚本强制「源服务器、dump 工具、restore 工具」三者 major 一致（CI 使用 `postgres:17-alpine`），不一致立即失败。

## 验证覆盖范围（不是只对行数）

验证报告逐项核对，任何一项不符即失败（exit 1）：

- 正文 SHA-256 摘要（逐页对比，漂移消息中给出两侧摘要）；
- 页面 ID 集合（缺失/多出均报告）；
- `pages` 全行逐列对比（含 `markdown_theme`、`is_favorite`、`expires_at`、`view_count` 等；新增加的持久化列会自动进入对比列清单并在报告中显式列出）；
- Markdown Theme Preset、Favorite Share、有效期；
- 密码**校验与回显**双重能力：恢复库上 `password_hash` 可验证夹具密码，`encrypted_password` 可用夹具会话密钥解密回显；
- managed Key 行与 secret 校验，显式比较 `credential_version`；迁移 `006` 后夹具使用 `'9007199254740993'`，验证原生恢复的 BIGINT 十进制字符串保真及仅版本篡改时失败；
- Key scopes 与逐 Share 授权（#36–#39）：夹具 Key 携带非默认 `scopes = ["share:create","share:read","share:update","share:publish"]` 与 `auto_grant_new_share_edit = TRUE`，并包含一条指向主题 Share 的真实读取+编辑+上下架授权。该授权即轮换存活夹具 —— Key 行的 `credential_version` 已远超轮换一次的值，而授权仍绑定同一逻辑 Key ID。恢复库单独篡改 scope 集合或授权位（`can_read`/`can_update`/`can_publish`）都必须按字段与 `(api_key_id, share_id)` 具名失败（exit 1）；
- 审计日志（快照点两侧一致）；
- 发布操作记录（迁移 `008` 起的 `publish_operations` 全表逐列对比：`(actor_namespace, request_id)` 主键、HMAC 请求摘要、加密回执 `receipt_encrypted`、删除墓碑 `deleted_at`；迁移 `009` 起加入回执清除时刻 `purged_at`。夹具含创建回执、Dashboard restore receipt、managed-Key restore receipt（都只含 changed/sourceRevision 等最小结果）、一条删除墓碑、一条 #34 restore 结果回执被清除的操作（`receipt_encrypted=NULL`、`purged_at` 已记录）与一条 #39 managed-Key `unpublish` no-op 操作（目标为 #35 已下架 Share，回执 `{changed:false, published:false}`，访问版本精确）；恢复库单独篡改 live receipt、墓碑回执或 `purged_at` 时 `publishOperations` 检查必须按字段与 request id 具名失败；
- 内容快照墓碑（迁移 `009` 起的 `share_revisions.purged_at`）：墓碑行按身份/来源/时间/`purged_at` 列对比；任何载荷或快照哈希字节在墓碑上「复活」都按字段具名失败（`revision-purge-tombstones` 覆盖项），无载荷快照绝不与存活正文重算哈希比对；`shareRevisions` 检查报告 `tombstoneCount`/`liveCount`。#38 sourceRevision 加密回执与 #34 被清除 restore 回执都属于既有 008/009 全行检查，不需要 schema 变更；
- 站点设置全行（迁移 `005` 后夹具将 `publishing_writes_paused` 置为非默认 `true`，必须完整恢复；恢复库单独篡改此值时 `siteSettings` 检查必须失败）；
- 发布状态（#35）：迁移 `007` 起夹具在主题 Share 上写入真实的所有者下架终态——`published = FALSE` 且 `access_revision` 推进到 `'9007199254740994'`（即访问版本夹具值 +1，仍超出 2^53），两者必须成对完整恢复；单独篡改 `published`（复活已下架 Share）或单独篡改该 `access_revision` 都必须按字段与页面具名失败（exit 1），revert（用同一 manifest 重新恢复）后 VERIFY 回到 exit 0。忽略 `published` 的旧应用不是安全回滚候选；
- 迁移台账（恢复库、源库与本地 `db/migrations` 三方一致，checksum 不符即失败）。

**夹具覆盖诚实性**：恢复库中每一条受保护页与每一条 managed Key 都必须被夹具材料实际验证；没有对应夹具条目时，验证以“incomplete fixture coverage”显式失败（exit 1），绝不把这些行的功能检查静默标为通过。夹具中引用但恢复库不存在的条目同样报错。报告同时记录快照点（`snapshotAt` + `snapshotWalLsn`）与各步骤真实耗时（`durationsMs`）。

维护设置的恢复验证将现有设置检查扩展为全行比较，并列出 `comparedColumns`，不新增平行验证器。独立 PostgreSQL 测试显式读回 `publishing_writes_paused=true` 和迁移 `005` 台账，同时保留 `access_revision='9007199254740993'` 的精确字符串及篡改回归。运行最新夹具前须应用全部迁移（含 `006`），不能用旧 schema 声称覆盖新设置或凭据版本。恢复时也须保留 `006` 台账；不能回滚到忽略凭据版本的写入者。

## 恢复库默认隔离，失败即关闭

- 恢复脚本只写数据库，绝不连接应用；验证报告永远输出 `safeToServe: false`、`isolation: offline-by-default`。恢复出的数据库默认不对外服务。
- **报告不存在“not-required”结果。**验证对快照点之后的撤销/清除给出两种结论，均需所有者处理后显式传入 `--reconciled`（布尔 flag，不接值）才退出 0：
  - `unreconciled`：检测到快照点之后的撤销/清除事件——`page.delete`、`page.delete.batch`、`page.revision.purge`（#34 版本清除）、`page.unpublish`、`page.republish`（#35 发布状态转换：下架撤销公开访问，两个转换都推进访问版本）、`api_key.delete`、`api_key.rotate`、`api_key.revoke`、`api_key.auto_grant_new_share_edit.disable`，以及携带 `fields` 含 `isProtected`/`passwordHash`/`encryptedPassword`/`expiresAt`/`revokeAccess` 的 `page.update`（即应用真实发出的审计词表，`fields` 来自 `JSON.stringify({ fields: Object.keys(updateOptions) })`）。Key 事件语义不同：`api_key.revoke` 撤销一个 Key 对一条 Share 的读取或编辑授权，旧快照可能复活 grant；`api_key.auto_grant_new_share_edit.disable` 关闭未来新建的自动编辑授权，旧快照可能重新开启这项持续授权能力；`api_key.delete` 删除整个 Key 并级联其全部 grants；`api_key.rotate` 更换 secret、递增 `credential_version`，但保留逻辑 Key ID 与 grants。验证报告会具名列出这些快照后硬撤权事件并将状态设为 `unreconciled`；必须由所有者复核并处理旧快照可能复活的授权/凭据，不能把恢复视为自动安全接受；
  - `owner-review-required`：未检测到事件也**不构成“无事发生”的证明**——部分策略路由（如旧版 `POST /api/pages/:id/protect`）不写审计行，审计历史无法证明 absence，因此任何恢复默认都需要所有者复核后显式确认。
- 两种状态下恢复库都保持离线；`--reconciled` 只表示“所有者已完成人工复核”这一显式动作，不改变 `safeToServe: false` 的报告值。演练脚本（`npm run backup:check`）因夹具完全合成且历史已知，由编排器自身传入该 flag 并在摘要中如实记录 reconciliation 状态。
- `published` 列自迁移 `007` 起存在并由 #35 夹具实际验证：恢复库中 `published=false` 的 Share 保持下架，「恢复即重新上线」永远不是本工具的结论，需要单独的所有者决策；忽略 `published` 的旧应用不是安全回滚候选。

## 凭据与安全边界

- 脚本不加载 `.env`；URL 一律显式传入，子进程环境会剥离继承的 `DATABASE_URL`、`SESSION_SECRET` 等再注入合成值。
- manifest 与日志只含 redacted URL；密码不出现在任何产物中。
- 测试与演练只用合成 secret；生产备份属于单独授权的运维操作（脚本提供显式 `--allow-non-test` 逃生口并在 manifest 中记录绕过标记）。
- 恢复库保持私有：不要把恢复库 URL 配置给任何 QuickShare 运行环境。恢复到 `publishing_writes_paused=true` 也不替代隔离或所有者复核；若快照值为 false，更不能直接开放。`published` 列自迁移 `007` 起存在并由 #35 夹具实际验证：恢复库中 `published=false` 的 Share 保持下架，「恢复即重新上线」永远不是本工具的结论，需要单独的所有者决策；忽略 `published` 的旧应用不是安全回滚候选。受控暂停、旧写入者退出/排空与恢复写入流程见 [写维护手册](maintenance.md)。

## 后续票的扩展合同

- 后续引入任何新持久化对象/字段的票，必须同步扩展 `scripts/backup-restore-check.js` 的夹具与 `scripts/verify-backup.js` 的验证覆盖，不得静默漏表；全行对比会自动覆盖新列，但验证报告要求该列显式出现在 `comparedColumns` 中。
- 例如访问版本化改造（见 `docs/access-revision-rollout.md`，由访问撤销票提供）落地后，恢复验证证据必须显式覆盖 `access_revision`，不能以「pg_dump 完成」替代证据。

## 与清单导出的关系

清单导出保持既有 JSON wire format（`exportedAt` / `total` / `pages[]`，页面字段不变）。管理后台的按钮与提示文案已明确标注「仅元数据，不含正文，不可独立恢复」；完整备份与恢复一律走本文的原生流程。
