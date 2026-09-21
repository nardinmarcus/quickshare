# Share 写维护与事务排空

写维护是临时运维状态，不是普通用户设置。`site_settings.id=1` 的 `publishing_writes_paused` 默认 `false`，由显式迁移 `005` 添加。启动、请求和维护 CLI 均不执行 DDL。

## 操作入口

仅在受控运维主机临时注入既有 `DATABASE_MIGRATION_URL`（不写入 shell history、日志或运行环境），执行：

```bash
npm run maintenance -- status
npm run maintenance -- pause
npm run maintenance -- resume
```

- CLI 不读取 `.env`、不回退运行时 URL、不使用内存仓库；必须显式提供上述连接配置。TLS 沿用现有 PostgreSQL 配置，只有 localhost 测试可设置 `POSTGRES_SSL=false`。
- `pause` 成功输出 `{"action":"pause","publishingWritesPaused":true}`；只有事务 **COMMIT 完成**后才输出成功。重复 pause/resume 安全。
- 锁等待或数据库错误导致非零退出；失败不构成暂停/排空证明。默认数据库语句超时仍生效，不自动重试或无限等待。连接中断可能意味着结果未知：先隔离写入者，再核实状态并重新完成 pause，不依据缺失响应恢复写入。
- `status` 只读当前设置，**不是旧部署隔离或排空的证明**。
- 内存 Adapter 的同进程 `setPublishingWritesPaused(boolean)` 提供等价暂停、排空与恢复行为；独立 CLI 无法控制另一个进程的内存实例。

## 已覆盖的行为

网页创建、Share API 创建、编辑、保护、克隆、单条/批量删除、Favorite Share、首页访问设置、managed Key 创建/轮换/删除，以及 `backfill-titles --write` 均通过发布事务 Interface。标题 backfill 的 dry-run 仍只读；`--write` 使用同一 client 查询和更新，不会因单连接池自锁，成功输出也在提交后。

认证、CSRF 与 Origin 检查仍先执行，原有未授权拒绝不变。允许进入写入流程的请求在暂停时返回 HTTP 503：

```json
{"success":false,"code":"PUBLISHING_MAINTENANCE","maintenance":true,"retryable":true,"error":"Share 写入维护中，请稍后重试"}
```

浏览事件对存在、未过期且已获访问许可的 Share 同样返回该 503，计数不增加；缺失/过期/未解锁仍分别为 404/410/403。公开阅读、预览、已认证管理读取、两种登录和密码验证继续可用。`GET /api/v1/me` 与 `/api/v1/capabilities` 仍以有效 API Key 鉴权并可读。Key 最近使用时间是 best-effort；维护期间跳过，不阻塞读取/认证。登录审计不是发布事务，不构成内容迁移排空对象。

发布事务在 PostgreSQL 上先取得共享事务 advisory lock `20828001`，再读取维护设置，并用 **同一 client** 执行写入和必要审计。pause/resume 取得同一闸的排他事务锁。锁持续至 COMMIT/ROLLBACK：已进入的写事务先结束，排在暂停之后的写入取得共享锁后会读到暂停状态并拒绝。设置变更不会嵌套 BEGIN/COMMIT；SQL/审计失败整笔回滚，HTTP 不先报成功。事务超时/死锁返回可重试的 `PUBLISHING_UNAVAILABLE` 503，不在服务端盲目重试。

## 迁移切换的必需证据

1. 在可信迁移环境执行向后兼容迁移 `005`，再次执行应 skipped；核实 NOT NULL/默认 false、单例行与台账。保持现有访问版本安全规则，参见 [访问版本切换](access-revision-rollout.md)。
2. 部署认识维护闸的兼容应用，并在隔离环境验证全部入口。此时不能把滚动部署完成当作可安全回填的证据。
3. **将所有旧部署退出可写路径**：包括旧函数实例、预览/旧域名、定时或手动 CLI 和直连脚本。撤销旧实例写数据库的能力或停止并隔离它们；保留路由/部署修订、连接身份与停止时间的证据。只切流量或观察新部署 READY 不足以证明旧请求结束。
4. 对旧连接核实没有仍可提交的在途写事务（按应用身份/部署标识核对 `pg_stat_activity`、事务开始时间与锁状态）；需要终止旧事务时须另有运维授权，终止后再次核实。**旧代码不取维护锁，pause 无法替它排空**。
5. 执行 pause，保存退出状态与成功输出，核实写入口 503、读取可用及已有发布事务结束。若无法证明旧写入者退出/排空，维持维护状态，不继续基线回填、迁移切换或开放写入。
6. 备份并在隔离库恢复验证；迁移/回填仍仅由显式运维命令完成。部署兼容候选并验证 ID、正文、访问版本和现有功能后，再次确认不存在旧写入者，最后受控 resume 并验证创建/编辑/收藏恢复。

这里的流程说明不授权生产执行。恢复数据库即使保留暂停值也不代表安全上线许可；[备份与恢复](backup-restore.md) 的 `safeToServe:false` 和所有者复核要求不变。

## 回滚

仅回滚到同时理解当前维护闸与访问安全语义的已验证兼容版本。忽略维护闸、`access_revision` 或 Key `credential_version` 锁内复核的旧版本不是安全回滚目标；无法提供兼容候选时保持写维护并向前修复。不删除新列、不执行破坏性 down migration。

## 隔离验证

```bash
npm test
POSTGRES_TEST_URL='postgresql://postgres:synthetic@127.0.0.1:55428/issue28_core_test?sslmode=disable' npm run test:postgres
```

PostgreSQL 文件按顺序执行，避免共享测试 schema 的并行重建。维护测试使用不同 backend PID、锁等待观测（`pg_stat_clear_snapshot`）与确定性 barrier，覆盖排空、排队竞争、设置事务、SQL/审计回滚、提交后响应、恢复、运维 CLI 和单连接 backfill。只运行在自己的 localhost `_test` 数据库，不使用其他工作者的库。
