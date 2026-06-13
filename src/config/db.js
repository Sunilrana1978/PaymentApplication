const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_MAX_CONNECTIONS) || 20
});

module.exports = pool;
