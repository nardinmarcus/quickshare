# QuickShare

一个基于 Express + EJS 的内容分享工具，用来快速分享 HTML、Markdown、SVG 和 Mermaid 内容。

当前实现已按 Vercel 部署路径收敛：

- Vercel 生产环境通过 `DATABASE_URL` 使用 Postgres。
- 本地没有 `DATABASE_URL` 时自动使用内存仓库，便于开发和 smoke test。
- 管理端登录使用签名 cookie，不再依赖文件 session。
- 管理端写操作带 CSRF token。
- 分享内容通过 sandbox iframe 渲染，降低用户提交 HTML 与管理端同源执行的风险。

## 运行要求

- Node.js 20+
- npm
- Vercel 生产部署需要 Postgres，例如 Vercel Marketplace 的 Neon 集成。

## 本地开发

复制环境变量示例：

```bash
cp .env.example .env
```

启动开发服务：

```bash
npm install
npm run dev
```

默认访问：

```text
http://localhost:5678
```

如果 `.env` 中没有 `DATABASE_URL`，本地会使用内存仓库；重启后本地数据会清空。

## 部署

部署指南见 [docs/deployment.md](docs/deployment.md)，包含 Vercel（推荐）和 Docker 两种方式。

## 主要脚本

```bash
npm run dev
npm start
npm test
npm run hash-password -- "your-admin-password"
```

## 关键目录

```text
api/              Vercel function 入口
app.js            Express app 工厂和路由
config.js         环境变量聚合
server.js         本地服务器入口
vercel-app.js     Vercel 构建时使用的 app 包装
models/           数据层（Repository 选择器 + Postgres / 内存实现）
views/            EJS 模板（含 admin-* 管理后台页面）
middleware/       中间件（auth.js）
routes/           路由模块（pages.js 已废弃）
public/           静态资源（css/ js/ icon/）
utils/            security.js, contentRenderer.js, codeDetector.js, pageTitle.js
scripts/          hash-password.js
test/             Node test runner
docs/             部署指南
DESIGN.md         后台 UI 设计稿
```

## 当前安全边界

系统有两层独立认证：

- **前端登录**（`/login`）：控制首页创建分享功能。
- **管理后台**（`/admin/login`）：控制 pages 管理、统计面板和审计日志。

分享页会以 sandbox iframe 呈现用户内容，默认允许脚本执行，但不允许 iframe 拥有父页面同源权限。这样能保留 HTML 预览能力，同时避免分享内容直接读取管理页面 DOM 或同源 cookie。

如果后续要进一步增强隔离，推荐把管理端和分享页拆成两个域名：

```text
admin.example.com
share.example.com
```

## 测试

```bash
npm test
```

当前测试覆盖：

- 内容类型检测。
- fenced code block 提取。
- 密码 hash 校验。
- signed token scope 校验。
- CSRF token 绑定校验。
- Share API（创建、鉴权拒绝、空内容、类型自动检测、密码保护）。
- Admin 路由（CRUD、批量删除、克隆、审计日志）。
- Admin 仓库层。

## Share API

`POST /api/v1/share` — 通过 API Key 鉴权创建分享页面，供 CLI 和 Agent Skill 调用。

```bash
curl -s -X POST "$QUICKSHARE_URL/api/v1/share" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $QUICKSHARE_API_KEY" \
  -d '{"htmlContent":"<h1>Hello</h1>"}'
```

详见 [docs/deployment.md](docs/deployment.md) 环境变量表中的 `SHARE_API_KEY`。
