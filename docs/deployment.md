# 部署指南

## Vercel 部署（推荐）

### 环境变量

```bash
NODE_ENV=production
AUTH_ENABLED=true
ADMIN_PASSWORD_HASH=<generated-password-hash>
ADMIN_DASHBOARD_PASSWORD_HASH=<generated-dashboard-password-hash>
SESSION_SECRET=<at-least-32-byte-random-secret>
DATABASE_URL=<postgres-connection-string>
```

生成管理员密码 hash：

```bash
npm run hash-password -- "your-admin-password"
```

说明：
- 系统有两层独立认证：**前端登录**（`/login`，在首页开关为“需要密码”时控制首页创建/预览）和**管理后台**（`/admin/login`，控制 pages/stats/audit）。
- `ADMIN_PASSWORD_HASH` 控制前端登录，`ADMIN_DASHBOARD_PASSWORD_HASH` 控制管理后台；生产只接受 `npm run hash-password` 生成的 scrypt hash，明文变量仅限本地开发。
- 生产必须保持 `AUTH_ENABLED=true`。是否要求首页密码由 `/admin/stats` 的持久化开关控制；不要用 `AUTH_ENABLED=false` 代替该开关，因为它会关闭全部认证边界。
- `DATABASE_URL` 使用运行时 pooled URL。应用运行时不需要 schema owner 权限。
- direct owner URL 只允许在可信迁移主机或 CI job 中临时注入 `npm run db:migrate`，不要保存到 Vercel、应用容器或其他长期运行环境。迁移命令优先读取 `DATABASE_MIGRATION_URL`，也识别 `DATABASE_URL_UNPOOLED` 或 `POSTGRES_URL_NON_POOLING`；连接统一使用 `sslmode=verify-full`。
- `SESSION_SECRET` 用于签名所有认证 cookie 和 CSRF token，必须是至少 32 bytes 的随机值，且不能使用示例占位符。
- 未设置 `DATABASE_URL` 时，本地开发会使用内存仓库；生产环境会立即启动失败，绝不把内存仓库当持久数据源。
- 应用运行时不执行 `CREATE` / `ALTER`；schema 只能通过 `npm run db:migrate` 变更。
- Vercel Git 集成会在 `main` 更新后自动部署。凡应用代码会读取新字段，必须在合并或推送该代码前，先让旧应用保持在线并完成兼容性迁移与回读；部署显示 `READY` 不能替代 schema 验证。

### 步骤

1. 在 Vercel 导入仓库并创建 Postgres 存储，推荐 Neon 集成。
2. 配置上方运行时环境变量，确认 `DATABASE_URL` 使用 pooled、非 owner 账号。Preview 必须使用独立 provider branch 或独立测试数据库，不得连接生产数据库。
3. 在可信迁移主机或一次性 CI job 中临时执行：

   ```bash
   DATABASE_MIGRATION_URL='<direct-owner-postgres-url>' npm run db:migrate
   DATABASE_MIGRATION_URL='<direct-owner-postgres-url>' npm run db:migrate
   ```

   首次执行应列出 applied；紧接着的第二次必须全部 skipped。命令结束后立即移除该 job 的 secret 和环境变量。
4. 核对 `public.quickshare_schema_migrations` 的 `001`–`010` 版本及 checksum，并读回关键 schema 与数据：`pages.access_revision`（004，精确 BIGINT）、`publishing_writes_paused`（005，既有维护状态不得重置）、`api_keys.credential_version`（006，正 BIGINT，初始为 1，既有 ID/hash 保持）、`current_revision` / `published` / `share_revisions`（007；Revision 指针为正 BIGINT，`published` 为 `BOOLEAN NOT NULL DEFAULT TRUE`，新 Share 同事务写入 Revision 1；存量基线只按 [Revision 切换手册](revisions-rollout.md) 在受控维护窗口回填）、`publish_operations`（008，幂等操作及回执/删除墓碑）、`share_revisions.purged_at` 与 `publish_operations.purged_at`（009，清除墓碑和回执清除时刻）、以及 `api_keys.scopes`、`auto_grant_new_share_edit`、`share_grants`（010，逐 Share 读取/编辑/发布授权）。同时确认 `pages.is_favorite` 为 `BOOLEAN NOT NULL DEFAULT FALSE` 且无 `NULL`，`site_settings.id=1` 存在且 `homepage_password_required` 未改变；比对 revisions/当前指针、下架状态、Key scopes 与 grants、发布操作/墓碑、审计和设置记录数。不得仅凭迁移命令成功或部署状态替代读回证据。
5. 在本地创建已审查的 release commit，但先不要 push `main`；从该 commit 部署 Preview 并完成下方 smoke。
6. Preview 通过后才把同一 commit push 到 `main`，等待 CI 和 Vercel Production 自动部署，再用 `vercel inspect` 核对自定义域名指向该修订。

