# #43 发布就绪交接（r14 CI 与 canonical PostgreSQL 合同）

## 当前本地工程状态与 r14 增量（不等于发布批准）

r12 的精确树 `66815b75358e63cedf9b33f4f8e9ba4ead6ff499` 已在本地提交并 fast-forward 集成，产品 integration commit `65424e091d401f7fb62b4ece7f834eb581b88a24`。随后发布前只读核查发现 GitHub CI 的 `POSTGRES_DB`、`pg_isready` 与 `POSTGRES_TEST_URL` 仍为 `quickshare_test`，与 r12 canonical suite 只接受 `issue39_api_publish_test` 的前置保护冲突，导致 CI 在测试启动前 exit 1。原始无网络 RED 保留在 R 根 `evidence/issue43/attempts/20261009T163100Z-r14-ci-canonical-db-red/`；既有 r12 本地 107/107 不证明 GitHub CI 会通过。

r14 仅对齐 `.github/workflows/ci.yml` 三处数据库名、`docs/maintenance.md` 的过期测试示例，并在 `test/release-readiness.test.js` 增加读取真实 workflow 的 CI 合同回归；本文只同步状态与证据索引。先 RED、后 GREEN 1/1；Node 24 `npm test` 613/613；独占 PG17 synthetic canonical fixture 上 pinned-client `npm run test:postgres` 107/107、standalone checker 3/3；按 CI 原状不带客户端的同一数据库 suite 为 105 pass + 2 explicit skips，不能冒充 pinned-client 发布门。原始逐命令与 exact-ID fixture 清理证据见 R 根 `evidence/issue43/local-r14-ci/` 及 `evidence/issue43/attempts/*-r14-*/`。此前在已集成 r12 commit 的 PostgreSQL UI/健康后故障补证见 R 根 `issue43-local-r13-ui-outage-result.md`；失败与缺失即时 exit 仍须按原记录披露。

本文件不授权新候选的提交、集成或发布；r14 须对新的完整树再取得两份独立 Standards/Spec 审查及 Commander 决定。恢复副本保持私有、`safeToServe=false`，生产迁移/部署、push、Issue 操作仍需另行明确授权。下面 r12/r11/r7 等段落是相应时间点的历史交接，不应将其“当前”“未提交”等原始表述当作最终运行状态。

## r12 当时的候选与结论（已本地集成；非 r14 新鲜门）

r12 关闭 r11 Standards 与 Spec 的同一项 MUST：独立 `node scripts/release-readiness-check.js` 及每个直接可运行、使用 `POSTGRES_TEST_URL` 的破坏性 PostgreSQL integration entry 均须先通过 `validateCanonicalPostgresSuiteUrl()`，只接受 effective target 为 loopback 的 actor-owned `issue39_api_publish_test`。standalone checker 在 pinned-client 子进程启动前拒绝 `other_test`；direct entry 在 TAP/test registration、Pool/Client/socket I/O 与 DDL 前拒绝。原有 migrations guard 已是 exact canonical；publish-state guard 也保持 exact canonical。`postgres-backup.test.js` 继续排除在本合同之外：它使用独立 `POSTGRES_BACKUP_TEST_SRC_URL` / `POSTGRES_BACKUP_TEST_RESTORE_URL`，在各自 fixture preflight 后复用通用 `_test` validator。通用 `validatePostgresTestUrl()` 未收窄，`other_test` 等独立 loopback fixture 仍可供 backup/drill 使用。

r12 无网络回归同时覆盖带有效 pinned-client checkout 的 standalone checker，以及全部 12 个 direct canonical integration entries（唯一排除 dual-URL backup entry）。checker 测试在错误 DB 名下拦截 child spawn；所有 probes 以 preload 阻断 Pool 构造/connect/query、Client connect/query 和 socket connect，并要求无 TAP/DDL/I/O marker。wrong-local regression GREEN **2/2**；focused `test/release-readiness.test.js` **14/14**；`npm test` **612/612**；fresh pinned-client `npm run test:postgres` **107/107、0 skip**；同库 standalone pinned-client checker **3/3、0 skip**。pinned client 为 `/Users/dapeng/projects/quickshare-client-worktrees/integration`，HEAD `2eec5060c1f7e10e7849fe6085f673d5db72e038`，每个 gate 前后均 clean。

