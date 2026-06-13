// ============================================================================
// SERVER-SIDE PAYMENT PROCESSOR (Node.js + Express)
// ============================================================================
// This implementation demonstrates:
// 1. Idempotency cache checking (prevent duplicate charges)
// 2. Secure payment processing
// 3. Error handling and recovery
// 4. Transaction audit trail

const express = require('express');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { v4: uuidv4, validate: validateUUID } = require('uuid');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// ============================================================================
// DATABASE SCHEMA SETUP (Run once)
// ============================================================================

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    // Idempotency cache table
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

    // Transactions table (immutable audit trail)
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

    // Payment logs for debugging
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

// ============================================================================
// UTILITIES
// ============================================================================

class PaymentLogger {
  async log(idempotencyKey, customerId, event, details, requestId) {
    await pool.query(
      `INSERT INTO payment_logs (idempotency_key, customer_id, event, details, request_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [idempotencyKey, customerId, event, JSON.stringify(details), requestId]
    );
  }
}

const logger = new PaymentLogger();

function hashPayload(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function validateIdempotencyKey(key) {
  return validateUUID(key);
}

// ============================================================================
// PAYMENT PROCESSOR
// ============================================================================

class PaymentProcessor {
  /**
   * Main payment processing endpoint
   * Handles idempotency, fraud checks, and payment processing
   */
  async processPayment(req) {
    const requestId = req.headers['x-request-id'] || uuidv4();
    const startTime = Date.now();

    try {
      const {
        idempotencyKey,
        paymentMethod,
        transaction,
        customer,
        metadata
      } = req.body;

      // STEP 1: Validate idempotency key
      if (!validateIdempotencyKey(idempotencyKey)) {
        return {
          statusCode: 400,
          body: {
            status: 'error',
            error: {
              code: 'invalid_idempotency_key',
              message: 'Idempotency key must be a valid UUID'
            },
            timestamp: new Date().toISOString()
          }
        };
      }

      await logger.log(idempotencyKey, customer.customerId, 'VALIDATE_KEY_START', {}, requestId);

      // STEP 2: Check idempotency cache (CRITICAL)
      const cacheResult = await this.checkIdempotencyCache(idempotencyKey, requestId);

      if (cacheResult.found) {
        await logger.log(idempotencyKey, customer.customerId, 'CACHE_HIT', 
          { cachedStatus: cacheResult.response.status }, requestId);
        
        return {
          statusCode: 200,
          body: cacheResult.response,
          cached: true
        };
      }

      await logger.log(idempotencyKey, customer.customerId, 'CACHE_MISS', {}, requestId);

      // STEP 3: Validate payload
      const validation = this.validatePayload(req.body);
      if (!validation.valid) {
        const errorResponse = this.buildErrorResponse(
          idempotencyKey,
          validation.error,
          false
        );

        await this.cacheResponse(
          idempotencyKey,
          customer.customerId,
          transaction.orderId,
          req.body,
          errorResponse,
          'failed'
        );

        await logger.log(idempotencyKey, customer.customerId, 'VALIDATION_ERROR', 
          validation.error, requestId);

        return {
          statusCode: 400,
          body: errorResponse
        };
      }

      // STEP 4: Fraud checks
      const fraudCheck = await this.performFraudChecks(req.body, metadata);
      if (fraudCheck.blocked) {
        const errorResponse = this.buildErrorResponse(
          idempotencyKey,
          { code: 'fraud_detected', message: 'Transaction blocked by fraud detection' },
          false
        );

        await logger.log(idempotencyKey, customer.customerId, 'FRAUD_CHECK_FAILED', 
          fraudCheck.reason, requestId);

        return {
          statusCode: 403,
          body: errorResponse
        };
      }

      // STEP 5: Process payment with Stripe
      let chargeResult;
      try {
        chargeResult = await this.chargeCard(req.body, requestId);
        
        await logger.log(idempotencyKey, customer.customerId, 'CHARGE_SUCCESS', 
          { stripeChargeId: chargeResult.id }, requestId);
      } catch (err) {
        const errorResponse = this.buildErrorResponse(
          idempotencyKey,
          this.mapStripeError(err),
          true
        );

        await this.cacheResponse(
          idempotencyKey,
          customer.customerId,
          transaction.orderId,
          req.body,
          errorResponse,
          'failed'
        );

        await logger.log(idempotencyKey, customer.customerId, 'CHARGE_FAILED', 
          { error: err.message }, requestId);

        return {
          statusCode: 400,
          body: errorResponse
        };
      }

      // STEP 6: Create transaction record in audit trail
      const transactionRecord = await this.createTransactionRecord({
        transactionId: uuidv4(),
        orderId: transaction.orderId,
        customerId: customer.customerId,
        amount: transaction.amount,
        currency: transaction.currency,
        stripeChargeId: chargeResult.id,
        status: 'completed'
      });

      // STEP 7: Build success response
      const successResponse = {
        status: 'success',
        transactionId: transactionRecord.transaction_id,
        idempotencyKey,
        amount: transaction.amount,
        currency: transaction.currency,
        orderId: transaction.orderId,
        timestamp: new Date().toISOString(),
        receipt: {
          receiptUrl: `https://receipts.payment.com/${transactionRecord.transaction_id}`,
          receiptId: transactionRecord.transaction_id
        }
      };