全新空库直接按 1–6 执行，不需要备份步骤。已有数据的升级应先创建 provider branch、PITR 检查点或等价备份，保持旧应用在线完成迁移与核对，再部署新代码。

### 回滚与恢复

- 迁移命令在 `COMMIT` 前失败：整批事务自动回滚，不会留下迁移记录；修正原因后重跑即可，无需数据恢复。
- 新代码部署后需要回滚：只能使用已验证、能正确解释维护闸、`access_revision`、内容 revisions、`published`、managed-Key `credential_version`、`publish_operations`、清除墓碑及 Key scopes/grants 的兼容应用。忽略其中任一持久化语义的旧版本都不是安全回滚候选；没有兼容候选时保持维护并发布 forward-fix。保留现有 schema 与迁移台账，不执行破坏性 down migration。
- `COMMIT` 后确认发生数据异常：先停止写入，再从迁移前的 provider branch / PITR 检查点恢复到新的隔离分支；按 [原生备份与恢复演练](backup-restore.md) 核对 snapshot、数据、迁移台账和快照后撤销/清除事件。恢复验证保持 `safeToServe: false` / offline-by-default；所有者完成人工 reconciliation 并核实 readback 前，不得切换运行时连接或重新启用内容。不得在未核验的生产主库上直接覆盖恢复。

### 写维护与旧写入者退出

迁移 `005` 只新增运维状态，不提供普通用户配置项。受控运维主机临时注入 `DATABASE_MIGRATION_URL`，使用 `npm run maintenance -- pause|status|resume`；CLI 不加载 `.env` 或回退内存。pause 的成功输出发生在同一数据库事务取得排他维护锁、排空既有发布事务并提交之后。

**滚动部署不是排空证明。**旧部署、旧函数实例与旧 CLI 若不认识维护闸，必须先退出可写路径，并通过连接身份、在途事务与锁状态证明确已排空。无法确认时维持维护状态，不继续迁移、回填或开放；`status=true` 不能替代这些证据。迁移后、恢复写入前，操作者须读回并核验 `001`–`010` 台账/checksum、关键列/表、Revision 指针与下架状态、Key scopes/grants、发布操作/清除墓碑及站点维护值；再次运行迁移应全部 skipped。核验不一致时保持维护并 forward-fix，不回滚到忽略新语义的旧写入者。公开/管理读取与登录保持可用，符合访问条件的写请求和浏览事件返回 `PUBLISHING_MAINTENANCE` 503，事件不计数。详细步骤、错误恢复及回滚边界见 [写维护手册](maintenance.md)。

### 原生备份与恢复演练

管理后台的「导出清单」只是元数据清单（不含 Share 正文，不可独立恢复）；完整备份使用 PostgreSQL 原生一致性备份，并必须先在隔离库完成可复验的恢复演练：

- `npm run backup:check` 端到端演练：一次性本地 PostgreSQL 17 容器 + 合成夹具 + `pg_dump`/`pg_restore` + 全量验证（正文摘要、ID、主题、收藏、密码校验/回显、有效期、Key、审计、站点设置、迁移台账），并记录快照点与耗时。恢复库中每条受保护页/Key 都必须被夹具实际验证，缺夹具即显式失败。
- 恢复出的数据库永远报告 `safeToServe: false` 并保持离线。快照点后检测到撤销/清除事件（含真实审计词表中 `page.update` 的 `fields` 触及密码/保护/有效期）时验证 exit 2（`unreconciled`）；即使未检测到事件，审计历史也无法证明不存在（部分策略路由不写审计），报告为 `owner-review-required`（同样 exit 2）。重新启用恢复出的凭据或公开内容一律需要所有者复核后显式传入 `--reconciled`。
- 脚本默认只接受 localhost 且库名以 `_test` 结尾的数据库；真实 secret 与加密材料不进入导出、日志或演练夹具。
- 详细流程、实测结果与后续票扩展合同见 `docs/backup-restore.md`。访问版本化改造（`docs/access-revision-rollout.md`，由访问撤销票提供）落地后，恢复验证证据必须显式覆盖 `access_revision`。迁移 `005` 后夹具还应覆盖非默认 `publishing_writes_paused=true`；迁移 `006` 后显式比较 Key `credential_version='9007199254740993'`，把快照后轮换视为旧 secret 撤销，恢复后保持离线，不把暂停开关或验证通过等同于上线许可。迁移 `007` 后夹具还须真实生成 Revision 快照、超过 2^53 的 `current_revision` 指针与非默认 `published=FALSE`，验证报告的 `shareRevisions`/`revisionCurrentPointer` 检查必须通过，且快照载荷/指针/`published` 的独立篡改分别被具名检查拒绝。