Fresh PG17.11 fixture 的 DDL 前证据核对了 `postgres:17-alpine` image ID `sha256:25a89970a83255ae96484d709005bb35aa71f7455f941bc1634514f31c5d5c62`、repo digest `postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`、容器 full ID `b20d70b25b84088e3de7d267d0c4a4c875d7e921c1b5684978c6718a25c3b33c`、唯一 loopback binding `127.0.0.1:51849 → 5432/tcp` 及独占 volume `issue43-r12-pinned-client-20261007T153519Z-data`。目标 DB 创建前 inventory 为 `postgres|5`, `template0|4`, `template1|1`，`issue39_api_publish_test` 不存在；确认 effective URL 后才创建目标 DB（OID `16384`）。测试后仅按 exact full container ID 与该 volume 清理；final readback 确认 container/name/volume absent、51849 可绑定且无 Docker mapping；预存 `issue43-release-pg` full ID `46540b7c4cb85ca3cc7c67317984a64d59fdcfdf5e1b4ae1bc4db149fa2f8566` 保持 stopped/exited。

- r12 immutable attempts 位于 R 根 `evidence/issue43/attempts/`：RED `20261007T153231Z-r12-wrong-local-db-guard-red/`；GREEN `20261007T153319Z-r12-wrong-local-db-guard-green/`；首次 focused correction `20261007T153327Z-r12-release-readiness-focused/`（exit 1，旧 synthetic fixture URL 不符合新 canonical contract，且未触及数据库）；更正后 focused `20261007T153348Z-r12-release-readiness-focused-correction1/`；Node 全套 `20261007T153403Z-r12-npm-test/`；fixture vacancy / start / pre-DDL / canonical DB create 分别为 `20261007T153519Z-r12-fixture-vacancy-preflight/`, `20261007T153539Z-r12-fixture-create-start/`, `20261007T153558Z-r12-pre-ddl-inventory/`, `20261007T153609Z-r12-create-canonical-test-db/`；PG gate `20261007T153622Z-r12-pinned-client-postgres-suite/`；checker `20261007T153710Z-r12-pinned-client-release-readiness-checker/`；精确 cleanup 前身份核对、cleanup、最终 readback 分别为 `20261007T153801Z-r12-precleanup-exact-identity/`, `20261007T153813Z-r12-exact-owned-fixture-cleanup/`, `20261007T153826Z-r12-final-fixture-cleanup-readback/`。每个执行 attempt 有 literal redacted command、完整 raw log 与即时 exit；失败记录保留原样。
- 两次 freeze-audit harness 失败也原样保留：`20261007T153958Z-r12-frozen-candidate-identity/` 内部 allowlist 比较失败却由 wrapper 记 exit 0（不可作通过证据）；`20261007T154026Z-r12-frozen-candidate-identity-correction1/` 将 prior tree file inventory 错当 changed-path set，exit 1。改正比较后重新通过 freeze identity 核验，精确 receipt 由 R-root handoff 索引；未回填或覆盖旧 attempt。
- 本轮没有改动 backup/restore implementation；r9 native PG17 backup/restore 与 AC2 actual-mutation evidence 仍是先前、独立、未重分类的证据，不作为 r12 新 gate。恢复 reconciliation 仍 `owner-review-required` / `safeToServe=false` / `offline-by-default`；AC3 UI、AC4 production SLO、AC5 provider migration/readback/rollback 仍部分或未验证。r5 mtime-based scratch deletion incident 仍单独待 Commander disposition；无历史 scratch 清理或追溯恢复声明。
- 在 r12 handoff 写成时，此候选只冻结为 staged patch，尚未 commit/审查/集成；后续两份独立审查和本地提交/集成已另行完成，见上方当前状态及 R-root `review43-standards-r12-result.md`、`review43-spec-r12-result.md`、`accept43-r12-precommit.json`、`integration43-result.md`。其 staged tree、patch digest 与 freeze receipt 仍由 `issue43-review-ready-r12.md` 精确索引。该历史结论不授权 push、production/deploy/provider 或 Issue 操作。

## r11 历史候选与结论（r12 已取代）

r11 关闭 r10 Standards HIGH MUST：`npm run test:postgres` 在启动任何 integration test 前调用 `validateCanonicalPostgresSuiteUrl()`，要求 localhost 的实际 node-postgres target 精确为 `issue39_api_publish_test`；`postgres-migrations.test.js` 的直接入口也先执行同一 guard，再注册测试或创建 pool。底层通用 `validatePostgresTestUrl()` 保持仅限 loopback + `_test` 的原语，供独立拥有其它测试库的 backup/drill 继续复用。

