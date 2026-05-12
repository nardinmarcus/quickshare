# Vercel 环境变量

生产环境建议配置：

```bash
NODE_ENV=production
AUTH_ENABLED=true
ADMIN_PASSWORD_HASH=<generated-password-hash>
SESSION_SECRET=<long-random-secret>
DATABASE_URL=<postgres-connection-string>
```

生成管理员密码 hash：

```bash
npm run hash-password -- "your-admin-password"
```

说明：

- `DATABASE_URL` 推荐来自 Vercel Marketplace 的 Neon Postgres 集成。
- `SESSION_SECRET` 用于签名登录 cookie、页面访问 cookie 和 CSRF token。
- `ADMIN_PASSWORD_HASH` 优先级高于 `AUTH_PASSWORD`。
- 未设置 `DATABASE_URL` 时，本地开发会使用内存仓库；Vercel 生产环境应始终设置 `DATABASE_URL`。
