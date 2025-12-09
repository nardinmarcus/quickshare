// Vercel 部署版本的 app.js

// 捕获未处理的异常
process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的 Promise 拒绝:', reason);
});

try {
  require('dotenv').config();
} catch (error) {
  console.error('加载 .env 失败:', error);
}

let express;
try {
  express = require('express');
} catch (error) {
  console.error('加载 Express 失败:', error);
  throw new Error('Failed to load Express module');
}
const path = require('path');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);

// 检测是否在 Vercel 环境
const isVercel = process.env.VERCEL === '1';

// 导入 Vercel 特定的模块
let VercelKVStore = null;
let VercelPagesModel = null;
let initDatabase = null;

if (isVercel) {
  // Vercel 环境
  VercelKVStore = require('../session/vercel-kv-store');
  VercelPagesModel = require('../models/vercel-pages');
  const vercelDb = require('../models/vercel-db');
  initDatabase = vercelDb.initDatabase;
} else {
  // 本地环境
  VercelPagesModel = require('../models/pages');
  const localDb = require('../models/db');
  initDatabase = localDb.initDatabase;
}

// 导入认证中间件
const { isAuthenticated } = require('../middleware/auth');

// 导入配置
const config = require('../config');

// 路由导入
const pagesRoutes = require('../routes/pages');

// 创建 Express 应用
const app = express();

// 端口配置 - Vercel 环境使用环境变量 PORT
const PORT = isVercel ? (process.env.PORT || 3000) : config.port;

// 添加调试信息
console.log('=== 应用启动信息 ===');
console.log('环境:', process.env.NODE_ENV);
console.log('是否 Vercel 环境:', isVercel);
console.log('认证启用:', config.authEnabled);
console.log('数据库配置:', {
  hasPostgresUrl: !!process.env.POSTGRES_URL,
  hasKV: !!process.env.KV_URL
});

// 将配置添加到应用本地变量中
app.locals.config = config;
app.locals.isVercel = isVercel;