无网络回归以 localhost `other_test` 同时运行 canonical package script 与 direct migrations entry：canonical preflight 在 TAP/test runner 输出前拒绝；直接入口在注册/运行迁移测试前拒绝；I/O preload 监测并拦截 Pool 构造、Pool query/connect、Client connect/query 与 socket connect，marker 未产生，未执行 DDL。正例确认 exact canonical URL 可通过；通用 validator 仍接受独立 `other_test` fixture URL。旧行为 RED 记录保留，未覆盖。

本轮新鲜门禁均在独占本地 PostgreSQL 17.11 loopback fixture 上执行：focused `test/release-readiness.test.js` **12/12**；`npm test` **610/610**；pinned-client `npm run test:postgres` **107/107、0 skip**；同库 pinned-client release-readiness checker **3/3、0 skip**。Pinned client 的实际只读路径为 `/Users/dapeng/projects/quickshare-client-worktrees/integration`，HEAD `2eec5060c1f7e10e7849fe6085f673d5db72e038`，gate 后仍 clean。

PG fixture 在 DDL 前已核实 image `postgres:17-alpine` 的不可变 image ID `sha256:25a89970a83255ae96484d709005bb35aa71f7455f941bc1634514f31c5d5c62` 与 repo digest `postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`；唯一容器 full ID `fd6511716bec9ed64c4483adda699e2d854920cae2ca00ba9e9b28ea7e50449c`，running，唯一 publish `127.0.0.1:56741 → 5432/tcp`，唯一挂载卷 `issue43-r11-pinned-client-20261007t1506z-data`。应用目标库在 DDL 前不存在；只在确认后创建 `issue39_api_publish_test`，OID `16384`。所有测试结束后只按 full container ID 和该精确 owned volume 清理；最终 readback 证明二者不存在、56741 可绑定且无 Docker mapping，预存 `issue43-release-pg` full ID `46540b7c…f8566` 保持 stopped。

- Gate/evidence attempts 位于 R 根 `evidence/issue43/attempts/`：RED `20261007T150401Z-r11-wrong-local-db-guard-red/`；绿回归 `20261007T150441Z-r11-wrong-local-db-guard-green/`；focused `20261007T150505Z-r11-release-readiness-tests-focused/`；Node 全套 `20261007T150524Z-r11-npm-test/`；fixture preflight correction `20261007T150814Z-r11-pinned-fixture-resource-preflight-correction1/`、创建/启动 `20261007T150835Z-r11-pinned-fixture-create-start/`、DDL 前目录 `20261007T150854Z-r11-pinned-fixture-pre-ddl-inventory/`、创建目标库/OID `20261007T150907Z-r11-create-canonical-test-db/`；PG gate `20261007T150925Z-r11-pinned-client-postgres-suite/`；checker `20261007T151012Z-r11-pinned-client-release-readiness-checker/`；清理前精确复核 `20261007T151044Z-r11-precleanup-exact-identity/`、精确清理 `20261007T151053Z-r11-exact-owned-fixture-cleanup/`、最终 readback `20261007T151109Z-r11-final-fixture-cleanup-readback/`。每个通过 gate 都有 redacted `.cmd`、完整 `.raw.log` 和即时 `.exit`。
- 两个本轮失败 attempt 原样保留：RED regression exit 1 是修复前证实 canonical script 会继续启动测试（PG I/O preload 阻断 Pool，未触及数据库）；`20261007T150737Z-r11-pinned-fixture-resource-preflight/` 的 shell wrapper 因 awk 转义错误后在分组内 `exit`，没写即时 `.exit`，未创建 container/volume/DB、未做 DDL。没有回填 sidecar；改用独立 correction attempt 并通过。历史 r7、AC2、r9 三个缺即时 sidecar 的 initial-preflight attempts 也保持原状。r5 mtime scratch-cleanup incident 仍未裁定，未清理任何历史 scratch。
- 在 r11 handoff 时仍未 commit、push、integration、production/deploy、provider mutation/readback 或操作 Issue。AC2 restore reconciliation/serving 仍未完成：`owner-review-required`、`safeToServe=false`、`offline-by-default`。AC3 仍不具备完整 UI 条件验收；AC4 只有本地竞争/10×规模/运行故障证据，不是生产 SLO；AC5 的生产旧 writer drain、迁移/readback 与 rollback 均未验证。fresh independent full-tree reviews 与 Commander acceptance 尚未完成；本文不是接受或发布授权。

