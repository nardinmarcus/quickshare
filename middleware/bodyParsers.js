const express = require('express');

function createBodyParsers(config) {
  const parseSmallJson = express.json({ limit: config.smallBodyLimit });
  const parseSmallForm = express.urlencoded({ extended: true, limit: config.smallBodyLimit });
  const parseShareJson = express.json({ limit: config.shareBodyLimit });

  function parseSmallJsonBody(req, res, next) {
    return parseSmallJson(req, res, (error) => {
      if (error?.type === 'entity.parse.failed') {
        return res.status(400).json({
          success: false,
          error: 'Invalid JSON body'
        });
      }

      return next(error);
    });
  }

  return {
    parseShareJson,
    parseSmallForm,
    parseSmallJson,
    parseSmallJsonBody
  };
}

module.exports = {
  createBodyParsers
};
