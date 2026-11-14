# T19 联合验收与发布交接（quickshare#43）

本文件是 Share 持续管理里程碑（父规格 #24，T01–T19）的联合验收记录与发布交接材料。它只记录**已实际执行**的验证；未执行的事项在文末明确列出。本票未部署、未执行生产迁移、未推送、未修改或关闭父规格 Issue；实际发布由后续明确指令驱动。

## 候选标识

| 对象 | 标识 |
|---|---|
| 服务端候选 | `0919fd4`（T15 本地提交，与已推送 PR #58 内容一致；分支 `t15-granted-publish-state`，叠在 T01–T14 链上） |
| T19 文档提交 | `87ea4a6`（部署指南同步，见「发现与修复」）与本文件所在提交 |
| 客户端候选 | namoo-agents 维护源 `9cbdb79`（T18 本地提交，叠在 T17 `a2c2436`、T16 `3084aa4` 上），`manifest.json` 版本 `0.5.0` |
| 验收环境 | 本地隔离实例：PostgreSQL 18.6（127.0.0.1:55433，库名均以 `_test` 结尾）、Chrome for Testing 157 headless shell、Node 24 |
| 验收驱动 | `~/workspace/quickshare-t19/` 下 `joint-accept.js`、`backup-phase.js`、`db-failure.js` + `drop-proxy.js`、`scale-check.js`、`browser-check.js`、`old-writer.js`（SHA-256 见同目录 `evidence/11-driver-hashes.txt`，全部日志见 `evidence/`） |

注意：服务端在 `NODE_ENV=test` 下按设计强制使用内存仓库（`models/pageRepository.js`），因此联合验收的真实 Postgres 运行使用 `NODE_ENV=development` + `POSTGRES_URL` 启动——这也是本地预检时最容易踩错的一点，特此记录。

## 全量回归（先行通过，联合验收不替代各票测试）

| 套件 | 命令 | 结果 |
|---|---|---|
| 服务端（内存适配器） | `npm test` | **435/435 通过**（T19 文档提交后复跑仍 435/435） |
| 服务端（真实 Postgres） | `npm run test:postgres`（`POSTGRES_TEST_URL` → `quickshare_test`） | **102/102 通过，0 跳过**。首跑曾有 2 个备份恢复演练因 PATH 无 `pg_dump/pg_restore` 被显式 skip；补齐 PG 18.7 客户端工具后复跑全过——skip 不冒充通过 |
| 客户端自测 | `python3 -m unittest tests/test_share.py` | **76/76 通过** |

## 联合链路（同一候选修订、双入口）— 40/40

驱动 `joint-accept.js`，服务端为真实 Postgres 适配器，Agent 步骤全部经真实客户端 `share.sh`，后台步骤全部经真实管理 HTTP 端点：

1. 所有者创建候选 Share（Markdown、密码保护、带有效期）→ 已发布、受保护、`access_revision=1`；行落入 Postgres（适配器真实性核对）。
2. 所有者授编辑（read+update，**不授** publish）；legacy Key 仍可创建且 capabilities 不含任何管理能力（旧客户端兼容、管理权限不扩大）。
3. Agent `link` 基线 rev1 → 改稿 `update` 落 rev2，操作 `requestId` 可查。
4. 后台竞争保存落 rev3；Agent 以陈旧基线再 `update` → 停手并展示差异，服务端仍为 rev3（零写入）。
5. 所有者后台恢复 rev2 → 落 rev4 且正文回到 V2；恢复前后 `isProtected`/`expiresAt`/`access_revision`/`published` 四项逐项不变。
6. 所有者后台清除 rev1 → Agent `history` 显示墓碑，读取 rev1 正文被拒（无正文输出）。
7. publish 单独授权：未授 publish 时 Agent 下架被拒且状态不变；单独授予 publish 后 `unpublish` → 公开页 404，`republish` → 公开页恢复且不泄露受保护正文。
8. 所有者删除（撤销）编辑 Key → `whoami` 失败、对先前 update 的 operations 重放查询 401、直连 API 写 401，管理与重放全部失效。
9. 相同来源再次「发布」→ 得到**新** Share（不同 ID）；显式 `update --id` 仍命中**原** Share 并落 rev5（同 URL）。
10. 附带核验：四类内容（html/markdown/code/text）创建与渲染、12 个 Markdown Preset 逐个创建/渲染/标记、Favorite 开关与列表过滤且公开元信息不泄露收藏字段、浏览事件恰好计数一次且统计页可达。

