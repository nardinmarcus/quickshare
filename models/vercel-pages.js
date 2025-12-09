// 使用 Vercel Postgres 的 pages 数据模型
const { getDatabase } = require('./vercel-db');

const PAGE_EXPIRY_DAYS = 7;

class VercelPagesModel {
  // 创建页面
  static async create(pageData) {
    const sql = await getDatabase();
    const { id, htmlContent, password, isProtected, codeType, title, description } = pageData;
    const createdAt = Date.now();

    try {
      const result = await sql`
        INSERT INTO pages (id, html_content, created_at, password, is_protected, code_type, title, description)
        VALUES (${id}, ${htmlContent}, ${createdAt}, ${password}, ${isProtected}, ${codeType}, ${title}, ${description})
        RETURNING id;
      `;
      return result[0];
    } catch (error) {
      console.error('创建页面失败:', error);
      throw error;
    }
  }

  // 根据 ID 获取页面
  static async getById(id) {
    const sql = await getDatabase();

    try {
      const result = await sql`
        SELECT * FROM pages WHERE id = ${id} LIMIT 1;
      `;
      return result[0] || null;
    } catch (error) {
      console.error('获取页面失败:', error);
      throw error;
    }
  }

  // 检查页面是否存在
  static async exists(id) {
    const sql = await getDatabase();

    try {
      const result = await sql`
        SELECT 1 FROM pages WHERE id = ${id} LIMIT 1;
      `;
      return result.length > 0;
    } catch (error) {
      console.error('检查页面存在性失败:', error);
      return false;
    }
  }

  // 获取所有页面（管理后台用）
  static async getAll() {
    const sql = await getDatabase();

    try {
      const result = await sql`
        SELECT id, created_at, code_type, title, description, is_protected
        FROM pages
        ORDER BY created_at DESC;
      `;
      return result;
    } catch (error) {
      console.error('获取所有页面失败:', error);
      throw error;
    }
  }

  // 删除过期页面
  static async deleteExpired() {
    const sql = await getDatabase();
    const expiryTime = Date.now() - (PAGE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    try {
      const result = await sql`
        DELETE FROM pages WHERE created_at < ${expiryTime};
      `;
      console.log(`清理了 ${result.rowCount} 个过期页面`);
      return result.rowCount;
    } catch (error) {
      console.error('删除过期页面失败:', error);
      return 0;
    }
  }

  // 根据 ID 删除页面
  static async deleteById(id) {
    const sql = await getDatabase();

    try {
      const result = await sql`
        DELETE FROM pages WHERE id = ${id};
      `;
      return result.rowCount > 0;
    } catch (error) {
      console.error('删除页面失败:', error);
      return false;
    }
  }

  // 获取页面统计信息
  static async getStats() {
    const sql = await getDatabase();

    try {
      const [totalResult] = await sql`
        SELECT COUNT(*) as total FROM pages;
      `;

      const [protectedResult] = await sql`
        SELECT COUNT(*) as protected FROM pages WHERE is_protected = 1;
      `;

      return {
        total: parseInt(totalResult.total),
        protected: parseInt(protectedResult.protected)
      };
    } catch (error) {
      console.error('获取统计信息失败:', error);
      return { total: 0, protected: 0 };
    }
  }
}

module.exports = VercelPagesModel;