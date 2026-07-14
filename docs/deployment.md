# 部署指南

## Vercel 部署（推荐）

### 环境变量

```bash
NODE_ENV=production
AUTH_ENABLED=true
ADMIN_PASSWORD_HASH=<generated-password-hash>
ADMIN_DASHBOARD_PASSWORD_HASH=<generated-dashboard-password-hash>
SESSION_SECRET=<long-random-secret>
DATABASE_URL=<postgres-connection-string>
```

生成管理员密码 hash：

```bash
npm run hash-password -- "your-admin-password"
```

说明：
- 系统有两层独立认证：**前端登录**（`/login`，控制首页创建分享）和**管理后台**（`/admin/login`，控制 pages/stats/audit）。
- `ADMIN_PASSWORD_HASH` / `AUTH_PASSWORD` 控制前端登录；`ADMIN_DASHBOARD_PASSWORD_HASH` / `ADMIN_DASHBOARD_PASSWORD` 控制管理后台。
- `DATABASE_URL` 推荐来自 Vercel Marketplace 的 Neon Postgres 集成。
- `SESSION_SECRET` 用于签名所有认证 cookie 和 CSRF token，由 `utils/security.js` 读取。
- 未设置 `DATABASE_URL` 时，本地开发会使用内存仓库；Vercel 生产环境应始终设置 `DATABASE_URL`。

### 步骤

1. 在 Vercel 导入仓库。
2. 创建 Postgres 存储，推荐 Neon 集成。
3. 配置上述环境变量。
4. 部署。

### 验证清单

- `/login` 可以登录（前端密码）。
- `/admin/login` 可以登录（管理后台密码）。
- 首页创建 HTML 分享成功。
- 首页创建 Markdown 分享成功。
- 密码保护页面不会把密码放入 URL query。
- 分享内容在 sandbox iframe 中渲染。
- 未登录无法调用管理写接口。
- `/admin/stats` 统计面板正常加载。
- `/admin/pages` 页面列表分页/搜索/过滤正常。
- `POST /api/v1/share` 带有效 `X-API-Key` 可创建分享并返回 URL。
- `POST /api/v1/share` 不带或带错误 key 返回 401。

### 请求边界与 Vercel Firewall

- 登录、密码校验和小型管理请求默认限制为 `16kb`。
- 分享创建和后台正文更新默认限制为 `2mb`。2026-07-14 的生产只读统计为 174 条记录，p99 约 319 KB、最大约 329 KB，因此 2 MB 对现有内容有充足余量。
- 超限请求由应用返回 `413` 和统一 JSON 错误；不要把全局解析上限重新放大。
- Vercel Hobby 计划只有一条 Rate Limit 规则额度。当前规则 `QuickShare sensitive writes` 仅匹配以下 POST 路径：`/login`、`/admin/login`、`/view/:id/password`、`/api/pages/create`、`/api/v1/share`。
- 规则使用 IP 固定窗口：`20 requests / 60 seconds`；同一 IP 在上述 5 个匹配路径之间共享计数。超限动作必须保持默认 Rate Limit（HTTP `429`），不要改成 Deny（HTTP `403`）。
- 在 Vercel Firewall 的 Traffic/Security Events 中观察 `429` 和正常请求量；如出现正常用户误伤，先基于数据调整阈值，不要增加应用进程内的内存计数器。
- 回滚时可独立禁用或删除该 Firewall 规则；应用请求上限和响应头不依赖它。

### 本地预检

```bash
npm install
npm test
```

如安装了 Vercel CLI，也可以本地模拟：

```bash
vercel dev
```

## Docker 部署

> **注意**：当前 Docker 配置未包含 Postgres 服务。容器内会使用内存仓库，**重启后数据丢失**。如需生产级 Docker 部署，需自行添加 Postgres 服务并在 `docker-compose.yml` 中配置 `DATABASE_URL`。

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
- DATABASE_URL=<postgres-url>   # 如已配置 Postgres
```

## 全部可用环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `NODE_ENV` | 是 | `production` / `development` / `test` |
| `PORT` | 否 | 默认 5678（dev）/ 3000（prod） |
| `AUTH_ENABLED` | 否 | 默认 `true`，设为 `false` 关闭所有认证 |
| `AUTH_PASSWORD` | 否 | 明文前端密码，仅开发环境 |
| `ADMIN_PASSWORD_HASH` | 生产环境 | 前端密码 hash，优先于 `AUTH_PASSWORD` |
| `ADMIN_DASHBOARD_PASSWORD` | 否 | 明文管理后台密码，仅开发环境（默认 `dashboard123`） |
| `ADMIN_DASHBOARD_PASSWORD_HASH` | 生产环境 | 管理后台密码 hash，优先于 `ADMIN_DASHBOARD_PASSWORD` |
| `SESSION_SECRET` | 生产环境 | 签名 cookie 和 CSRF token（security.js 读取） |
| `DATABASE_URL` | 生产环境 | Postgres 连接串，不设置则用内存仓库 |
| `POSTGRES_URL` | 否 | `DATABASE_URL` 的别名，两者设置其一即可 |
| `POSTGRES_SSL` | 否 | Postgres SSL 连接，默认启用，设为 `false` 关闭 |
| `POSTGRES_POOL_MAX` | 否 | Postgres 连接池大小，默认 `3` |
| `BASE_URL` | 否 | 管理端公开 URL |
| `SHARE_BASE_URL` | 否 | 分享页公开 URL，默认同 `BASE_URL` |
| `SECURE_COOKIES` | 否 | 默认生产环境为 `true` |
| `LOG_LEVEL` | 否 | 默认 `dev`（开发）/ `combined`（生产） |
| `SHARE_API_KEY` | 否 | `POST /api/v1/share` 的 API Key 鉴权，未设置则该端点返回 503 |
| `SMALL_BODY_LIMIT` | 否 | 登录、密码及小型 JSON/form 请求上限，默认 `16kb` |
| `SHARE_BODY_LIMIT` | 否 | 分享正文和后台正文更新上限，默认 `2mb`；调整前先核对生产内容分布 |
| `UI_THEME` | 否 | UI 主题，可选 `default` / `hacker` / `cyberpunk` / `popart`，默认 `default` |