## r9 历史候选门禁与证据（保留，不是 r12 新鲜执行）

执行 attempt 位于 R 根 `evidence/issue43/attempts/`。成功 gates 与已完成的后续尝试各自保留独立命令、完整日志和即时 exit；失败记录不覆盖。例外是初始 pinned-client fixture preflight `20261007T143538Z-r9-pinned-client-fixture-preflight/`：macOS Bash 3.2 在创建任何资源前因 `${STAMP,,}` 报 `bad substitution` 而退出，保留了命令与 raw log、没有即时 `.exit`；独立的 corrected preflight 随后完成。新建 PG17 fixtures 的 image ID、full container IDs、loopback ports、volumes、数据库名/OID 与 DDL 前缺席核验见下表关联 attempt。详细 candidate 身份和完整失败/恢复轨迹见 R 根 handoff。

| Gate | r9 结果 | Attempt / artifact |
|---|---:|---|
| Focused restore/alias safety | **36/36**，0 fail/skip | `20261007T140731Z-r9-focused-remote-alias-correction1/` |
| `npm test` | **608/608**，0 fail/skip | `20261007T140731Z-r9-npm-test-pre-index/` |
| 初始 `npm run test:postgres`，owned PG17（保留的无 client 尝试） | **105 pass、2 explicit skip、0 fail** | `20261007T140731Z-r9-pinned-postgres-suite/`；原始 skip 尝试保留，不追溯重分类 |
| 后续 `npm run test:postgres`，pinned client + separate owned PG17 | **107/107**，0 fail/skip | `20261007t143653Z-r9-pinned-client-postgres-suite/`；新独立 attempt，非上方 105+2 尝试的重分类 |
| Release-readiness checker，pinned client + same fixture | **3/3**，0 fail/skip | `20261007t143726Z-r9-pinned-client-release-readiness-checker/` |
| Pinned-client fixture exact-ID cleanup + final readback | **PASS**；owned container/volume absent，56738 released | `20261007t143809Z-r9-pinned-client-exact-cleanup/`、`20261007t143833Z-r9-pinned-client-final-cleanup-readback/` |
| `npm run test:postgres:backup`，owned PG17 | **23/23**，0 fail/skip | `20261007T140731Z-r9-native-backup-integration-suite-correction1/` |
| Native backup→restore→verify drill，PostgreSQL 17.11 | **exit 0；11/11 checks** | `20261007T140731Z-r9-native-pg17-drill/`；`verification.json` 是完整报告，`owner-review-required`、`safeToServe=false`、`offline-by-default` |
| 独立只读 source/restore parity | **8 tables、1 sequence、0 differences** | `20261007T140731Z-r9-native-pg17-drill/independent-parity.raw.log` 与 `artifacts/independent-parity.json`；仍 `safeToServe=false` |
| Exact-ID cleanup/readback | **PASS**；两容器、两匿名 volume 均 absent，56981/56982 已释放 | `20261007T140731Z-r9-exact-owned-container-volume-cleanup/`、`20261007T140731Z-r9-final-exact-cleanup-readback-correction2/`；预存 `issue43-release-pg` full ID `46540b7c…f8566` 保持 stopped |

后续 pinned-client gates 使用新建的独立 PostgreSQL 17 fixture；pre-DDL identity 与目标库缺席核验见 `20261007t143627Z-r9-pinned-client-fixture-provision/`，只在核验后创建 `issue39_api_publish_test`（OID `16384`）。fixture 为 full container ID `0ee4fc55fbaef5e853c722bc1c20403dd4b9a4b94fe029e202b0ac2bb26b08b3`，仅绑定 `127.0.0.1:56738`，挂载精确 volume `issue43-r9-pinned-client-20261007t143605Z-data`；fixture preflight / create receipts 分别为 `20261007t143605Z-r9-pinned-client-fixture-preflight-correction1/` 与 `20261007t143645Z-r9-pinned-client-create-test-db/`。只删除该 full container ID 与对应 volume 的记录为 `20261007t143809Z-r9-pinned-client-exact-cleanup/`；`20261007t143833Z-r9-pinned-client-final-cleanup-readback/` 确认 container/name/volume 均 absent、端口已释放，且预存 `issue43-release-pg` 保持 stopped。没有生产连接。

