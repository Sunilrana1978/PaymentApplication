const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const logger = require('../utils/logger');
const { hashPayload, validateIdempotencyKey } = require('../utils/hash');

class PaymentProcessor {
  async processPayment(req) {
    const requestId = req.headers['x-request-id'] || uuidv4();
    const startTime = Date.now();

    try {
      const { idempotencyKey, paymentMethod, transaction, customer, metadata } = req.body;

      if (!validateIdempotencyKey(idempotencyKey)) {
        return {
          statusCode: 400,
          body: {
            status: 'error',
            error: { code: 'invalid_idempotency_key', message: 'Idempotency key must be a valid UUID' },
            timestamp: new Date().toISOString()
          }
        };
      }

      await logger.log(idempotencyKey, customer.customerId, 'VALIDATE_KEY_START', {}, requestId);

      const cacheResult = await this.checkIdempotencyCache(idempotencyKey);
      if (cacheResult.found) {
        await logger.log(idempotencyKey, customer.customerId, 'CACHE_HIT',
          { cachedStatus: cacheResult.response.status }, requestId);
        return { statusCode: 200, body: cacheResult.response, cached: true };
      }

      await logger.log(idempotencyKey, customer.customerId, 'CACHE_MISS', {}, requestId);

      const validation = this.validatePayload(req.body);
      if (!validation.valid) {
        const errorResponse = this.buildErrorResponse(idempotencyKey, validation.error, false);
        await this.cacheResponse(idempotencyKey, customer.customerId, transaction.orderId,
          req.body, errorResponse, 'failed');
        await logger.log(idempotencyKey, customer.customerId, 'VALIDATION_ERROR',
          validation.error, requestId);
        return { statusCode: 400, body: errorResponse };
      }

      const fraudCheck = await this.performFraudChecks(req.body, metadata);
      if (fraudCheck.blocked) {
        const errorResponse = this.buildErrorResponse(idempotencyKey,
          { code: 'fraud_detected', message: 'Transaction blocked by fraud detection' }, false);
        await logger.log(idempotencyKey, customer.customerId, 'FRAUD_CHECK_FAILED',
          fraudCheck.reason, requestId);
        return { statusCode: 403, body: errorResponse };
      }

      let chargeResult;
      try {
        chargeResult = await this.chargeCard(req.body, requestId);
        await logger.log(idempotencyKey, customer.customerId, 'CHARGE_SUCCESS',
          { stripeChargeId: chargeResult.id }, requestId);
      } catch (err) {
        const errorResponse = this.buildErrorResponse(idempotencyKey, this.mapStripeError(err), true);
        await this.cacheResponse(idempotencyKey, customer.customerId, transaction.orderId,
          req.body, errorResponse, 'failed');
        await logger.log(idempotencyKey, customer.customerId, 'CHARGE_FAILED',
          { error: err.message }, requestId);
        return { statusCode: 400, body: errorResponse };
      }

      const transactionRecord = await this.createTransactionRecord({
        transactionId: uuidv4(),
        orderId: transaction.orderId,
        customerId: customer.customerId,
        amount: transaction.amount,
        currency: transaction.currency,
        stripeChargeId: chargeResult.id,
        status: 'completed'
      });

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

      await this.cacheResponse(idempotencyKey, customer.customerId, transaction.orderId,
        req.body, successResponse, 'completed');
      await logger.log(idempotencyKey, customer.customerId, 'PAYMENT_COMPLETE',
        { transactionId: transactionRecord.transaction_id }, requestId);

      console.log(`✓ Payment processed in ${Date.now() - startTime}ms (${idempotencyKey})`);
      return { statusCode: 200, body: successResponse };

    } catch (err) {
      console.error('Unexpected error in processPayment:', err);
      await logger.log(null, null, 'UNEXPECTED_ERROR', { error: err.message }, requestId);
      return {
        statusCode: 500,
        body: {
          status: 'error',
          error: { code: 'internal_server_error', message: 'An unexpected error occurred' },
          timestamp: new Date().toISOString()
        }
      };
    }
  }

  async checkIdempotencyCache(idempotencyKey) {
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
  }

