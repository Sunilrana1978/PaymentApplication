const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { v4: uuidv4 } = require('uuid');
const { GetCommand, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const docClient = require('../config/dynamodb');
const logger = require('../utils/logger');
const { hashPayload, validateIdempotencyKey } = require('../utils/hash');

const IDEMPOTENCY_TABLE = process.env.IDEMPOTENCY_CACHE_TABLE;
const TRANSACTIONS_TABLE = process.env.TRANSACTIONS_TABLE;

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

      const fraudCheck = await this.performFraudChecks(req.body);
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

      const transactionId = uuidv4();
      await this.createTransactionRecord({
        transactionId,
        orderId: transaction.orderId,
        customerId: customer.customerId,
        amount: transaction.amount,
        currency: transaction.currency,
        stripeChargeId: chargeResult.id,
        status: 'completed'
      });

      const successResponse = {
        status: 'success',
        transactionId,
        idempotencyKey,
        amount: transaction.amount,
        currency: transaction.currency,
        orderId: transaction.orderId,
        timestamp: new Date().toISOString(),
        receipt: {
          receiptUrl: `https://receipts.payment.com/${transactionId}`,
          receiptId: transactionId
        }
      };

      await this.cacheResponse(idempotencyKey, customer.customerId, transaction.orderId,
        req.body, successResponse, 'completed');
      await logger.log(idempotencyKey, customer.customerId, 'PAYMENT_COMPLETE',
        { transactionId }, requestId);

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
    const result = await docClient.send(new GetCommand({
      TableName: IDEMPOTENCY_TABLE,
      Key: { idempotencyKey }
    }));

    if (result.Item) {
      // Guard against DynamoDB TTL propagation delay
      if (result.Item.expiresAt < Math.floor(Date.now() / 1000)) {
        return { found: false };
      }
      return {
        found: true,
        response: JSON.parse(result.Item.responsePayload),
        status: result.Item.status
      };
    }

    return { found: false };
  }

  async cacheResponse(idempotencyKey, customerId, orderId, request, response, status) {
    await docClient.send(new PutCommand({
      TableName: IDEMPOTENCY_TABLE,
      Item: {
        idempotencyKey,
        customerId,
        orderId,
        requestHash: hashPayload(request),
        requestPayload: JSON.stringify(request),
        responsePayload: JSON.stringify(response),
        status,
        createdAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60  // 24-hour TTL
      }
    }));
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

  async performFraudChecks(payload) {
    const { transaction, customer } = payload;

    // Velocity check: > 5 transactions per customer in 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const recentResult = await docClient.send(new QueryCommand({
      TableName: TRANSACTIONS_TABLE,
      IndexName: 'customerId-createdAt-index',
      KeyConditionExpression: 'customerId = :cid AND createdAt > :cutoff',
      ExpressionAttributeValues: { ':cid': customer.customerId, ':cutoff': fiveMinutesAgo },
      Select: 'COUNT'
    }));

    if (recentResult.Count > 5) {
      return { blocked: true, reason: 'Too many transactions in short time' };
    }

    // Amount anomaly: > 10x 90-day average (log only, don't block)
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const historyResult = await docClient.send(new QueryCommand({
      TableName: TRANSACTIONS_TABLE,
      IndexName: 'customerId-createdAt-index',
      KeyConditionExpression: 'customerId = :cid AND createdAt > :cutoff',
      ExpressionAttributeValues: { ':cid': customer.customerId, ':cutoff': ninetyDaysAgo },
      ProjectionExpression: 'amount'
    }));

    if (historyResult.Items.length > 0) {
      const avg = historyResult.Items.reduce((s, i) => s + i.amount, 0) / historyResult.Items.length;
      if (transaction.amount > avg * 10) {
        console.warn(`⚠ High-value transaction: ${transaction.amount} vs avg ${avg}`);
      }
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
    const now = new Date().toISOString();
    await docClient.send(new PutCommand({
      TableName: TRANSACTIONS_TABLE,
      Item: {
        transactionId: data.transactionId,
        orderId: data.orderId,
        customerId: data.customerId,
        amount: data.amount,
        currency: data.currency,
        status: data.status,
        stripeChargeId: data.stripeChargeId,
        paymentMethodType: 'card_token',
        createdAt: now,
        updatedAt: now
      },
      ConditionExpression: 'attribute_not_exists(transactionId)'
    }));
    return data;
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
