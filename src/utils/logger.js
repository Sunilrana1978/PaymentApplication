const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');
const docClient = require('../config/dynamodb');

class PaymentLogger {
  async log(idempotencyKey, customerId, event, details, requestId) {
    try {
      await docClient.send(new PutCommand({
        TableName: process.env.PAYMENT_LOGS_TABLE,
        Item: {
          idempotencyKey: idempotencyKey || 'SYSTEM',
          timestamp: `${new Date().toISOString()}#${uuidv4()}`,
          customerId: customerId || 'SYSTEM',
          event,
          details: JSON.stringify(details || {}),
          requestId: requestId || uuidv4(),
          expiresAt: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60  // 90-day TTL
        }
      }));
    } catch (err) {
      console.error('Logger error:', err.message);
    }
  }
}

module.exports = new PaymentLogger();
