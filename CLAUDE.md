# QuickShare 项目规则

## 技术栈

Express 4 + EJS + PostgreSQL (生产) / 内存 (开发)。部署在 Vercel。

## 关键约定

- 仓库选择在 `models/pageRepository.js`，根据 `DATABASE_URL` 自动切换 Postgres / 内存。
- 认证使用签名 cookie（`ADMIN_COOKIE`），不用 session 中间件。
- 写操作必须带 CSRF token。
- 用户提交的内容通过 sandbox iframe 渲染，与管理端同源隔离。
- 内容类型限 `html`、`markdown`、`svg`、`mermaid` 四种（见 `VALID_CODE_TYPES`）。
- 入口分两个：`server.js`（本地）和 `api/index.js`（Vercel function），都指向 `app.js`。

## 目录结构速查

```text
api/           Vercel function 入口
app.js         Express app 工厂，所有路由定义在此
config.js      环境变量聚合
server.js      本地服务器入口
models/        数据层（pageRepository 选择器 + postgres-pages / memory-pages / vercel-pages）
views/         EJS 模板
public/        静态资源（css/ js/ icon/）
utils/         security.js（token/CSRF/hash）、contentRenderer.js、codeDetector.js
scripts/       hash-password.js
test/          Node test runner
```

## 测试

```bash
npm test
```

## 安全边界

- 生产环境必须设置 `ADMIN_PASSWORD_HASH` 和 `SESSION_SECRET`。
- `AUTH_PASSWORD`（明文）仅限开发环境，生产环境会被 `config.js` 拒绝。
- sandbox iframe 只允许脚本执行，不允许同源访问父页面 DOM/cookie。
