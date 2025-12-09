// Vercel Postgres 数据库配置
const { postgres } = require('@vercel/postgres');

// 数据库连接缓存
let dbConnection = null;

async function getDatabase() {
  if (!dbConnection) {
    // 使用 Vercel Postgres
    dbConnection = postgres(process.env.POSTGRES_URL, {
      ssl: 'require',
      prepare: false
    });
  }
  return dbConnection;
}

// 初始化数据库表
async function initDatabase() {
  const sql = await getDatabase();

  try {
    // 创建 pages 表
    await sql`
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        html_content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        password TEXT,
        is_protected INTEGER DEFAULT 0,
        code_type TEXT DEFAULT 'html',
        title TEXT,
        description TEXT
      );
    `;

    console.log('数据库初始化成功');
    return true;
  } catch (error) {
    console.error('数据库初始化失败:', error);
    throw error;
  }
}

module.exports = {
  getDatabase,
  initDatabase
};