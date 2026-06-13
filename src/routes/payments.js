const express = require('express');
const router = express.Router();
const { GetCommand } = require('@aws-sdk/lib-dynamodb');
const docClient = require('../config/dynamodb');
const PaymentProcessor = require('../services/PaymentProcessor');

const processor = new PaymentProcessor();

router.post('/create', async (req, res) => {
  const result = await processor.processPayment(req);
  res.status(result.statusCode).json(result.body);
});

router.get('/:transactionId', async (req, res) => {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: process.env.TRANSACTIONS_TABLE,
      Key: { transactionId: req.params.transactionId }
    }));
    if (!result.Item) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    res.json(result.Item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