      // STEP 8: Cache success response
      await this.cacheResponse(
        idempotencyKey,
        customer.customerId,
        transaction.orderId,
        req.body,
        successResponse,
        'completed'
      );

      await logger.log(idempotencyKey, customer.customerId, 'PAYMENT_COMPLETE', 
        { transactionId: transactionRecord.transaction_id }, requestId);

      const processingTime = Date.now() - startTime;
      console.log(`✓ Payment processed in ${processingTime}ms (${idempotencyKey})`);

      return {
        statusCode: 200,
        body: successResponse
      };

    } catch (err) {
      console.error('Unexpected error in processPayment:', err);
      await logger.log(null, null, 'UNEXPECTED_ERROR', { error: err.message }, requestId);

      return {
        statusCode: 500,
        body: {
          status: 'error',
          error: {
            code: 'internal_server_error',
            message: 'An unexpected error occurred'
          },
          timestamp: new Date().toISOString()
        }
      };
    }
  }

  /**
   * Check if this idempotency key has been processed before
   * Returns cached response if found
   */
  async checkIdempotencyCache(idempotencyKey, requestId) {
    try {
      const result = await pool.query(
        `SELECT response_payload, status, created_at 
         FROM idempotency_cache 
         WHERE idempotency_key = $1 AND expires_at > NOW()`,
        [idempotencyKey]
      );

      if (result.rows.length > 0) {
        const { response_payload, status, created_at } = result.rows[0];
        return {
          found: true,
          response: JSON.parse(response_payload),
          status,
          age: Date.now() - new Date(created_at).getTime()
        };
      }

      return { found: false };
    } catch (err) {
      console.error('Error checking idempotency cache:', err);
      throw err;
    }
  }

  /**
   * Store request/response in idempotency cache
   */
  async cacheResponse(idempotencyKey, customerId, orderId, request, response, status) {
    try {
      await pool.query(
        `INSERT INTO idempotency_cache 
         (idempotency_key, customer_id, order_id, request_hash, request_payload, response_payload, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (idempotency_key) DO UPDATE SET
           response_payload = EXCLUDED.response_payload,
           status = EXCLUDED.status
        `,
        [
          idempotencyKey,
          customerId,
          orderId,
          hashPayload(request),
          JSON.stringify(request),
          JSON.stringify(response),
          status
        ]
      );
    } catch (err) {
      console.error('Error caching response:', err);
      throw err;
    }
  }

  /**
   * Validate request payload
   */
  validatePayload(body) {
    const { transaction, paymentMethod, customer, idempotencyKey } = body;

    // Amount validation
    if (!transaction.amount || typeof transaction.amount !== 'number' || transaction.amount <= 0) {
      return {
        valid: false,
        error: { code: 'invalid_amount', message: 'Amount must be a positive number' }
      };
    }

    // Currency validation
    if (!transaction.currency || !/^[A-Z]{3}$/.test(transaction.currency)) {
      return {
        valid: false,
        error: { code: 'invalid_currency', message: 'Currency must be a valid ISO 4217 code' }
      };
    }

    // Token validation
    if (!paymentMethod.token) {
      return {
        valid: false,
        error: { code: 'invalid_token', message: 'Payment token is required' }
      };
    }

    // Never accept raw card data
    if (paymentMethod.token.startsWith('4') && paymentMethod.token.length === 16) {
      return {
        valid: false,
        error: { code: 'invalid_payment_method', message: 'Raw card data not accepted. Use tokenized payment method.' }
      };
    }

    // Customer ID validation
    if (!customer.customerId) {
      return {
        valid: false,
        error: { code: 'invalid_customer', message: 'Customer ID is required' }
      };
    }

    // Order ID validation
    if (!transaction.orderId) {
      return {
        valid: false,
        error: { code: 'invalid_order', message: 'Order ID is required' }
      };
    }

    return { valid: true };
  }

  /**
   * Perform fraud detection checks
   */
  async performFraudChecks(payload, metadata) {
    const { transaction, customer } = payload;

    // Check 1: Verify cart checksum hasn't been tampered with
    if (metadata.cartChecksum) {
      // In production, you would verify this against the actual cart
      // For now, just log it
    }

    // Check 2: Velocity check - too many transactions in short time
    const recentTransactions = await pool.query(
      `SELECT COUNT(*) as count FROM transactions 
       WHERE customer_id = $1 AND created_at > NOW() - INTERVAL '5 minutes'`,
      [customer.customerId]
    );

    if (parseInt(recentTransactions.rows[0].count) > 5) {
      return {
        blocked: true,
        reason: 'Too many transactions in short time'
      };
    }

    // Check 3: Amount validation against customer history
    const avgTransaction = await pool.query(
      `SELECT AVG(amount) as avg_amount FROM transactions 
       WHERE customer_id = $1 AND created_at > NOW() - INTERVAL '90 days'`,
      [customer.customerId]
    );

    const avgAmount = parseInt(avgTransaction.rows[0].avg_amount) || 0;
    const currentAmount = transaction.amount;

    // Flag if 10x the average (but allow it, just note it)
    if (avgAmount > 0 && currentAmount > avgAmount * 10) {
      console.warn(`⚠ High-value transaction: ${currentAmount} vs avg ${avgAmount}`);
    }

    return { blocked: false };
  }

  /**
   * Charge card using Stripe
   */
  async chargeCard(payload, requestId) {
    const { transaction, paymentMethod, customer } = payload;

    const charge = await stripe.charges.create({
      amount: transaction.amount,
      currency: transaction.currency,
      source: paymentMethod.token,
      description: `Order ${transaction.orderId}`,
      metadata: {
        orderId: transaction.orderId,
        customerId: customer.customerId,
        requestId
      },
      statement_descriptor: `Payment for order ${transaction.orderId}`.substring(0, 22)
    });

    return charge;
  }

  /**
   * Create transaction record in audit trail
   */
  async createTransactionRecord(data) {
    const result = await pool.query(
      `INSERT INTO transactions 
       (transaction_id, order_id, customer_id, amount, currency, status, stripe_charge_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.transactionId,
        data.orderId,
        data.customerId,
        data.amount,
        data.currency,
        data.status,
        data.stripeChargeId
      ]
    );

    return result.rows[0];
  }

  /**
   * Build error response
   */
  buildErrorResponse(idempotencyKey, error, retryable = false) {
    return {
      status: 'error',
      error: {
        code: error.code,
        message: error.message
      },
      idempotencyKey,
      timestamp: new Date().toISOString(),
      retryable
    };
  }

  /**
   * Map Stripe errors to our error codes
   */
  mapStripeError(stripeError) {
    const { type, code, message } = stripeError;

    if (type === 'StripeCardError') {
      if (code === 'card_declined') {
        return { code: 'card_declined', message: 'Card was declined' };
      } else if (code === 'insufficient_funds') {
        return { code: 'insufficient_funds', message: 'Insufficient funds' };
      }
    }

    if (type === 'RateLimitError') {
      return { code: 'rate_limit', message: 'Too many requests. Please retry.' };
    }

    return { code: 'payment_failed', message: message || 'Payment processing failed' };
  }
}

// ============================================================================
// EXPRESS ROUTES
// ============================================================================

const processor = new PaymentProcessor();

app.post('/api/v1/payments/create', async (req, res) => {
  const result = await processor.processPayment(req);
  res.status(result.statusCode).json(result.body);
});

/**
 * Health check for payment service
 */
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', service: 'payment-processor' });
  } catch (err) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

/**
 * Get transaction details (for customer support)
 */
app.get('/api/v1/transactions/:transactionId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE transaction_id = $1',
      [req.params.transactionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Cleanup expired cache entries (run periodically)
 */
app.post('/admin/cleanup-cache', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM idempotency_cache WHERE expires_at < NOW()'
    );

    res.json({ cleaned: result.rowCount, message: 'Cache cleanup completed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// STARTUP
// ============================================================================

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

module.exports = app;
