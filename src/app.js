require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pool = require('./config/db');

const app = express();

app.use(helmet());
app.use(express.json({ limit: '10mb' }));

const corsOptions = {
  origin: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(','),
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key']
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: 'Too many requests from this IP'
});
app.use('/api/', limiter);

app.use('/api/v1/payments', require('./routes/payments'));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', service: 'payment-processor' });
  } catch (err) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

module.exports = app;
