// 最小化的测试 API 函数
module.exports = (req, res) => {
  console.log('收到请求:', {
    method: req.method,
    url: req.url,
    headers: req.headers
  });

  res.json({
    message: '测试成功！',
    timestamp: new Date().toISOString(),
    env: {
      NODE_ENV: process.env.NODE_ENV,
      VERCEL: process.env.VERCEL
    }
  });
};