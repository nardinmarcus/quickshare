# QuickShare 项目规则

## 技术栈

Express 4 + EJS + PostgreSQL (生产) / 内存 (开发)。部署在 Vercel。

## 关键约定

- 仓库选择在 `models/pageRepository.js`；本地无 `DATABASE_URL` 时可用内存，生产缺失持久数据库时必须启动失败。
- 数据库 schema 只通过 `db/migrations/` 与 `npm run db:migrate` 更新，业务请求和服务启动不得执行 DDL。
- 认证分两层（全部鉴权中间件均定义于 `app.js` 内，无独立 middleware 文件）：
  - **前端登录**（`/login`）：签名 cookie `admin_session`，用于首页创建分享。首页走 `requireHomepageAccess`，浏览器发布走 `requireBrowserPublishAccess` + `requireBrowserPublishCsrf`；后台站点设置可把首页切为公开模式，此时浏览器发布改为要求同源。
  - **管理后台**（`/admin/login`）：签名 cookie `dashboard_admin_session`。页面与较早的写接口用 `requireDashboardAdmin`（未登录重定向），较新的 JSON 接口用 `requireDashboardApiAdmin`（未登录 401 JSON），写操作再加 `requireDashboardCsrf`。
- 两层密码独立配置（`AUTH_PASSWORD` / `ADMIN_PASSWORD_HASH` vs `ADMIN_DASHBOARD_PASSWORD` / `ADMIN_DASHBOARD_PASSWORD_HASH`）；明文形式只允许本地开发，生产只接受 scrypt hash。
- 写操作必须带 CSRF token（`requireCsrf` 中间件，auth 关闭时跳过）。
- `/api/v1/*` 使用 `X-API-Key` header 鉴权（`requireApiKey`），不走 cookie/CSRF，供 CLI 和 Skill 调用。凭据分两类：后台托管的 managed Key（scope 由 `requireApiScope` / `requireApiScopesAll` 校验，按 Share 的 grant 由 Repository 判定，两者合取才放行）与环境变量 `SHARE_API_KEY` 的 legacy Key（仅可创建）。合同见 `docs/api-capabilities.md` 与 `docs/spec-24-excerpts.md`。
- `trust proxy` 已启用（Vercel 边缘终止 TLS，需读 `x-forwarded-proto`）。
- 用户提交的内容通过 sandbox iframe 渲染，与管理端同源隔离。
- 内容类型限 `html`、`markdown`、`svg`、`mermaid` 四种（见 `VALID_CODE_TYPES`）。
- 入口分两个：`server.js`（本地）和 `api/index.js`（Vercel function），都指向 `app.js`。
- Markdown 渲染支持多主题（`markdown_theme` 字段），主题 CSS 在 `public/css/markdown-*.css`。
- UI 主题系统（`UI_THEME` 环境变量）支持 `default`、`hacker`、`cyberpunk`、`popart`。
- 管理后台支持审计日志（`createAuditLog`）、批量删除、页面克隆、页面导出（JSON）、浏览量统计。
- Favorite Share 是 PostgreSQL 持久化的管理端全局二元状态；列表与详情共用 `PUT /admin/pages/:id/favorite`，公开页面和 Share API 不投影该字段。

## 路由清单

路由与中间件链全部在 `app.js`，以代码为准：`rg -n '^app\.(get|post|put|delete)\(' app.js`。按前缀的鉴权分族：

| 前缀 | 鉴权 | 说明 |
|------|------|------|
| `/login` `/logout` `/admin/login` `/admin/logout` | — | 两层登录/登出 |
| `/` | requireHomepageAccess | 首页（创建分享），可由站点设置切为公开 |
| `/api/pages/create`、`/api/pages/preview` | requireBrowserPublishAccess + requireBrowserPublishCsrf | 首页发布与预览 |
| `/api/pages/list/recent`、`/api/pages/:id/protect` | requireApiAdmin（protect 另加 requireCsrf） | 前端会话的兼容接口，仓库内无调用方但作为公开边界保留 |
| `/admin/*` 页面与较早的写接口 | requireDashboardAdmin | 列表、详情、统计、审计、导出、修订预览；页面更新/删除/批量删除/克隆、API Key 管理 |
| `/admin/*` 较新的 JSON 接口 | requireDashboardApiAdmin | 收藏、修订历史/恢复/清除、上下架、撤销访问、站点设置、grant 列表、操作回执 |
| `/api/v1/*` | requireApiKey + scope/grant | Share API（创建、读取、更新、历史、恢复、上下架、me、capabilities、operations） |
| `/api/pages/:id`、`/view/:id`、`/view/:id/password` | — | 公开元信息、查看、解锁 |
| `/view/:id/view-event` | 同源 Origin；受保护页面需访问 cookie | 近似浏览量上报 |