PG17 native drill artifacts（`20261007T140731Z-r9-native-pg17-drill/artifacts/`）SHA-256：dump `d9be9bf7fa97cbe900cba4483d48d07acbc96dbd092559225ca6ee29f7f17cc6`；backup manifest `94860f2710c29a384b307175ff5aa51c1ce4488272e5d591949579f079484083`；restore manifest `62e0ac7b63eadf17ae17df24b440acd9549c93df0fc029595866fa9e7aa6dcf4`；完整 `verification.json` `9bd76be0242681c2342c414f8abe06b9ed634237bdc5ad61dce9fd9bc4071d4f`；独立 parity `d226e0180af6c2549c112c81096863f08aec81ee6023529642ba3b53f6e35a74`。Backup manifest dump digest 与独立重算一致。原生 drill 容器/image/port/database/volume 身份与精确 cleanup 记录见对应 preflight 与 cleanup attempts。

## r8/r7 与更早的历史门禁（不作为当前 r14 候选）

以下门禁来自 r7 代码/测试候选；本轮仅更新本文档，没有修改受测 JavaScript/test 文件。所有 attempt 位于 R 根 `evidence/issue43/attempts/`，失败记录不覆盖。

| Gate | 结果 | Attempt |
|---|---:|---|
| Focused backup/restore/port-binding/CLI safety | **35/35**，0 fail/skip | `20261006T182944Z-r7-focused-port-binding-cli/` |
| `npm test` | **607/607**，0 fail/skip | `20261006T183020Z-r7-npm-test/` |
| 显式 `npm run db:migrate` | 10 migrations applied | `20261006T183448Z-r7-gates-explicit-migrate/` |
| `npm run test:postgres`，pinned client | **107/107**，0 skip | `20261006T183456Z-r7-postgres-suite-pinned/` |
| `npm run test:postgres`，无 client | **105 pass、2 显式 skip** | `20261006T183543Z-r7-postgres-suite-no-client/`；不替代 pinned-client gate |
| Release-readiness checker，pinned client | **3/3**，0 skip | `20261006T183615Z-r7-release-readiness-checker-pinned/` |
| Native `test/integration/postgres-backup.test.js` | **23/23**，0 fail/skip | `20261006T183816Z-r7-native-backup-suite/` |
| 正常候选 PG17 backup→restore→verify drill | **exit 0；11/11 named checks** | `20261006T184327Z-r7-native-drill/` |
| 两客户端独立 source/restore parity | **PASS** | `20261006T184612Z-r7-native-artifact-parity-recovery/` |
| Exact-ID fixture cleanup 与 artifact recheck | **PASS** | `20261006T184950Z-r7-artifacts-fixture-cleanup/` |

r7 正常 drill 的 artifacts 位于 `20261006T184327Z-r7-native-drill/artifacts/`：dump SHA-256 `8279f412fd3629224bc7949e4c785cdb3a57ff8cd5b161843e984e722ad1427d`；backup manifest `71db11b929c2c75d65b39a13e79c4250e9dde91127cc0cc4164e5b795bd60d08`；restore manifest `12c4bba1d72735a45b38ac3e0b433df21d4f6f13bde7099e3657915c73e74166`；`verification.json` `bc3ce97fd4aa88bf00459380e45a804c482ffc9ade31835c026917114b069833`。该次正常 drill 的 11/11 checks 和 parity 通过，但 verification 仍为 `owner-review-required`、`safeToServe=false`、`offline-by-default`；不能据此推断 mutation 后恢复库可 serving。

### AC2：快照后实际 mutation 与 fail-closed 恢复差异

新建的本地 PG17.11 source / private-restore fixtures 使用真实 dashboard HTTP 路由，在 authoritative snapshot **之后**撤回同一 Key 的 publish、update、read grants（三个 revoke）并 purge revision 2（含关联 receipt）。source 读回显示 grant 已删除、revision/receipt 已清除且有 3 条 `api_key.revoke` 与 1 条 `page.revision.purge` 审计；private restore 未作为应用服务启动，仍保留快照中的 grant、正文与 receipt，且没有 mutation audit。

