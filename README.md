# HTML-Go / QuickShare

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
models/           数据层（Repository 选择器 + Postgres / 内存实现）
views/            EJS 模板
public/           静态资源
utils/            security.js, contentRenderer.js, codeDetector.js
scripts/          hash-password.js
test/             Node test runner
```

## 当前安全边界

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
