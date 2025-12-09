// Vercel KV 会话存储
const { kv } = require('@vercel/kv');

class VercelKVStore {
  constructor(options = {}) {
    this.prefix = options.prefix || 'sess:';
    this.ttl = options.ttl || 86400; // 24小时
  }

  // 获取会话
  async get(sid, callback) {
    try {
      const data = await kv.get(this.prefix + sid);
      if (callback) {
        callback(null, data);
      }
      return data;
    } catch (error) {
      console.error('KV get error:', error);
      if (callback) {
        callback(error);
      }
      return null;
    }
  }

  // 设置会话
  async set(sid, sess, callback) {
    try {
      const success = await kv.set(this.prefix + sid, sess, {
        ex: this.ttl
      });
      if (callback) {
        callback(null, success);
      }
      return success;
    } catch (error) {
      console.error('KV set error:', error);
      if (callback) {
        callback(error);
      }
      return false;
    }
  }

  // 销毁会话
  async destroy(sid, callback) {
    try {
      const success = await kv.del(this.prefix + sid);
      if (callback) {
        callback(null, success);
      }
      return success;
    } catch (error) {
      console.error('KV destroy error:', error);
      if (callback) {
        callback(error);
      }
      return false;
    }
  }

  // 列出所有会话ID
  async all(callback) {
    try {
      const keys = await kv.keys(this.prefix + '*');
      const sids = keys.map(key => key.replace(this.prefix, ''));
      if (callback) {
        callback(null, sids);
      }
      return sids;
    } catch (error) {
      console.error('KV all error:', error);
      if (callback) {
        callback(error);
      }
      return [];
    }
  }

  // 清除所有会话
  async clear(callback) {
    try {
      const keys = await kv.keys(this.prefix + '*');
      if (keys.length > 0) {
        await kv.del(...keys);
      }
      if (callback) {
        callback(null);
      }
      return true;
    } catch (error) {
      console.error('KV clear error:', error);
      if (callback) {
        callback(error);
      }
      return false;
    }
  }
}

module.exports = VercelKVStore;