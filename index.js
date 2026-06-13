require('dotenv').config();
const app = require('./src/app');
const { initializeDatabase } = require('./src/db/schema');

const PORT = process.env.PORT || 3000;

async function start() {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`🚀 Payment service listening on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start payment service:', err);
  process.exit(1);
});
