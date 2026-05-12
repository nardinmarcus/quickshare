# Quick Deploy

## Vercel

```bash
npm install
npm test
```

Vercel 环境变量：

```bash
NODE_ENV=production
AUTH_ENABLED=true
ADMIN_PASSWORD_HASH=<generated-password-hash>
SESSION_SECRET=<long-random-secret>
DATABASE_URL=<postgres-connection-string>
```

生成密码 hash：

```bash
npm run hash-password -- "your-admin-password"
```

然后在 Vercel 中导入仓库并部署。
