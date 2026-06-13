const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const PaymentProcessor = require('../services/PaymentProcessor');

const processor = new PaymentProcessor();

router.post('/create', async (req, res) => {
  const result = await processor.processPayment(req);
  res.status(result.statusCode).json(result.body);
});

router.get('/:transactionId', async (req, res) => {
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

router.post('/admin/cleanup-cache', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM idempotency_cache WHERE expires_at < NOW()'
    );
    res.json({ cleaned: result.rowCount, message: 'Cache cleanup completed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