### 验证清单

- `/login` 可以登录（前端密码）。
- `/admin/login` 可以登录（管理后台密码）。
- 首页创建 HTML 分享成功。
- 首页创建 Markdown 分享成功。
- 密码保护页面不会把密码放入 URL query。
- 分享内容在 sandbox iframe 中渲染。
- 未登录无法调用管理写接口。
- `/admin/stats` 统计面板正常加载。
- `/admin/stats` 显示真实的首页访问状态；关闭密码前出现确认框，取消不会写入。
- 切到公开模式后，匿名 `GET /` 成功，同源创建/预览成功，缺失或跨源 `Origin` 返回 403。
- 切回需要密码后，新匿名请求立即受限，已有有效首页会话仍可用至过期。
- `/admin/pages` 页面列表分页/搜索/过滤正常。
- 列表与详情页可以用键盘收藏和取消收藏，忙碌、成功与失败状态均可观察；失败时保留原状态。
- `favorite=true` 可与搜索、类型、保护状态、日期、排序和分页组合；在 Favorite Shares 中取消收藏后由服务端重新计算行、总数和页码。
- 管理导出为元数据清单（含布尔 `isFavorite`，不含正文），真实状态变化产生一次 `page.favorite.update` 审计，幂等提交不重复审计。
- 公开查看、密码验证、过期、浏览事件、近期列表、统计和 Share API 均不接受或泄露 Favorite Share 元数据。
- `POST /api/v1/share` 带有效 `X-API-Key` 可创建分享并返回 URL。
- `POST /api/v1/share` 不带或带错误 key 返回 401。
- `/admin/apis` 轮换后 ID 保持，新 secret 可用、旧 secret 返回 401；失败/维护响应不得包含新 secret。轮换需后台会话及 CSRF，成功回执只在 COMMIT 后发出。
- `GET /api/v1/me`、`GET /api/v1/capabilities` 在维护期间仍可用，但仅接受有效 API Key。实际能力、请求字节上限与 create-only 边界见 [能力合同](api-capabilities.md)。

### 请求边界与 Vercel Firewall

- 登录、密码校验和小型管理请求默认限制为 `16kb`。
- 分享创建和后台正文更新默认限制为 `2mb`。2026-07-14 的生产只读统计为 174 条记录，p99 约 319 KB、最大约 329 KB，因此 2 MB 对现有内容有充足余量。
- 超限请求由应用返回 `413` 和统一 JSON 错误；不要把全局解析上限重新放大。
- Vercel Hobby 计划只有一条 Rate Limit 规则额度。当前规则 `QuickShare sensitive writes` 仅匹配以下 POST 路径：`/login`、`/admin/login`、`/view/:id/password`、`/api/pages/create`、`/api/pages/preview`、`/api/v1/share`。
- 规则使用 IP 固定窗口：`20 requests / 60 seconds`；同一 IP 在上述 6 个匹配路径之间共享计数。超限动作必须保持默认 Rate Limit（HTTP `429`），不要改成 Deny（HTTP `403`）。
- 在 Vercel Firewall 的 Traffic/Security Events 中观察 `429` 和正常请求量；如出现正常用户误伤，先基于数据调整阈值，不要增加应用进程内的内存计数器。
- 回滚时可独立禁用或删除该 Firewall 规则；应用请求上限和响应头不依赖它。

### `/view` 性能日志

