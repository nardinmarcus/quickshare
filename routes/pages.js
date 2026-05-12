const express = require('express');

function createDeprecatedPagesRouter() {
  const router = express.Router();

  router.use((req, res) => {
    res.status(410).json({
      success: false,
      error: 'This router has been replaced by the Vercel-ready app routes.'
    });
  });

  return router;
}

module.exports = createDeprecatedPagesRouter;