竞争（至少两个独立连接，均在上述驱动内）：双并发同基线 PUT → 恰一 200 一 412、版本只进一次；双并发同 Idempotency-Key 创建 → 一个 Share、一条操作记录；后台恢复与 API 更新同基线并发 → 恰一成功、版本只进一次。

写维护（同驱动 E 节）：操作员 CLI 暂停后 API 写与后台写均 503 `maintenance`、读正常、浏览事件不计数；恢复后被拒写入确认从未落库。

## 备份恢复复核（隔离库、全部新表）

对象为联合链路跑完的同一数据库（23 个 Share、30 条 Revision、1 个墓碑、4 条 grants、31 条操作记录、台账 001–010）：

- `db:backup` 成功：8 张表齐全（含 `share_revisions`、`share_grants`、`publish_operations`），记录恢复点（审计高水位 53）。
- 备份点**之后**在源库做两项变更：清除 S 的 rev3、撤销复核 Key 对 S 的授权（均经真实后台端点，源库复核已生效）。
- `db:restore` 恢复到 `quickshare_t19_restore_test`：回执 `safeToServe: false`；`db:verify-backup` 退出 0、`ok: true`、`safeToServe: false`，行数与清单逐项一致；S 的当前指针（rev5）、`access_revision=3`、已发布/受保护状态精确往返；备份点**之前**清除的 rev1 在恢复库仍是无载荷墓碑（API 读 410），未被复活。
- **恢复点后变更无法核对的实证**：恢复库中被撤销的授权仍然有效（可读正文）、被清除的 rev3 正文仍然存在。即恢复库按构造停留在备份点状态——这正是父规格 §11 要求「恢复出的 Share 保持私有、managed Key 停用，由所有者逐项重新允许」的原因。本次复核中，恢复库由操作员先行置于写维护（`db:maintenance pause`），实测写请求 503、读可达但仅限复核用途；**在所有者逐项核对恢复点后的撤销与清除并重新允许之前，恢复库不得对外服务**。
- 容量下同样成立（见下节）：10 倍规模的备份 → 恢复 → 核对完整跑通且 `safeToServe` 仍为 `false`。

## 容量（10 倍规模）— 11/11

驱动 `scale-check.js`：201 个 Share（10× 工作集）、3,900 条 Revision，其中一个 Share 带 1,300 条历史（10× 于 T07 的 130 版回归夹具），快照哈希用服务端自身 `computeSnapshotHash` 生成以便核对可通过：

- 列表有界：默认页 20 条 + `nextCursor`；`limit=100` 得 100；`limit=500` 仍被钳制为 ≤100。
- 当前读取不扫历史：1,300 版 Share 与 13 版 Share 的当前正文读取中位耗时同量级（本机约 50.9ms 对 50.5ms，为 HTTP/应用固定开销主导）；`EXPLAIN ANALYZE` 显示当前快照读取走 `share_revisions_pkey` 索引扫描。
- 历史列表分页：默认 20 条且报告 `total=1300`；恢复 rev650 落 rev1301，耗时约 86ms。
- 备份约 456ms、恢复约 235ms、核对通过（本机隔离环境数据，仅作量级参考）。

## 故障行为 — 12/12

驱动 `db-failure.js`（+ `drop-proxy.js`）：

- 数据库不可用：停 Postgres 后创建与读取均 5xx 失败，**不回退内存仓库**；恢复后数据恰为停机前状态（+1 条停机前创建），无幻影 Share，被拒写入无残留行。
- 网络未知状态：经丢弃响应的代理创建（服务端已提交、客户端只见传输失败）→ 有界重试均重放同一请求（服务端恰好一条记录）、pending 保留；`resume` 取回**原** Share，不新建。
- 端点完全不可达：客户端在 capabilities 预检阶段即拒绝并明确「nothing was sent」——未发出请求即无待恢复结果，与上一种情形区分清楚。

