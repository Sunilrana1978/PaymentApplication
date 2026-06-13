const pool = require('../config/db');

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS idempotency_cache (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_key VARCHAR(36) NOT NULL UNIQUE,
        customer_id VARCHAR(255) NOT NULL,
        order_id VARCHAR(255) NOT NULL,
        request_hash VARCHAR(64),
        request_payload JSONB NOT NULL,
        response_payload JSONB NOT NULL,
        status VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours',
        CONSTRAINT valid_status CHECK (status IN ('pending', 'completed', 'failed'))
      );

      CREATE INDEX IF NOT EXISTS idx_idempotency_key
        ON idempotency_cache(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_customer_order
        ON idempotency_cache(customer_id, order_id);
      CREATE INDEX IF NOT EXISTS idx_expires
        ON idempotency_cache(expires_at);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id VARCHAR(255) NOT NULL UNIQUE,
        order_id VARCHAR(255) NOT NULL,
        customer_id VARCHAR(255) NOT NULL,
        amount BIGINT NOT NULL,
        currency VARCHAR(3) NOT NULL,
        status VARCHAR(20) NOT NULL,
        payment_method_type VARCHAR(50),
        stripe_charge_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT valid_status CHECK (status IN ('pending', 'completed', 'failed', 'refunded'))
      );

      CREATE INDEX IF NOT EXISTS idx_order_id ON transactions(order_id);
      CREATE INDEX IF NOT EXISTS idx_customer_id ON transactions(customer_id);
      CREATE INDEX IF NOT EXISTS idx_created_at ON transactions(created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_logs (
        id BIGSERIAL PRIMARY KEY,
        idempotency_key VARCHAR(36),
        customer_id VARCHAR(255),
        event VARCHAR(100) NOT NULL,
        details JSONB,
        timestamp TIMESTAMP DEFAULT NOW(),
        request_id VARCHAR(255)
      );

      CREATE INDEX IF NOT EXISTS idx_idempotency_key_logs
        ON payment_logs(idempotency_key);
    `);

    console.log('✓ Database schema initialized');
  } finally {
    client.release();
  }
}

module.exports = { initializeDatabase };
