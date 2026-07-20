# QuickShare 项目规则

## 技术栈

Express 4 + EJS + PostgreSQL (生产) / 内存 (开发)。部署在 Vercel。

## 关键约定

- 仓库选择在 `models/pageRepository.js`；本地无 `DATABASE_URL` 时可用内存，生产缺失持久数据库时必须启动失败。
- 数据库 schema 只通过 `db/migrations/` 与 `npm run db:migrate` 更新，业务请求和服务启动不得执行 DDL。
- 认证分两层：
  - **前端登录**（`/login`）：签名 cookie `admin_session`，用于首页创建分享。中间件 `requireAdmin`。
  - **管理后台**（`/admin/login`）：签名 cookie `dashboard_admin_session`，用于 pages/stats/audit 管理。中间件 `requireDashboardAdmin`。
- 两层密码独立配置（`AUTH_PASSWORD` / `ADMIN_PASSWORD_HASH` vs `ADMIN_DASHBOARD_PASSWORD` / `ADMIN_DASHBOARD_PASSWORD_HASH`）；明文形式只允许本地开发，生产只接受 scrypt hash。
- 写操作必须带 CSRF token（`requireCsrf` 中间件，auth 关闭时跳过）。
- API 端点（`POST /api/v1/share`）使用 `X-API-Key` header 鉴权（`requireApiKey` 中间件），不走 cookie/CSRF，供 CLI 和 Skill 调用。
- `trust proxy` 已启用（Vercel 边缘终止 TLS，需读 `x-forwarded-proto`）。
- 用户提交的内容通过 sandbox iframe 渲染，与管理端同源隔离。
- 内容类型限 `html`、`markdown`、`svg`、`mermaid` 四种（见 `VALID_CODE_TYPES`）。
- 入口分两个：`server.js`（本地）和 `api/index.js`（Vercel function），都指向 `app.js`。
- Markdown 渲染支持多主题（`markdown_theme` 字段），主题 CSS 在 `public/css/markdown-*.css`。
- UI 主题系统（`UI_THEME` 环境变量）支持 `default`、`hacker`、`cyberpunk`、`popart`。
- 管理后台支持审计日志（`createAuditLog`）、批量删除、页面克隆、页面导出（JSON）、浏览量统计。

## 路由清单

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/` | requireAdmin | 首页（创建分享） |
| GET/POST | `/login` | — | 前端登录/登出 |
| GET | `/logout` | — | 清除前端登录 cookie |
| GET/POST | `/admin/login` | — | 管理后台登录 |
| GET | `/admin/logout` | — | 清除管理后台登录 cookie |
| GET | `/admin` | — | 重定向到 stats 或 login |
| GET | `/admin/stats` | requireDashboardAdmin | 统计面板 |
| GET | `/admin/pages` | requireDashboardAdmin | 页面列表（搜索/过滤/排序/分页） |
| GET | `/admin/pages/export` | requireDashboardAdmin | 导出页面 JSON |
| GET | `/admin/pages/:id` | requireDashboardAdmin | 页面详情 |
| PUT | `/admin/pages/:id` | requireDashboardAdmin | 更新页面 |
| DELETE | `/admin/pages/:id` | requireDashboardAdmin | 删除页面 |
| DELETE | `/admin/pages/batch` | requireDashboardAdmin | 批量删除（最多 100） |
| POST | `/admin/pages/:id/clone` | requireDashboardAdmin | 克隆页面 |
| GET | `/admin/audit` | requireDashboardAdmin | 审计日志 |
| POST | `/api/pages/create` | requireApiAdmin + CSRF | 前端创建分享 |
| GET | `/api/pages/list/recent` | requireApiAdmin | 最近页面列表 |
| GET | `/api/pages/:id` | — | 获取页面元信息 |
| POST | `/api/pages/:id/protect` | requireApiAdmin + CSRF | 设置/取消密码保护 |
| POST | `/api/v1/share` | requireApiKey | API 创建分享 |
| GET | `/view/:id` | — | 查看分享页（密码页检查） |
| POST | `/view/:id/password` | — | 验证页面密码 |
| POST | `/view/:id/view-event` | 同源 Origin；受保护页面需访问 cookie | 近似浏览量上报 |

## 目录结构速查

```text
api/             Vercel function 入口
app.js           Express app 工厂，所有路由定义在此
config.js        环境变量聚合
server.js        本地服务器入口
vercel-app.js    Vercel 构建时使用的 app 包装
models/          数据层（pageRepository 选择器 + Postgres / 内存仓储 + 迁移与连接配置）
db/migrations/  编号 SQL 迁移；应用部署前显式执行
views/           EJS 模板（index / login / password / admin-* / error / partials/）
middleware/      中间件（auth.js: isAuthenticated）
routes/          路由模块（pages.js 已废弃，返回 410）
session/         会话存储（vercel-kv-store.js 未使用的死代码）
public/          静态资源（css/ js/ icon/）
  css/           styles.css + login.css + markdown-*.css（bytedance / github / apple / notion / claude）
  js/            main.js + login.js + password.js + view-event.js + admin*.js + paste-fix.js + theme.js
utils/           security.js（token/CSRF/hash/encrypt）、contentRenderer.js、codeDetector.js、pageTitle.js
scripts/         hash-password.js
test/            Node test runner（5 个测试文件）
docs/            deployment.md
DESIGN.md        后台 UI 设计稿（Toast / Tab / Markdown 主题选择器 + 4 套主题规范）
Dockerfile       Docker 构建文件
docker-compose.yml
```

## 测试

```bash
npm test
```

覆盖：内容类型检测、fenced code block 提取、密码 hash 校验、signed token scope 校验、CSRF 绑定校验、Share API、admin 路由、admin 仓库。

## 安全边界

- 生产环境必须设置 `ADMIN_PASSWORD_HASH` 和 `ADMIN_DASHBOARD_PASSWORD_HASH`。两者必须由 `npm run hash-password` 生成，生产拒绝明文形式。
- `SESSION_SECRET` 用于签名所有认证 cookie 和 CSRF token，生产环境必须设置至少 32 bytes 的非占位随机值。
- `AUTH_PASSWORD`（明文）仅限开发环境，生产环境会被 `config.js` 拒绝。
- `SHARE_API_KEY` 用于 `POST /api/v1/share` 的 API Key 鉴权，未设置时该端点返回 503。
- sandbox iframe 只允许脚本执行，不允许同源访问父页面 DOM/cookie。
- 页面密码支持自定义（4-12 个允许的 ASCII 字符）或自动生成（6 位数字），密码以 hash 存储、以 encrypt 存储（供管理后台回显）。
- 页面访问通过 `page_access_{id}` 签名 cookie 控制，有效期 24 小时。
- `GET /view/:id` 必须保持只读；浏览量由同源 `POST /view/:id/view-event` 近似记录，数据库正常路径不得再次读取正文。

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `nardinmarcus/quickshare`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the standard five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository with a root `CONTEXT.md` and root-level `docs/adr/` when ADRs are needed. See `docs/agents/domain.md`.