## 迁移、回填与旧写入者 — 7/7 及套件证据

- 空库迁移：`db:migrate` 首次 applied 001–010，第二次全部 skipped（日志 `evidence/04a-migrations.log`）。
- 基线回填（§11 步骤 4）：在写维护窗口内对两条模拟存量 Share（`current_revision=NULL`）首跑 baselined=2、复跑 **skipped=2**，与规格「第二次运行应全部 skipped」一致；回填工具自身校验暂停标志、从不代为开关维护。
- 排空语义：T04 的 Postgres 套件（本次 102/102 内）以真实事务证明「暂停返回即先前写事务已结束」；联合验收 E 节在 HTTP 层复核。
- 旧写入者（驱动 `old-writer.js`，预里程碑代码 `12bcf9c` 对已迁移 001–010 的库）：正常运行时旧代码可创建可读——扩展迁移向后兼容（§11 步骤 1–2 成立）；但写维护暂停期间旧代码**仍成功写入**（已实测并在库中留行）——旧代码不认识维护闸。这实证了 §11 步骤 3 的发布门槛：**基线切换前必须确认旧写入者退出可写路径，无法确认则维持维护状态**；滚动部署本身不构成排空证据。

## 浏览器验收（真实 Chrome 157）— 9/9

驱动 `browser-check.js`：

- 390px：后台列表页与公开分享页均无横向溢出（`scrollWidth ≤ 390`），分享正文在 sandbox srcdoc iframe 内正常呈现。
- 键盘：后台列表 Tab 遍历依次命中真实交互元素（导航、导出、搜索框、提交按钮），焦点元素带可见焦点指示（实测 `outline: solid 2px` 等）。
- 明暗：后台壳响应 `prefers-color-scheme: dark`（body 背景由 `rgb(250,250,250)` 变为 `rgb(10,10,15)`，实测）。Markdown 侧的实测事实：`--theme-canvas` 只在基线样式表中定义（`#f5f7fa`），12 个 Preset 都不覆盖画布，差异在字体/强调色/代码与引用面；抽测 6 个 Preset 正文对画布对比度为 11.4–19.0（均 ≥7），且正文颜色互不相同（可视区分成立）。**不存在深色画布 Preset**——若后续需要深色阅读面，那是新增设计，不在本里程碑范围内。

## 发现与修复

1. **部署指南两处过期（已修复，提交 `87ea4a6`）**：`docs/deployment.md` 的迁移核对仍写台账 001–009 且未核对 `share_grants`/`api_keys.scopes`（010 起已过期）；回滚章节仍是「重新部署上一稳定应用版本」的旧表述，与父规格 §11 的回滚红线冲突。均已按 §11 同步。
2. **旧写入者无视维护闸（实证，非新代码缺陷）**：见上节。这是发布流程必须守住的门槛，已写入部署指南回滚章节与下方操作者职责。
3. 验收过程中其余失败均为 **T19 验收驱动自身的夹具错误**（密码长度规则、授权前读状态、scope 与 grant 的夹具分工、PUT 快照四字段、Markdown 主题需结转当前值、view-event 成功码 204），逐一修正后全绿；产品行为在每一处都与对应票面规格一致，未发现需要修复的产品缺陷，服务端与客户端候选代码未作任何改动。现有未提交设计工作（主题样例/原型）未被触碰。

## 发布程序（供后续明确指令执行，本票未执行）

按父规格 §11 的固定顺序：

