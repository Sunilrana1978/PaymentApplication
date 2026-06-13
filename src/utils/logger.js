const pool = require('../config/db');

class PaymentLogger {
  async log(idempotencyKey, customerId, event, details, requestId) {
    await pool.query(
      `INSERT INTO payment_logs (idempotency_key, customer_id, event, details, request_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [idempotencyKey, customerId, event, JSON.stringify(details), requestId]
    );
  }
}

module.exports = new PaymentLogger();
