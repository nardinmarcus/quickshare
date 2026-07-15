require('dotenv').config();

const app = require('./app');
const config = require('./config');

const port = config.port;

async function start() {
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
