// Vercel API 路由 - 调试版本
// 用于排查 500 错误

console.log('=== 开始加载模块 ===');

// 捕获所有未处理的异常
process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的 Promise 拒绝:', reason);
});

try {
  require('dotenv').config();
  console.log('✅ dotenv 加载成功');
} catch (error) {
  console.error('❌ 加载 dotenv 失败:', error);
}

// 测试基础模块加载
let express;
try {
  express = require('express');
  console.log('✅ Express 加载成功');
} catch (error) {
  console.error('❌ 加载 Express 失败:', error);
  process.exit(1);
}

const path = require('path');
console.log('✅ path 模块加载成功');

// 缓存模块，避免重复加载
const modules = {};

// 安全加载模块
function safeRequire(modulePath, moduleName) {
  if (modules[moduleName]) {
    return modules[moduleName];
  }

  try {
    const mod = require(modulePath);
    modules[moduleName] = mod;
    console.log(`✅ ${moduleName} 加载成功`);
    return mod;
  } catch (error) {
    console.error(`❌ 加载 ${moduleName} 失败:`, error);
    return null;
  }
}

// 检测环境
const isVercel = process.env.VERCEL === '1';
console.log('环境检测:', { isVercel, NODE_ENV: process.env.NODE_ENV });

// 创建应用
const app = express();
console.log('✅ Express 应用创建成功');

// 基础中间件
app.use((req, res, next) => {
  console.log(`收到请求: ${req.method} ${req.url}`);
  next();
});

// 健康检查路由
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      NODE_ENV: process.env.NODE_ENV,
      VERCEL: process.env.VERCEL,
      HAS_POSTGRES: !!process.env.POSTGRES_URL,
      HAS_KV: !!process.env.KV_URL,
      AUTH_ENABLED: process.env.AUTH_ENABLED
    }
  });
});

// 根路由 - 简化版
app.get('/', (req, res) => {
  console.log('访问根路由');

  // 简单响应，不使用模板
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>HTML-Go - 调试模式</title>
      <meta charset="UTF-8">
    </head>
    <body>
      <h1>HTML-Go 正在运行</h1>
      <p>当前模式: 调试版本</p>
      <p>时间: ${new Date().toLocaleString()}</p>
      <p>环境: ${process.env.NODE_ENV || 'unknown'}</p>
      <p>Vercel: ${process.env.VERCEL === '1' ? '是' : '否'}</p>
      <hr>
      <a href="/health">健康检查</a>
    </body>
    </html>
  `);
});

// 测试路由
app.get('/test', (req, res) => {
  console.log('访问测试路由');

  res.json({
    message: '测试成功！',
    modules_loaded: Object.keys(modules),
    environment: {
      NODE_ENV: process.env.NODE_ENV,
      VERCEL: process.env.VERCEL,
      cwd: process.cwd()
    }
  });
});

// 404 处理
app.use('*', (req, res) => {
  console.log(`404: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    error: 'Not Found',
    message: `路径 ${req.originalUrl} 不存在`
  });
});

// 错误处理中间件
app.use((error, req, res, next) => {
  console.error('错误处理中间件捕获:', error);
  res.status(500).json({
    error: 'Internal Server Error',
    message: error.message,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
  });
});

// 导出应用
console.log('准备导出应用...');
module.exports = app;

// 添加额外的错误处理
process.on('exit', (code) => {
  console.log(`进程退出，代码: ${code}`);
});

console.log('=== 模块加载完成 ===');

// 本地测试
if (!isVercel && require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`本地服务器运行在 http://localhost:${PORT}`);
    console.log('测试链接:');
    console.log(`  - http://localhost:${PORT}/`);
    console.log(`  - http://localhost:${PORT}/health`);
    console.log(`  - http://localhost:${PORT}/test`);
  });
}