- 实际 HTTP 请求/回包：`20261006T193742Z-ac2-real-http-local-ssl-recovery/artifacts/real-http-mutations.json`；mutation 前后独立领域读回分别为 `20261006T193444Z-ac2-baseline-domain-readback/artifacts/domain-readback-before-mutation.json` 与 `20261006T193756Z-ac2-post-mutation-domain-readback/artifacts/domain-readback-after-mutation.json`。
- Mutation 前 baseline verifier：`20261006T193500Z-ac2-baseline-verifier-unreconciled/artifacts/verification-baseline.json`，exit 2。Mutation 后 authoritative verifier：`20261006T193816Z-ac2-post-mutation-verifier-unreconciled/artifacts/verification-post-mutation.json`，exit 1；这是原 verifier 对真实 source/restore 差异的预期结果，报告 `ok=false`、`reconciliation.status=unreconciled`、`safeToServe=false`、`isolation=offline-by-default`，并列出 `shareRevisions`、`managedApiKeys`、`shareGrants`、`publishOperations` 四类差异。没有使用 `--reconciled`，没有把差异改报 pass。
- 独立结果断言与最终 artifact hash ledger：`20261006T193913Z-ac2-result-contract-assertion/artifacts/AC2-verification-assertion.json`、R 根 `evidence/issue43/ac2-final-artifact-sha256.json`；完整过程与边界见 R 根 `issue43-ac2-real-mutation-result.md`。
- 初始失败 attempts 均保留，未回填即时 exit：r7 `20261006T183311Z-r7-fixture-preflight/`；AC2 `20261006T192853Z-ac2-fixture-create-preflight/`。AC2 报告另记录 PG 初始化、HTTP SSL 配置和证据路径等失败及其独立 recovery；原失败记录不被 recovery 替换。r5 scratch 删除事件仍单独记录在 R 根 `issue43-r5-scratch-cleanup-incident.md`，未恢复、未豁免。

## r6 历史证据（不作为当前候选）

证据根目录为 R 下的 `evidence/issue43/attempts/`。所有执行 attempt 保留字面脱敏 `.cmd`、完整 `.raw.log` 与即时 `.exit`；失败 attempt 原样保留。当前产品工作树未 commit、push、集成或部署。

| Gate | r6 结果 | Attempt |
|---|---:|---|
| Focused backup/restore/drill safety unit | **30/30**，0 fail/skip | `20261006T172209Z-r6-focused-backup-unit-review/` |
| `npm test` | **602/602**，0 fail/skip | `20261006T172241Z-r6-npm-test/` |
| 显式 `npm run db:migrate` | 10 migrations applied | `20261006T172618Z-r6-gates-explicit-migrate/` |
| `npm run test:postgres`，pinned client | **107/107**，0 skip | `20261006T172635Z-r6-postgres-suite-pinned/` |
| `npm run test:postgres`，无 client | **105 pass、2 显式 skip** | `20261006T172721Z-r6-postgres-suite-no-client/`；不替代 pinned-client gate |
| `node scripts/release-readiness-check.js`，pinned client | **3/3**，0 skip | `20261006T173006Z-r6-release-checker-pinned/` |
| Native `test/integration/postgres-backup.test.js` | **23/23**，0 fail/skip | corrected attempt `20261006T173356Z-r6-native-backup-suite-corrected/` |
| Candidate native backup→restore→verify | **exit 0**；11 verification checks 全部通过 | `20261006T173557Z-r6-native-drill/` |
| 独立 live source/restore parity | **PASS**；8 个 public base tables、sequence state 与 001–010 migration checksum 一致 | `20261006T173557Z-r6-native-drill/steps/06-independent-live-db-parity.raw.log` 与 `.exit` |
| Exact-ID container/volume cleanup | **PASS**；三项精确 ID 与 volume 均 absent，56541–56543 无 Docker mapping 且 loopback 连接拒绝 | `20261006T173557Z-r6-native-drill/steps/12-exact-owned-container-volume-cleanup.raw.log`、`steps/13-exact-port-56543-release-diagnostic.raw.log`、`steps/14-final-cleanup-and-artifact-reconciliation.raw.log` |

### r6 历史 native drill artifacts

该 r6 历史 drill 使用真实候选 CLI 路径 `node scripts/backup-restore-check.js --skip-container-setup --keep-containers --output-dir <attempt>/artifacts`，连接的是已核实归属的 PG 17.11 synthetic loopback fixtures。dump/manifest/report/fixture payload 位于 `20261006T173557Z-r6-native-drill/artifacts/`；`fixture-identity.json` 与 `artifact-sha256*.txt` 收据位于该 attempt 根目录。artifacts 和 fixture 含合成材料，目录权限 `0700`、文件权限 `0600`。

