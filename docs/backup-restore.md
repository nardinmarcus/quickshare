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
2. 在源库执行真实迁移并植入合成夹具（四类页面、主题、收藏、密码保护、过期、managed Key、审计、站点设置；迁移 `007` 起还包含内容 Revision 快照、超过 2^53 的精确 `current_revision` 指针与非默认 `published=FALSE` 页面）；
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
- 审计日志（快照点两侧一致）；
- 站点设置全行（迁移 `005` 后夹具将 `publishing_writes_paused` 置为非默认 `true`，必须完整恢复；恢复库单独篡改此值时 `siteSettings` 检查必须失败）；
- 迁移台账（恢复库、源库与本地 `db/migrations` 三方一致，checksum 不符即失败）。

**夹具覆盖诚实性**：恢复库中每一条受保护页与每一条 managed Key 都必须被夹具材料实际验证；没有对应夹具条目时，验证以“incomplete fixture coverage”显式失败（exit 1），绝不把这些行的功能检查静默标为通过。夹具中引用但恢复库不存在的条目同样报错。报告同时记录快照点（`snapshotAt` + `snapshotWalLsn`）与各步骤真实耗时（`durationsMs`）。

维护设置的恢复验证将现有设置检查扩展为全行比较，并列出 `comparedColumns`，不新增平行验证器。独立 PostgreSQL 测试显式读回 `publishing_writes_paused=true` 和迁移 `005` 台账，同时保留 `access_revision='9007199254740993'` 的精确字符串及篡改回归。运行最新夹具前须应用全部迁移（含 `006`），不能用旧 schema 声称覆盖新设置或凭据版本。恢复时也须保留 `006` 台账；不能回滚到忽略凭据版本的写入者。

## 恢复库默认隔离，失败即关闭

- 恢复脚本只写数据库，绝不连接应用；验证报告永远输出 `safeToServe: false`、`isolation: offline-by-default`。恢复出的数据库默认不对外服务。
- **报告不存在“not-required”结果。**验证对快照点之后的撤销/清除给出两种结论，均需所有者处理后显式传入 `--reconciled`（布尔 flag，不接值）才退出 0：
  - `unreconciled`：检测到快照点之后的撤销/清除事件——`page.delete`、`page.delete.batch`、`api_key.delete`、`api_key.rotate`，以及携带 `fields` 含 `isProtected`/`passwordHash`/`encryptedPassword`/`expiresAt`/`revokeAccess` 的 `page.update`（即应用真实发出的审计词表，`fields` 来自 `JSON.stringify({ fields: Object.keys(updateOptions) })`）；
  - `owner-review-required`：未检测到事件也**不构成“无事发生”的证明**——部分策略路由（如旧版 `POST /api/pages/:id/protect`）不写审计行，审计历史无法证明 absence，因此任何恢复默认都需要所有者复核后显式确认。
- 两种状态下恢复库都保持离线；`--reconciled` 只表示“所有者已完成人工复核”这一显式动作，不改变 `safeToServe: false` 的报告值。演练脚本（`npm run backup:check`）因夹具完全合成且历史已知，由编排器自身传入该 flag 并在摘要中如实记录 reconciliation 状态。
- 当前 schema 尚无 published/disabled 字段；「恢复即重新上线」永远不是本工具的结论，需要单独的所有者决策与后续票的机制。

## 凭据与安全边界

- 脚本不加载 `.env`；URL 一律显式传入，子进程环境会剥离继承的 `DATABASE_URL`、`SESSION_SECRET` 等再注入合成值。
- manifest 与日志只含 redacted URL；密码不出现在任何产物中。
- 测试与演练只用合成 secret；生产备份属于单独授权的运维操作（脚本提供显式 `--allow-non-test` 逃生口并在 manifest 中记录绕过标记）。
- 恢复库保持私有：不要把恢复库 URL 配置给任何 QuickShare 运行环境。恢复到 `publishing_writes_paused=true` 也不替代隔离或所有者复核；若快照值为 false，更不能直接开放。受控暂停、旧写入者退出/排空与恢复写入流程见 [写维护手册](maintenance.md)。

## 后续票的扩展合同

- 后续引入任何新持久化对象/字段的票，必须同步扩展 `scripts/backup-restore-check.js` 的夹具与 `scripts/verify-backup.js` 的验证覆盖，不得静默漏表；全行对比会自动覆盖新列，但验证报告要求该列显式出现在 `comparedColumns` 中。
- 例如访问版本化改造（见 `docs/access-revision-rollout.md`，由访问撤销票提供）落地后，恢复验证证据必须显式覆盖 `access_revision`，不能以「pg_dump 完成」替代证据。

## 与清单导出的关系

清单导出保持既有 JSON wire format（`exportedAt` / `total` / `pages[]`，页面字段不变）。管理后台的按钮与提示文案已明确标注「仅元数据，不含正文，不可独立恢复」；完整备份与恢复一律走本文的原生流程。