## 目录结构速查

```text
api/             Vercel function 入口（api/index.js）
app.js           Express app，所有路由与鉴权中间件定义在此
config.js        环境变量聚合与生产启动校验
server.js        本地服务器入口
vercel-app.js    仓库内无引用；确认 Vercel 项目设置未使用后可删除
models/          数据层（pageRepository 选择器 + Postgres / 内存仓储 + 迁移、连接配置、publishing）
db/migrations/   编号 SQL 迁移；应用部署前显式执行，已应用的迁移不可修改（checksum 校验）
views/           EJS 模板（index / login / password / admin-* / error / partials/）
public/          静态资源（css/ js/ icon/）
  css/           styles.css + login.css + markdown-<preset>.css（目录见 utils/markdownThemeCatalog.js）
  js/            首页 main.js / publish-intent.js，后台 admin*.js / source-diff.js / diff-worker.js，公开页 password.js / view-event.js，vendor/
utils/           security、contentRenderer、codeDetector、publicProjection、shareAccess、shareGrants、idempotency、contentRevision 等
scripts/         运维 CLI（db:migrate / maintenance / backup / restore / verify-backup 等，见 package.json scripts）与回填脚本
test/            Node test runner（HTTP/Repository/UI 行为测试 + integration/ PostgreSQL 套件）
docs/            部署、备份恢复、维护、API 能力、spec #24 摘录、ADR，以及已完成发布的 rollout/handover 记录
DESIGN.md        后台 UI 设计稿（Toast / Tab / Markdown 主题选择器 + 4 套主题规范）
Dockerfile       Docker 构建文件
docker-compose.yml
```

## 测试

```bash
npm test
POSTGRES_TEST_URL='postgresql://postgres:password@127.0.0.1:5432/quickshare_test?sslmode=disable' npm run test:postgres
```

覆盖：内容渲染、安全与访问策略、Share API、admin 路由、Favorite Share 交互/生命周期/公开边界，以及真实 PostgreSQL 的空库、legacy、重复迁移、Repository 与失败回滚。PostgreSQL 套件会重建 `public` schema，只能指向 localhost 且数据库名必须以 `_test` 结尾。

## 安全边界

- 生产环境必须设置 `ADMIN_PASSWORD_HASH` 和 `ADMIN_DASHBOARD_PASSWORD_HASH`。两者必须由 `npm run hash-password` 生成，生产拒绝明文形式。
- `SESSION_SECRET` 用于签名所有认证 cookie 和 CSRF token，生产环境必须设置至少 32 bytes 的非占位随机值。
- `AUTH_PASSWORD`（明文）仅限开发环境，生产环境会被 `config.js` 拒绝。
- `SHARE_API_KEY` 是可选的 legacy Key，只能创建 Share；管理能力只授予后台托管的 managed Key。
- sandbox iframe 只允许脚本执行，不允许同源访问父页面 DOM/cookie。
- 页面密码支持自定义（4-12 个允许的 ASCII 字符）或自动生成（6 位数字），密码以 hash 存储、以 encrypt 存储（供管理后台回显）。
- 页面访问通过 `page_access_{id}` 签名 cookie 控制，有效期 24 小时，并绑定 Share 的访问版本；改密码或访问策略变化后旧 cookie 立即失效。
- `GET /view/:id` 必须保持只读；浏览量由同源 `POST /view/:id/view-event` 近似记录，数据库正常路径不得再次读取正文。

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `nardinmarcus/quickshare`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the standard five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository with a root `CONTEXT.md` and root-level `docs/adr/` when ADRs are needed. See `docs/agents/domain.md`.