- Dump：`quickshare-backup-20261006T174508-issue43_r6_native_source_test.dump`，18,678 bytes，SHA-256 `9976e0cb70b1b8b4f144ed26899527b3ecc7e686b57ce3e295d4e8e53907c195`。
- Backup manifest SHA-256：`db0fe642eabe882a5058a960606828d21f04873073446aee342c051b42c9e274`。
- `restore-manifest.json` SHA-256：`e828fabaf107d0f80fbc37a9cc512ccb52d19308db8294240fec08c52b4a9b84`。
- `verification.json` SHA-256：`c55143e67972e57dc65bb985fbd21acca490d8862dcca7e10fb736ae896baff7`。
- `fixture.json` SHA-256：`b9c930ba6febf2e71b81015af8fd3aa965074dfe5b731f16ed1ee5dc73be58c6`；attempt 根目录非秘密 `fixture-identity.json` SHA-256：`7b08c1c8fa6105dccf78ef179faae057ce6042f7b706313f6e8a5222ec4961a4`。
- attempt 根目录完整 hash receipts：`artifact-sha256.txt`、`artifact-sha256-final.txt`；cleanup 后以 `shasum -a 256 -c` 再验证通过。
- 报告的最终状态必须按原文理解：`ok=true` 不解除 `owner-review-required`；`safeToServe=false`、`offline-by-default`。没有执行真实快照后撤销/清除 mutation，也不声称已验证其持久化。

### r6 历史失败尝试与恢复（保留原记录）

失败记录均保留在各自 attempt/step 目录，不能覆盖或把失败改报通过：

- Native backup suite 首次尝试 `20261006T173113Z-r6-native-backup-suite/` exit 1：当时的 proof wrapper 将字面 `-` 交给 `pg_restore`；corrected stdin wrapper 的新 attempt `20261006T173356Z-r6-native-backup-suite-corrected/` 为 23/23。
- Native drill continuation 内，`steps/03-resume-exact-fixture-readback.*` 因 loopback JSON 字符串断言写错而 exit 1；修正后的精确身份复核 `steps/04-resume-exact-fixture-readback-corrected.*` 通过。
- 首次 artifact verifier `steps/07-artifact-integrity-and-secret-scan.*` 因 helper 的 attempt-root 路径解析错误 exit 1；未覆盖原件。独立重跑 `steps/08-artifact-integrity-rerun.*` 通过。
- 首次最终 pre-cleanup port check `steps/09-final-precleanup-identity-readback.*` 因 `docker ps --quiet` 默认缩短 ID、而脚本要求 full ID，exit 1；使用 `--no-trunc` 的新 attempt `steps/10-final-precleanup-identity-readback-corrected.*` 通过。
- Exact-ID 删除三组 fixtures 的 `steps/12-exact-owned-container-volume-cleanup.*` 已成功删除全部指定容器与卷，但立即探测 56543 时 teardown 尚未结束，故该 attempt exit 1。保留原始结果；稍后 exact-port diagnostic `steps/13-exact-port-56543-release-diagnostic.*` 显示连接拒绝，最终 reconciliation `steps/14-final-cleanup-and-artifact-reconciliation.*` exit 0，三个端口均无映射且拒绝连接，所有 artifact hashes 复核通过。
- 其他预检与恢复 attempt 的完整列表、`.cmd/.raw.log/.exit` 均在该 R attempt；没有改写旧 attempt。

## r7 AC 状态与边界（历史评估）

