# Vercel 部署

本项目现在使用单一 Express app：

```text
api/index.js -> app.js
```

## 步骤

1. 在 Vercel 导入仓库。
2. 创建 Postgres 存储，推荐 Neon 集成。
3. 配置环境变量，参考 `VERCEL_ENV.md`。
4. 部署后验证登录、创建、查看、密码保护。

## 本地预检

```bash
npm install
npm test
```

如安装了 Vercel CLI，也可以本地模拟：

```bash
vercel dev
```

## 验证清单

- `/login` 可以登录。
- 首页创建 HTML 分享成功。
- 首页创建 Markdown 分享成功。
- 密码保护页面不会把密码放入 URL query。
- 分享内容在 sandbox iframe 中渲染。
- 未登录无法调用管理写接口。