- 每次 `GET /view/:id` 只输出一条 JSON 事件，`event` 固定为 `quickshare.view`，`route` 固定为 `/view/:id`；HEAD 会记录真实 `method=HEAD`，统计 GET 基线时按 `method=GET` 过滤。
- 可聚合字段包括 `total_ms`、`db_ms`、`render_ms`、`response_bytes`、`content_type`、`protected`、`outcome`、`status` 和 `cold_start`。
- `cold_start` 只表示当前函数实例收到的第一条 `/view` 请求；p50 / p95 必须在日志平台按时间窗口聚合，应用进程不保存统计结果。
- 日志不包含分享 ID、query、cookie、标题、正文、密码或完整错误对象。动态密码路由在普通访问日志中固定显示为 `/view/:id/password`，Referer 中的动态分享路径也会改写为固定模板。

### 浏览量事件

- `GET /view/:id` 只读取并返回页面，不更新 `view_count`；所有公开分享响应均为 `Cache-Control: private, no-store`，以保持编辑、删除和过期语义即时生效。
- 成功渲染的分享页会在 DOM 就绪后通过本地脚本向 `POST /view/:id/view-event` 上报一次。脚本优先使用 `sendBeacon`，不可用时回退到 `fetch(..., { keepalive: true })`；上报失败不会影响内容展示。
- 事件端点只接受同源 Origin。受保护页面还必须携带有效的页面访问 cookie；缺失、过期和未解锁页面不会计数。启用认证时，只有带有效后台会话的 `adminPreview` 才免计数，公开访问者不能通过 query 绕过；关闭认证意味着后台本身公开，只应用于本地或受控环境。
- PostgreSQL 正常路径使用一条带过期和保护条件的 `UPDATE`，不会再次读取 `html_content` 或密码字段；失败路径仅查询 `is_protected` 和 `expires_at` 来确定状态。
- 浏览量属于近似产品分析：禁用 JavaScript、页面在上报前关闭或网络失败时可能漏记。不要把它用于计费或安全审计，也不要把运行时缓存当作计数真相。

静态文件的五分钟浏览器缓存策略同时配置在 Express 和 `vercel.json`。Vercel 会直接托管 `public/` 文件并绕过 Express 静态中间件，因此每次改动该策略后都要检查部署 URL 的真实响应头。

### 本地预检

```bash
npm install
npm test
```

用一次性本地 Postgres 验证真实迁移：

```bash
POSTGRES_TEST_URL='postgresql://postgres:password@127.0.0.1:5432/issue39_api_publish_test?sslmode=disable' \
  npm run test:postgres
```

`npm run test:postgres`、所有直接使用 `POSTGRES_TEST_URL` 的破坏性 integration entry，以及独立 `node scripts/release-readiness-check.js` 都要求精确的 actor-owned 数据库 `issue39_api_publish_test`；每个入口均在启动子测试、构造 pool 或执行 DDL 前验证目标。底层通用 `validatePostgresTestUrl()` 仍接受其它 loopback `_test` 名称，供使用独立 `POSTGRES_BACKUP_TEST_SRC_URL` / `POSTGRES_BACKUP_TEST_RESTORE_URL` 的 backup/drill fixture owner 使用；这不授权 canonical suite 使用这些数据库。未设置 `QUICKSHARE_TEST_CLIENT_ROOT` 时，客户端生命周期和 10× scale/restore 两项会明确标记为 skipped，数据库故障测试仍运行；这不等于完整 #43 发布门。独立 checker 还要求干净 pinned checkout（commit `2eec5060c1f7e10e7849fe6085f673d5db72e038`），并拒绝任何 skip：

```bash
QUICKSHARE_TEST_CLIENT_ROOT=/path/to/clean/quickshare-client-checkout \
POSTGRES_TEST_URL='postgresql://postgres:password@127.0.0.1:5432/issue39_api_publish_test?sslmode=disable' \
  node scripts/release-readiness-check.js
```

也可在完整 PostgreSQL 套件中 opt-in 客户端相关用例：

```bash
QUICKSHARE_TEST_CLIENT_ROOT=/path/to/clean/quickshare-client-checkout \
POSTGRES_TEST_URL='postgresql://postgres:password@127.0.0.1:5432/issue39_api_publish_test?sslmode=disable' \
  npm run test:postgres
```

如安装了 Vercel CLI，也可以本地模拟：

```bash
vercel dev
```

## Docker 部署

> **注意**：当前 Docker 配置未包含 Postgres 服务。生产容器必须连接外部 Postgres，并在启动应用前从可信主机执行 `npm run db:migrate`；缺少 `DATABASE_URL` 时容器会安全退出。