  async cacheResponse(idempotencyKey, customerId, orderId, request, response, status) {
    await pool.query(
      `INSERT INTO idempotency_cache
       (idempotency_key, customer_id, order_id, request_hash, request_payload, response_payload, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO UPDATE SET
         response_payload = EXCLUDED.response_payload,
         status = EXCLUDED.status`,
      [idempotencyKey, customerId, orderId, hashPayload(request),
       JSON.stringify(request), JSON.stringify(response), status]
    );
  }

  validatePayload(body) {
    const { transaction, paymentMethod, customer } = body;

    if (!transaction.amount || typeof transaction.amount !== 'number' || transaction.amount <= 0) {
      return { valid: false, error: { code: 'invalid_amount', message: 'Amount must be a positive number' } };
    }
    if (!transaction.currency || !/^[A-Z]{3}$/.test(transaction.currency)) {
      return { valid: false, error: { code: 'invalid_currency', message: 'Currency must be a valid ISO 4217 code' } };
    }
    if (!paymentMethod.token) {
      return { valid: false, error: { code: 'invalid_token', message: 'Payment token is required' } };
    }
    if (paymentMethod.token.startsWith('4') && paymentMethod.token.length === 16) {
      return { valid: false, error: { code: 'invalid_payment_method', message: 'Raw card data not accepted. Use tokenized payment method.' } };
    }
    if (!customer.customerId) {
      return { valid: false, error: { code: 'invalid_customer', message: 'Customer ID is required' } };
    }
    if (!transaction.orderId) {
      return { valid: false, error: { code: 'invalid_order', message: 'Order ID is required' } };
    }

    return { valid: true };
  }

  async performFraudChecks(payload, metadata) {
    const { transaction, customer } = payload;

    const recentTransactions = await pool.query(
      `SELECT COUNT(*) as count FROM transactions
       WHERE customer_id = $1 AND created_at > NOW() - INTERVAL '5 minutes'`,
      [customer.customerId]
    );

    if (parseInt(recentTransactions.rows[0].count) > 5) {
      return { blocked: true, reason: 'Too many transactions in short time' };
    }

    const avgTransaction = await pool.query(
      `SELECT AVG(amount) as avg_amount FROM transactions
       WHERE customer_id = $1 AND created_at > NOW() - INTERVAL '90 days'`,
      [customer.customerId]
    );

    const avgAmount = parseInt(avgTransaction.rows[0].avg_amount) || 0;
    if (avgAmount > 0 && transaction.amount > avgAmount * 10) {
      console.warn(`⚠ High-value transaction: ${transaction.amount} vs avg ${avgAmount}`);
    }

    return { blocked: false };
  }

  async chargeCard(payload, requestId) {
    const { transaction, paymentMethod, customer } = payload;

    return stripe.charges.create({
      amount: transaction.amount,
      currency: transaction.currency,
      source: paymentMethod.token,
      description: `Order ${transaction.orderId}`,
      metadata: { orderId: transaction.orderId, customerId: customer.customerId, requestId },
      statement_descriptor: `Payment for order ${transaction.orderId}`.substring(0, 22)
    });
  }

  async createTransactionRecord(data) {
    const result = await pool.query(
      `INSERT INTO transactions
       (transaction_id, order_id, customer_id, amount, currency, status, stripe_charge_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [data.transactionId, data.orderId, data.customerId,
       data.amount, data.currency, data.status, data.stripeChargeId]
    );
    return result.rows[0];
  }

  buildErrorResponse(idempotencyKey, error, retryable = false) {
    return {
      status: 'error',
      error: { code: error.code, message: error.message },
      idempotencyKey,
      timestamp: new Date().toISOString(),
      retryable
    };
  }

  mapStripeError(stripeError) {
    const { type, code, message } = stripeError;

    if (type === 'StripeCardError') {
      if (code === 'card_declined') return { code: 'card_declined', message: 'Card was declined' };
      if (code === 'insufficient_funds') return { code: 'insufficient_funds', message: 'Insufficient funds' };
    }
    if (type === 'RateLimitError') return { code: 'rate_limit', message: 'Too many requests. Please retry.' };

    return { code: 'payment_failed', message: message || 'Payment processing failed' };
  }
}

module.exports = PaymentProcessor;