// 中间件设置
app.use(morgan(config.logLevel));
app.use(cors());
app.use(bodyParser.json({ limit: '15mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '15mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

// 会话存储配置
let sessionStore;
if (isVercel && process.env.KV_URL) {
  // Vercel 环境，且有 KV 配置
  console.log('使用 Vercel KV 存储会话');
  sessionStore = new VercelKVStore({
    ttl: 86400,
    prefix: 'sess:'
  });
} else {
  // 本地环境或 Vercel 环境但无 KV，使用内存存储
  console.log('使用内存存储会话');
  sessionStore = new MemoryStore({
    checkPeriod: 86400000, // 24小时
    ttl: 86400 * 1000, // 24小时
  });
}

// 配置会话中间件
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'html-go-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isVercel ? true : false, // Vercel 生产环境使用 HTTPS
    maxAge: 24 * 60 * 60 * 1000, // 24小时
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// 设置视图引擎
app.set('views', path.join(__dirname, '../views'));
app.set('view engine', 'ejs');

// 数据库初始化状态
let dbInitialized = false;

// 确保数据库初始化的中间件
async function ensureDatabase(req, res, next) {
  if (!dbInitialized) {
    try {
      await initDatabase();
      dbInitialized = true;
      console.log('数据库初始化成功');
    } catch (error) {
      console.error('数据库初始化失败:', error);
      return res.status(500).render('error', {
        title: '数据库错误',
        message: '无法连接到数据库'
      });
    }
  }
  next();
}

// 登录路由
app.get('/login', (req, res) => {
  if (!config.authEnabled || (req.session && req.session.isAuthenticated)) {
    return res.redirect('/');
  }

  res.render('login', {
    title: 'HTML-Go | 登录',
    error: null
  });
});

app.post('/login', (req, res) => {
  const { password } = req.body;

  if (!config.authEnabled) {
    return res.redirect('/');
  }

  if (password === config.authPassword) {
    req.session.isAuthenticated = true;
    res.cookie('auth', 'true', {
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: isVercel,
      sameSite: 'lax'
    });
    return res.redirect('/');
  } else {
    res.render('login', {
      title: 'HTML-Go | 登录',
      error: '密码错误，请重试'
    });
  }
});

// 退出登录
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// API 路由

// 创建页面 - 需要认证
app.post('/api/pages/create', ensureDatabase, isAuthenticated, async (req, res) => {
  try {
    const { htmlContent, isProtected, codeType, title, description } = req.body;

    if (!htmlContent) {
      return res.status(400).json({
        success: false,
        error: '请提供HTML内容'
      });
    }

    // 生成唯一ID
    const id = Date.now().toString(36) + Math.random().toString(36).substr(2);
    const password = isProtected ? Math.random().toString(36).substr(2, 8) : null;

    // 使用对应的模型创建页面
    const result = await VercelPagesModel.create({
      id,
      htmlContent,
      password,
      isProtected: isProtected ? 1 : 0,
      codeType: codeType || 'html',
      title,
      description
    });

    res.json({
      success: true,
      urlId: id,
      password: password,
      isProtected: !!password
    });
  } catch (error) {
    console.error('创建页面API错误:', error);
    res.status(500).json({
      success: false,
      error: '服务器错误'
    });
  }
});

// 获取页面详情
app.get('/api/pages/:id', ensureDatabase, async (req, res) => {
  try {
    const { id } = req.params;
    const page = await VercelPagesModel.getById(id);

    if (!page) {
      return res.status(404).json({
        success: false,
        error: '页面不存在'
      });
    }

    res.json({
      success: true,
      page: {
        id: page.id,
        createdAt: page.created_at,
        codeType: page.code_type,
        title: page.title,
        description: page.description,
        isProtected: page.is_protected
      }
    });
  } catch (error) {
    console.error('获取页面API错误:', error);
    res.status(500).json({
      success: false,
      error: '服务器错误'
    });
  }
});

// 其他 API 路由
app.use('/api/pages', pagesRoutes);

// 密码验证
app.get('/validate-password/:id', ensureDatabase, async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.query;

    if (!password) {
      return res.json({ valid: false });
    }

    const page = await VercelPagesModel.getById(id);

    if (!page) {
      return res.json({ valid: false });
    }

    const isValid = page.is_protected === 1 && password === page.password;
    return res.json({ valid: isValid });
  } catch (error) {
    console.error('密码验证错误:', error);
    return res.status(500).json({ valid: false });
  }
});

// 首页 - 需要认证
app.get('/', isAuthenticated, (req, res) => {
  res.render('index', {
    title: 'HTML-Go | 分享 HTML 代码的简单方式',
    isVercel: isVercel
  });
});

// 查看页面 - 无需认证
app.get('/view/:id', ensureDatabase, async (req, res) => {
  try {
    const { id } = req.params;
    const page = await VercelPagesModel.getById(id);

    if (!page) {
      return res.status(404).render('error', {
        title: '页面未找到',
        message: '您请求的页面不存在或已被删除'
      });
    }

    // 密码验证
    if (page.is_protected === 1) {
      const { password } = req.query;
      if (!password || password !== page.password) {
        return res.render('password', {
          title: 'HTML-Go | 密码保护',
          id: id,
          error: password ? '密码错误，请重试' : null
        });
      }
    }

    // 导入渲染工具
    const { renderContent } = require('../utils/contentRenderer');

    // 渲染内容
    const contentType = page.code_type || 'html';
    const renderedContent = await renderContent(page.html_content, contentType);

    // 添加代码类型信息
    const contentWithTypeInfo = renderedContent.replace(
      '</head>',
      `<meta name="code-type" content="${contentType}">
</head>`
    );

    res.send(contentWithTypeInfo);
  } catch (error) {
    console.error('查看页面错误:', error);
    res.status(500).render('error', {
      title: '服务器错误',
      message: '查看页面时发生错误，请稍后再试'
    });
  }
});

// 404 处理
app.use((req, res) => {
  res.status(404).render('error', {
    title: '页面未找到',
    message: '您请求的页面不存在'
  });
});

// 导出应用供 Vercel 使用
try {
  module.exports = app;
} catch (error) {
  console.error('导出应用失败:', error);
  module.exports = (req, res) => {
    res.status(500).json({
      error: 'Server initialization failed',
      message: error.message
    });
  };
}

// 本地开发时的启动逻辑
if (!isVercel && require.main === module) {
  initDatabase().then(() => {
    app.listen(PORT, () => {
      console.log(`服务器运行在 http://localhost:${PORT}`);
      console.log(`环境: ${process.env.NODE_ENV}`);
      console.log(`数据库: ${isVercel ? 'Vercel Postgres' : 'SQLite'}`);
      console.log(`会话存储: ${process.env.KV_URL ? 'Vercel KV' : '内存存储'}`);
    });
  }).catch(err => {
    console.error('启动失败:', err);
  });
}