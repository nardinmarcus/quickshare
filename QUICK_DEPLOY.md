# 快速修复部署问题

## 当前问题
错误显示代码仍在尝试使用旧的 SQLite 数据库 (`models/db.js`)，而不是 Vercel Postgres。

## 已修复的内容
1. ✅ `api/index.js` - 使用正确的 Vercel Postgres 配置
2. ✅ `vercel.json` - 配置为使用 `api/index.js` 作为入口

## 下一步操作

### 1. 立即提交修复
```bash
git add .
git commit -m "修复 Vercel 部署问题：使用 API 路由结构"
git push origin main
```

### 2. 在 Vercel 设置环境变量
在 Vercel 项目设置中添加：

**必需的环境变量：**
- `NODE_ENV` = `production`
- `AUTH_ENABLED` = `true`
- `AUTH_PASSWORD` = `admin123` (或你的密码)
- `SESSION_SECRET` = `my-secret-key-123` (或生成的密钥)

**自动添加的变量（创建资源后）：**
- `POSTGRES_URL` (创建 Postgres 数据库后自动添加)
- `KV_URL` (创建 KV 存储后自动添加)

### 3. 在 Vercel 创建资源
1. 进入项目控制台
2. 点击 **Storage**
3. **Create Database** → 选择 **Postgres**
4. **Create Database** → 选择 **KV** (可选)

### 4. 重新部署
创建资源后，Vercel 会自动重新部署。如果没有，手动触发：
- 点击 **Deployments** 标签
- 点击最新部署右边的三个点 `⋯`
- 选择 **Redeploy**

## 验证部署成功
部署成功后，你应该能看到：
- 网站能正常加载
- 登录页面显示
- 没有 "no such file or directory" 错误

## 如果还有问题
查看 Vercel 的 **Functions** 日志，看看具体的错误信息。