1. 先执行向后兼容的扩展迁移（`db:migrate`，台账 001–010，只在可信迁移主机/CI 以 direct owner URL 临时注入）。
2. 部署认识写维护闸的兼容应用，验证各写入口在暂停时返回 503 `maintenance`。
3. 进入写维护并排空；**确认旧写入者已退出可写路径**（见上方实证），无法确认则停在维护状态。
4. 在维护窗口内执行基线回填（`db:backfill-revisions`），复跑应全部 skipped；核对当前正文与 Revision 一致、旧 ID 与 URL 保持。
5. 完成隔离 Preview 与正式候选检查后恢复写入；管理 API 只对显式授予的 Key 生效，上线脚本不得扩大旧 Key 权限；旧客户端仍可创建（已验）。
6. 回滚红线：只允许回滚到同时维护访问版本、发布状态、授权与维护闸语义的已验证兼容版本；保留新 schema，不做破坏性 down migration；无合格目标时保持维护并向前修复。数据库恢复按 [备份与恢复](backup-restore.md)：恢复库先保持私有/写维护，逐项核对恢复点后的撤销、保护变更与历史清除，无法核对的 Share 保持下架、managed Key 停用，由所有者逐项重新允许。

## 未执行的生产动作（明确清单）

- 未部署任何环境（无 Preview、无 Production）；`docs/deployment.md` 的 Vercel 验证清单未在真实部署上执行。
- 未对任何生产/Preview 数据库执行迁移、回填、备份或恢复；全部数据库动作仅发生在 127.0.0.1 的 `_test` 库。
- 未推送任何分支、未开/合并任何 PR、未修改或关闭父规格 Issue #24 与任何票面 Issue。
- 未把客户端安装到任何位置；未触碰任何已安装的 skill 副本。

## 未验证事项（及原因）

- **客户端 Bash 3.2 实机执行**：本机只有 Bash 5.2；T16–T18 已以构造纪律 + 静态审计保证兼容性，本票未新增客户端代码，未能实机运行 3.2，特此沿袭声明。
- **客户端触发评估工具（trigger_eval）**：位于未获取的 `namoo-skill-creator` skill，本票只做了 evals 用例一致性复核（与 T17/T18 相同的限制）；客户端自测 76/76 已覆盖触发之外的行为面。
- **真实部署环境**（Vercel/域名/防火墙规则）：无部署授权，不在本票范围。

## 操作者职责（发布时）

- **所有者（用户）**：发出发布指令；决定 PR 链（服务端 #44–#58、客户端 namoo-agents #2、#3 及后续）的合并顺序与时机；在恢复场景下逐项重新允许恢复出的 Share 与 managed Key。
- **迁移执行者**：在可信主机/CI 注入 direct owner URL 执行 `db:migrate` 与基线回填，执行后立即移除 secret；核对台账 001–010 与 `share_grants` 形状（见部署指南步骤 4）。
- **运维执行者**：用 `db:maintenance` CLI（唯一入口）控制写维护；基线切换前确认旧写入者退出可写路径并留存证据；恢复时先置维护、跑 `db:verify-backup`，`safeToServe` 不为 false 才进入所有者复核——工具永远不会自行把恢复库置为可服务。
- **验收者**：发布后按部署指南验证清单复核，并抽查一条 Share 的访问版本、发布状态与授权在后台/API/CLI 三处一致（父规格 User Story 40）。

## 证据索引

全部位于 `~/workspace/quickshare-t19/evidence/`：

| 文件 | 内容 |
|---|---|
| `01-npm-test.log` | 服务端 `npm test` 435/435 |
| `02-postgres-test.log` / `02b-postgres-test-full.log` | Postgres 套件首跑（2 skip 及原因）与补齐工具后 102/102 |
| `03-client-selftest.log` | 客户端自测 76/76 |
| `04a-migrations.log` | 空库迁移 applied 10 / 复跑 skipped 10 |
| `04-joint-chain.log` | 联合链路 + 竞争 + 写维护 40/40 |
| `05a`–`05h` | 备份复核全程：准备、备份点快照、备份、备份点后变更、恢复回执（`safeToServe:false`）、源/恢复对照、核对报告、恢复实例探针 4/4 |
| `06-db-failure.log` | 故障行为 12/12 |
| `07-scale.log` | 容量 11/11（含耗时与 EXPLAIN 结论） |
| `08-backfill.log` | 回填首跑 2 / 复跑 skipped 2 |
| `09-browser.log` | 浏览器验收 9/9（含 Tab 轨迹与各 Preset 实测值） |
| `10-old-writer.log` | 旧写入者兼容与危害实证 7/7 |
| `11-driver-hashes.txt` | 全部验收驱动的 SHA-256 |
