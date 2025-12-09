# Vercel 部署指南

本指南将帮助你将 HTML-Go 项目部署到 Vercel 平台。

## 准备工作

1. **Vercel 账号**
   - 访问 [vercel.com](https://vercel.com) 注册账号
   - 建议使用 GitHub 账号登录，便于集成

2. **项目代码**
   - 确保代码已推送到 GitHub 仓库
   - 或使用 Git 进行版本控制

## 部署步骤

### 第一步：安装 Vercel CLI（可选）

```bash
npm i -g vercel
```

### 第二步：创建 Vercel 项目

#### 方法 A：通过 Vercel 网站（推荐）

1. 登录 [Vercel Dashboard](https://vercel.com/dashboard)
2. 点击 **Add New...** → **Project**
3. 导入你的 GitHub 仓库
4. Vercel 会自动检测项目类型为 **Node.js**

#### 方法 B：通过 CLI

```bash
# 在项目根目录执行
vercel

# 按提示操作：
# - 登录 Vercel 账号
# - 选择团队（个人或组织）
# - 链接到现有项目或创建新项目
```

### 第三步：配置项目

1. **修改 Root Directory**（如果需要）
   - 如果项目在子目录，设置相应的根目录

2. **Build Settings**
   - Vercel 会自动使用 `app.js` 作为入口点
   - 无需额外配置

3. **Environment Variables**
   - 参照 [VERCEL_ENV.md](./VERCEL_ENV.md) 配置环境变量

### 第四步：创建必要的资源

#### 1. 创建 Postgres 数据库

1. 在 Vercel 项目控制台中，点击 **Storage**
2. 点击 **Create Database**
3. 选择 **Postgres** 并配置：
   - 数据库名称（如：`html-go-db`）
   - 区域（选择离用户最近的区域）
4. 点击 **Create**

创建完成后，Vercel 会自动添加相关环境变量到项目。

#### 2. 创建 KV 存储（可选但推荐）

1. 在 Storage 页面点击 **Create Database**
2. 选择 **KV** 并配置：
   - KV 名称（如：`html-go-sessions`）
   - 区域
3. 点击 **Create**

### 第五步：配置环境变量

在项目设置中添加以下环境变量：

```bash
NODE_ENV=production
AUTH_ENABLED=true
AUTH_PASSWORD=your-secure-admin-password
SESSION_SECRET=your-generated-secret-key
```

其他变量（Postgres 和 KV）会在创建资源时自动添加。

### 第六步：部署

1. **自动部署**
   - 如果通过 GitHub 导入，推送代码会自动触发部署
   - 每次推送到主分支都会自动部署

2. **手动部署**
   ```bash
   vercel --prod
   ```

## 部署后验证

1. **访问应用**
   - 部署成功后，Vercel 会提供一个 `.vercel.app` 域名
   - 访问该域名测试应用是否正常运行

2. **功能测试**
   - 测试登录功能
   - 创建新的 HTML 代码分享
   - 访问分享链接
   - 测试密码保护功能

3. **查看日志**
   - 在 Vercel 控制台的 **Functions** 标签页查看函数日志
   - 在 **Logs** 标签页查看应用日志

## 自定义域名（可选）

1. **添加域名**
   - 在项目设置中点击 **Domains**
   - 添加你的自定义域名

2. **配置 DNS**
   - 根据提示配置 DNS 记录
   - 通常需要添加 CNAME 记录指向 `cname.vercel-dns.com`

## 性能优化建议

### 1. 缓存配置

在 `vercel.json` 中已配置缓存规则，确保：
- 静态资源被正确缓存
- API 响应设置合理的缓存时间

### 2. 区域配置

在 `vercel.json` 中配置多个区域以提高可用性：
- `hkg1`：香港
- `sfo1`：旧金山

### 3. 函数配置

- `maxDuration: 10`：函数最大执行时间 10 秒
- `memory: 512`：分配 512MB 内存

## 故障排除

### 常见问题

1. **部署失败**
   - 检查 `package.json` 中的依赖是否正确
   - 查看构建日志中的错误信息

2. **数据库连接失败**
   - 确认 Postgres 环境变量已正确设置
   - 检查数据库是否已创建

3. **会话丢失**
   - 如果未配置 KV，会使用内存存储
   - 重部署后会话会丢失，这是正常的

4. **403/404 错误**
   - 检查路由配置
   - 确认 `vercel.json` 中的路由规则正确

### 调试技巧

1. **本地调试**
   ```bash
   # 使用 Vercel CLI 本地运行
   vercel dev
   ```

2. **查看函数日志**
   - 在 Vercel 控制台查看实时日志
   - 添加自定义日志便于调试

3. **环境变量调试**
   ```javascript
   // 在代码中添加调试日志
   console.log('Environment:', {
     NODE_ENV: process.env.NODE_ENV,
     HAS_POSTGRES: !!process.env.POSTGRES_URL,
     HAS_KV: !!process.env.KV_URL
   });
   ```

## 成本考虑

- **免费额度**：
  - 100GB 带宽/月
  - 1GB 存储
  - Postgres: 512MB 数据库
  - KV: 基础额度

- **升级建议**：
  - 如果流量增长，考虑升级到 Pro 计划
  - 监控使用量避免超额费用

## 维护

1. **定期更新依赖**
   ```bash
   npm update
   npm audit fix
   ```

2. **监控性能**
   - 使用 Vercel Analytics 监控应用性能
   - 查看函数执行时间和错误率

3. **备份数据**
   - 定期备份 Postgres 数据库
   - 导出重要配置

## 总结

通过以上步骤，你已经成功将 HTML-Go 项目部署到 Vercel。主要改进包括：

1. ✅ 使用 Vercel Postgres 替代 SQLite，实现数据持久化
2. ✅ 使用 Vercel KV 或内存存储管理会话
3. ✅ 适配无服务器架构
4. ✅ 配置了自动部署和自定义域名支持

现在你可以享受 Vercel 带来的：
- 全球 CDN 加速
- 自动 HTTPS
- 持续部署
- 无服务器扩展性

如有问题，请查看 [Vercel 官方文档](https://vercel.com/docs) 或提交 Issue。