### 快速启动

```bash
docker-compose up -d
```

访问 `http://localhost:8888`。

### 自定义端口

修改 `docker-compose.yml` 中的端口映射：

```yaml
ports:
  - "5678:8888"
```

### 管理命令

```bash
docker-compose logs -f      # 查看日志
docker-compose down          # 停止
docker-compose up -d --build # 更新并重启
```

### 环境变量

在 `docker-compose.yml` 的 `environment` 中添加：

```yaml
- ADMIN_PASSWORD_HASH=<hash>
- ADMIN_DASHBOARD_PASSWORD_HASH=<hash>
- SESSION_SECRET=<secret>
- DATABASE_URL=<pooled-postgres-url>
```

direct owner URL 不进入以上容器运行时环境；在启动或升级容器前，从可信主机临时注入迁移命令并在完成后清除。

## 全部可用环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `NODE_ENV` | 是 | `production` / `development` / `test` |
| `PORT` | 否 | 默认 5678（dev）/ 3000（prod） |
| `AUTH_ENABLED` | 否 | 默认 `true`；设为 `false` 会关闭所有认证，仅限本地或受控环境，不能用于切换首页公开状态 |
| `AUTH_PASSWORD` | 否 | 明文前端密码，仅开发环境 |
| `ADMIN_PASSWORD_HASH` | 生产环境 | 前端密码 hash，优先于 `AUTH_PASSWORD` |
| `ADMIN_DASHBOARD_PASSWORD` | 否 | 明文管理后台密码，仅开发环境（默认 `dashboard123`） |
| `ADMIN_DASHBOARD_PASSWORD_HASH` | 生产环境 | 管理后台密码 hash，优先于 `ADMIN_DASHBOARD_PASSWORD` |
| `SESSION_SECRET` | 生产环境 | 至少 32 bytes 的随机值，用于签名 cookie 和 CSRF token；示例占位符会被拒绝 |
| `DATABASE_URL` | 生产环境 | 运行时 pooled Postgres URL；生产缺失时启动失败 |
| `DATABASE_MIGRATION_URL` | 迁移时 | direct owner URL；只在可信迁移主机/CI 临时注入，禁止存入应用运行时环境 |
| `DATABASE_URL_UNPOOLED` / `POSTGRES_URL_NON_POOLING` | 迁移时 | direct URL 别名；仅可信迁移 runner 使用，不由应用请求路径读取 |
| `POSTGRES_URL` | 否 | `DATABASE_URL` 的别名，两者设置其一即可 |
| `POSTGRES_SSL` | 否 | 默认使用 `sslmode=verify-full`；仅本地测试设为 `false` |
| `POSTGRES_POOL_MAX` | 否 | 连接池大小，合法范围 1–10，默认 `3` |
| `POSTGRES_CONNECTION_TIMEOUT_MS` | 否 | 获取连接上限，默认 `2500` ms |
| `POSTGRES_IDLE_TIMEOUT_MS` | 否 | 空闲连接回收，默认 `10000` ms |
| `POSTGRES_STATEMENT_TIMEOUT_MS` | 否 | 服务端语句上限，默认 `4000` ms |
| `POSTGRES_QUERY_TIMEOUT_MS` | 否 | 客户端查询上限，默认 `4500` ms |
| `POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS` | 否 | 空闲事务上限，默认 `5000` ms |
| `BASE_URL` | 否 | 管理端公开 URL |
| `SHARE_BASE_URL` | 否 | 分享页公开 URL，默认同 `BASE_URL` |
| `SECURE_COOKIES` | 否 | 默认生产环境为 `true` |
| `LOG_LEVEL` | 否 | 默认 `dev`（开发）/ `combined`（生产） |
| `SHARE_API_KEY` | 否 | `POST /api/v1/share` 的 API Key 鉴权，未设置则该端点返回 503 |
| `SMALL_BODY_LIMIT` | 否 | 登录、密码及小型 JSON/form 请求上限，默认 `16kb` |
| `SHARE_BODY_LIMIT` | 否 | 分享正文和后台正文更新上限，默认 `2mb`；调整前先核对生产内容分布 |
| `UI_THEME` | 否 | UI 主题，可选 `default` / `hacker` / `cyberpunk` / `popart`，默认 `default` |
