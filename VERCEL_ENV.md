# Vercel 部署环境变量配置

## 必需的环境变量

### 1. 基础配置

| 变量名 | 说明 | 示例值 | 是否必需 |
|--------|------|--------|----------|
| `NODE_ENV` | 运行环境 | `production` | 是 |
| `AUTH_ENABLED` | 是否启用认证 | `true` | 是 |
| `AUTH_PASSWORD` | 管理员密码 | `your-secure-password` | 是 |
| `SESSION_SECRET` | 会话加密密钥 | `your-session-secret` | 是 |

### 2. Vercel Postgres 配置

创建 Vercel Postgres 数据库后，会自动获得以下变量：

| 变量名 | 说明 | 是否必需 |
|--------|------|----------|
| `POSTGRES_URL` | 数据库连接字符串 | 是 |
| `POSTGRES_PRISMA_URL` | Prisma 连接字符串 | 否 |
| `POSTGRES_URL_NON_POOLING` | 非池化连接字符串 | 否 |
| `POSTGRES_USER` | 数据库用户名 | 否 |
| `POSTGRES_HOST` | 数据库主机 | 否 |
| `POSTGRES_PASSWORD` | 数据库密码 | 否 |
| `POSTGRES_DATABASE` | 数据库名称 | 否 |

### 3. Vercel KV 配置（可选但推荐）

创建 Vercel KV 存储后，会自动获得以下变量：

| 变量名 | 说明 | 是否必需 |
|--------|------|----------|
| `KV_URL` | KV 连接字符串 | 推荐 |
| `KV_REST_API_URL` | REST API URL | 推荐 |
| `KV_REST_API_TOKEN` | REST API Token | 推荐 |
| `KV_REST_API_READ_ONLY_TOKEN` | 只读 Token | 否 |

## 在 Vercel 控制台设置环境变量

1. 进入 Vercel 项目控制台
2. 点击 **Settings** → **Environment Variables**
3. 添加上述必需的环境变量

### 步骤：

1. **创建 Postgres 数据库**
   - 在项目中点击 **Storage** → **Create Database**
   - 选择 **Postgres** → **Continue**
   - 确认创建后，环境变量会自动添加

2. **创建 KV 存储（可选）**
   - 在项目中点击 **Storage** → **Create Database**
   - 选择 **KV** → **Continue**
   - 确认创建后，环境变量会自动添加

3. **手动添加其他环境变量**
   ```
   NODE_ENV = production
   AUTH_ENABLED = true
   AUTH_PASSWORD = your-admin-password
   SESSION_SECRET = your-secret-key-here
   ```

## 本地开发环境变量

创建 `.env.local` 文件用于本地开发：

```bash
# 本地开发配置
NODE_ENV=development
AUTH_ENABLED=true
AUTH_PASSWORD=admin123
SESSION_SECRET=dev-secret-key

# 如果本地也使用云数据库（可选）
# POSTGRES_URL=postgresql://user:password@host:port/dbname
# KV_URL=your-kv-url
```

## 安全注意事项

1. **密码强度**
   - `AUTH_PASSWORD` 应该使用强密码
   - `SESSION_SECRET` 应该使用随机生成的长字符串

2. **敏感信息**
   - 不要在代码中硬编码敏感信息
   - 使用 Vercel 的环境变量功能安全地存储密钥

3. **生产环境**
   - 确保 `NODE_ENV` 设置为 `production`
   - 启用所有安全相关的配置

## 故障排除

### 问题 1：数据库连接失败
- 确保 `POSTGRES_URL` 正确设置
- 检查数据库是否已经创建并初始化

### 问题 2：会话丢失
- 如果设置了 `KV_URL`，确保 KV 存储正确配置
- 如果没有 KV，会使用内存存储（重部署后会丢失）

### 问题 3：认证失败
- 检查 `AUTH_ENABLED` 和 `AUTH_PASSWORD` 是否正确设置
- 清除浏览器缓存和 Cookie 后重试

## 环境变量生成脚本

可以使用以下脚本生成安全的密钥：

```javascript
// 生成 SESSION_SECRET 的脚本
const crypto = require('crypto');
const secret = crypto.randomBytes(64).toString('hex');
console.log('SESSION_SECRET =', secret);
```

运行方式：
```bash
node -e "const crypto = require('crypto'); console.log('SESSION_SECRET =', crypto.randomBytes(64).toString('hex'))"
```