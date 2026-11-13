# 备份与恢复

QuickShare 有两种不同的导出物，先分清再操作：

| 产物 | 包含什么 | 能否恢复 |
| --- | --- | --- |
| 清单导出（后台「导出清单（不含正文）」/ `GET /admin/pages/export`） | 仅分享元信息：ID、标题、简介、类型、保护/收藏状态、创建与过期时间 | **不能**。不含正文、密码材料、站点设置、API Key 与审计记录，响应里以 `kind: "manifest"`、`includesContent: false`、`restorable: false` 明确标注 |
| 完整备份（本文档的脚本） | `pg_dump` 原生一致性备份：正文、访问策略、收藏、主题、API Key、审计、站点设置与迁移台账 | 可以恢复到隔离数据库并逐项核对（见下） |

## 前置条件

- 与目标数据库**主版本一致**的 `pg_dump` / `pg_restore`（例如数据库是 PostgreSQL 18 就用 18 的工具）。工具不在 PATH 时用 `--pg-bin-dir <目录>` 或环境变量 `QS_PG_BIN_DIR` 指定。
- 脚本只接受 **localhost** 数据库；数据库名必须以 `_test` 结尾，确需操作其他本地库时显式加 `--allow-non-test`。脚本不会连接远程主机，也没有网页端「覆盖生产」按钮。
- 真实 secret 与加密材料单独私密保管：数据库凭据、`SESSION_SECRET`（密码回显解密与 Cookie 签名都依赖它）只保存在既有的私密渠道中，**不进入**备份清单、日志或 Issue。完整备份的 dump 文件本身包含密码 hash 与加密后的密码回显，必须按私密文件保管；同目录的 `manifest.json` 只含摘要与元信息，可以公开用于核对。

## 备份

```bash
npm run db:backup -- \
  --database-url 'postgres://<user>:<pass>@127.0.0.1:5432/<db>' \
  --output-dir ./backup-2026-01-01
```

产物（输出目录不可覆盖已有备份）：

- `quickshare-backup.dump`：pg_dump 自定义格式归档。备份元信息与 dump 取自同一次导出的 Postgres 快照（`pg_export_snapshot`），保证一致性。
- `manifest.json`：恢复点（备份时刻与审计高水位）、源库版本、各表行数、迁移台账、正文及全部行的 SHA-256 摘要（含每条 Share 的 `access_revision` 精确值）、备份耗时。不包含任何 secret 原文。

## 恢复到隔离数据库

目标数据库需预先建好且为空；非空时只有显式 `--clean` 才会先删除并重建目标库的 `public` schema。恢复前脚本会校验 dump 的 SHA-256 与清单一致、目标主版本与备份一致。

```bash
npm run db:restore -- \
  --input-dir ./backup-2026-01-01 \
  --database-url 'postgres://<user>:<pass>@127.0.0.1:5432/<restore_db>' \
  [--clean]
```

恢复完成后在备份目录写入 `restore-receipt.json`（恢复时刻、恢复耗时、目标库、恢复点、`safeToServe: false`）。

**恢复出的数据库默认不对外服务。** 恢复快照不会自动恢复「继续服务」的许可：先保持离线/私有，完成下面的核对并由所有者逐项重新允许后，才可以考虑切换连接。

## 核对

```bash
npm run db:verify-backup -- \
  --input-dir ./backup-2026-01-01 \
  --database-url 'postgres://<user>:<pass>@127.0.0.1:5432/<restore_db>' \
  [--passwords ./passwords.json] [--report ./verify-report.json]
```

核对内容：迁移台账（版本与校验和）、每张表的行数与逐行摘要——正文、ID、主题、收藏、有效期、密码 hash 与回显材料是否存在、`access_revision` 精确值、API Key（含逐 Key 的 `credential_version` 精确值，006 起）、审计日志与高水位、站点设置。同时报告会列出备份时点**之前**审计中记录的访问撤销/策略变更事件（`page.access.revoke`，以及 `fields` 包含 `passwordHash`/`isProtected`/`expiresAt` 等访问策略字段的 `page.update`，和删除事件）。

可选 `--passwords`：一个 `{ "<pageId>": "<明文密码>" }` 的 JSON 文件（私密保管，用后删除）。提供后会真实校验受保护 Share 的密码校验与回显解密能力（需要环境中正确的 `SESSION_SECRET`）。报告的 `passwordCapability.status` 区分 `verified`（夹具覆盖全部受保护 Share 且通过）、`partial` 与 `structural-only`（只验了结构，未验明文）——未提供夹具时不会把结构检查冒充成功能验证。

退出码 0 表示完整性核对全部通过。报告中的 `safeToServe` **永远是 false**，它不是核对失败，而是恢复语义：

- 恢复点**之后**发生的撤销与清除不在快照里，无法从备份核对；无法可靠核对时，恢复出的 Share 保持下架、managed Key 保持停用，由所有者逐项重新允许，不要把旧备份里的凭据直接恢复上线。
- 早期未审计的保护写入使审计记录不完整，撤销事件为空也不能证明从未发生撤销。

## 可重复恢复演练

```bash
POSTGRES_TEST_URL='postgres://<user>:<pass>@127.0.0.1:5432/quickshare_test' \
QS_PG_BIN_DIR=/path/to/pg/bin \
  npm run db:backup-check -- [--schema full|legacy] [--keep]
```

演练自建两个以 `_test` 结尾的合成本地库，写入已知夹具（公开/受保护/已过期 Share、收藏、主题、API Key、撤销与策略变更审计、站点设置），跑通备份 → 恢复 → 核对，并断言：非默认 `access_revision`（如 `9007199254740993`）精确往返、只改恢复库的 `access_revision` 会被核对拒绝、报告包含备份与恢复耗时、恢复库 `safeToServe: false`。完整结构（台账 001–007）下夹具还会把写维护开关 `publishing_writes_paused` 置为 `true`，断言恢复库保持暂停（开关本身也是备份内容，恢复后不会悄悄恢复写入；开关操作见 [写维护手册](maintenance.md)），并断言 API Key 的非默认 `credential_version`（夹具值 7）精确往返、只改恢复库的 `credential_version` 会被核对拒绝。T06 起完整结构夹具还带内容 Revision 状态：各 Share 的 `current_revision` 指针（受保护夹具为精确 64 位值 `9007199254740993`）与 5 行不可变快照（其中一个 Share 带两版历史），断言精确往返，且只改恢复库的快照行或 `current_revision` 指针都会被核对拒绝（核对还会重算每个快照的 `snapshot_hash` 并校验指针快照与物化投影一致，报告含 `contentRevisions` 汇总）。`--schema legacy` 用 001–003 旧结构演练，此时 `access_revision`、`publishing_writes_paused`、`credential_version` 与内容 Revision 相关断言会显式 SKIP 并打印说明。演练结束自动删除两个夹具库（`--keep` 保留以便排查）。该演练也包含在 `npm run test:postgres` 中（工具缺失时显式 skip，不冒充通过）。

## 记录要求

每次真实备份/恢复操作后，记录：恢复点（清单中的 `restorePoint`）、备份耗时（`backupDurationMs`）、恢复耗时（收据中的 `restoreDurationMs`）、核对报告路径与 `passwordCapability.status`。这些记录只写摘要与耗时，不写任何 secret。
