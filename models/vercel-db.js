const { createPageRepository } = require('./pageRepository');

async function initDatabase() {
  const repository = createPageRepository();
  await repository.init();
  return true;
}

module.exports = {
  initDatabase
};