| 标准 | 状态 | 证据与未覆盖边界 |
|---|---|---|
| AC1：同一候选的 Share/Key 完整生命周期 | **本地 pinned-client 门通过** | r7 PostgreSQL **107/107**、release checker **3/3 zero skip**；仅 loopback 合成环境，不是 provider/生产验证。 |
| AC2：完整备份恢复及快照后 revoke/purge 复核 | **实际 mutation 已本地取证；恢复仍 partial / owner-review-required** | 独立 PG17.11 fixtures 上 snapshot 后经 dashboard HTTP 完成 3 次 Key grant revoke 与 revision 2 + receipt purge；source 持久审计为 3 revoke / 1 purge。未变更的 private restore 保留旧 grant/正文/receipt，verifier 正确列出四类差异并保持 `unreconciled`、`safeToServe=false`、`offline-by-default`。此证据不等于 reconciliation、恢复 serving 或全 AC 通过。 |
| AC3：回归与 UI / 客户端 | **本地回归通过；整体验收部分** | r7 `npm test` **607/607**、pinned PG **107/107**；无 client 套件为 105 pass + 2 skip。UI smoke 不证明 PostgreSQL UI 持久化；provider-backed、human output review、clean-install 仍待客户端维护者/人工验收。 |
| AC4：连接竞争、规模与运行故障 | **部分完成** | r7 pinned PostgreSQL attempt `evidence/issue43/attempts/20261006T183456Z-r7-postgres-suite-pinned/full.raw.log` 的 `ISSUE43_PERF_10X` 记录了 100→1,000 Pages/revisions、管理列表固定 50 行、current-read 未查询历史表及两种规模的 restore 延迟；r7 release checker 的 10× synthetic 结果见 `20261006T183615Z-r7-release-readiness-checker-pinned/full.raw.log`。这些是隔离本地合成观察，不是生产 SLO，也不证明健康运行后 DB outage；相关运行故障仍仅覆盖启动后首次访问遇到闭端口。 |
| AC5：维护、迁移、读回与安全回滚 | **文档/本地覆盖；生产未验证** | `docs/deployment.md` 描述 pause、排空、迁移与 forward-fix 边界；未做生产 provider 旧 writer 排空、迁移、readback 或回滚。 |
| AC6：证据与责任交接 | **当前证据已索引** | 本文件索引 r7 gates 与 AC2 mutation；R 根 `issue43-review-ready-r7.md`、`issue43-ac2-real-mutation-result.md` 与本轮 r8 handoff 记录身份、receipts 和边界。交接不等于 acceptance。 |
| AC7：审查且不自动发布 | **仍待独立 review/Commander acceptance** | r8 文档变更改变了 staged identity；必须针对新的完整 staged tree 取得两份 fresh independent full-tree reviews，再由 Commander 决定 acceptance。当前无 commit/push/integration/deploy/Issue 操作。 |

## 更早历史轮次（不作为 r12 当前候选结果）

- **r2 历史回归**：`20261004T154921Z-r2-npm-test-final/` 586/586；`20261004T154939Z-r2-postgres-suite-pinned-client-final/` 107/107；`20261004T155016Z-r2-postgres-suite-no-client-final/` 105 pass、2 client opt-in skip；`20261004T154708Z-r2-release-checker-pinned-client/` 3/3。此处只保留历史来源，不将其当作当前 r7 代码门禁或 r8 文档候选结果。
- **r4 历史 AC4 smoke**：`20261006T161000Z-r4-release-checker-pinned/full.raw.log` 曾记录 100→1,000 Pages/revisions、本地有界管理列表、历史表读取观察与恢复耗时。该结果不是当前 r7 代码门禁或 r8 staged tree 的替代证据，也没有证明服务健康运行后数据库突失或生产 SLO。
- **r5 scratch incident（不可变披露）**：R 根 `issue43-r5-scratch-cleanup-incident.md` 记录了按 mtime 删除 11 个 TMPDIR 路径、其中至少两个可证为 r4 scratch，另外八个归属无法证明。后续 r6/r7/AC2 durable artifacts 不会恢复已删除的旧 scratch；本轮没有清理任何历史或 unowned scratch，也不声称追溯修复该事件。独立审查应继续单独评估该 process/evidence incident，不得静默豁免或与产品代码结果混为一谈。

## r7/r12 handoff 写成时尚待完成（历史记录，不代表当前状态）

1. r12 staged tree 冻结后，需由两位 fresh、independent reviewer 完成全树 Standards 与 Spec review；本 writer 不自审、不接受、不 commit、不 integration，r11 及更早 review 均不覆盖 r12。
2. Commander 仍需单独裁定 r5 scratch-cleanup preservation incident；本轮没有清理旧 scratch，也没有追溯恢复缺失内容。
3. AC2 private restore 仍 `owner-review-required` / `safeToServe=false` / `offline-by-default`。未来 serving 讨论必须由恢复 owner 在适当授权流程中完成人工审查/reconciliation；本轮 pinned gate 不证明 mutation 后 restore 可以 serving。
4. AC3–AC5 仍按上方明确边界部分完成/未验证；本地 PostgreSQL gates 不替代完整 UI 审查、生产 SLO、provider mutation/readback 或安全 rollback。

本交接只描述隔离本地候选和待办边界；不授权生产、部署、push、commit、integration 或 Issue 修改/关闭。
