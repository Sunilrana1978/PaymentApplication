# Payment System Integration Guide

## Overview
This guide walks through integrating the secure, idempotent payment system into your shopping application. The system prevents duplicate charges, protects sensitive data, and handles network failures gracefully.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    SHOPPING APPLICATION                         │
├─────────────────────────────────────────────────────────────────┤
│  Frontend (React/Vue/Angular)                                   │
│  ├─ Shopping Cart Component                                     │
│  ├─ Payment Form (Stripe Elements)                             │
│  └─ SecurePaymentHandler (client-side logic)                  │
├─────────────────────────────────────────────────────────────────┤
│              HTTPS / TLS 1.2+ (Encrypted)                       │
├─────────────────────────────────────────────────────────────────┤
│  Backend API Server (Node.js + Express)                         │
│  ├─ /api/v1/payments/create (Main endpoint)                    │
│  ├─ Idempotency Cache Check (PostgreSQL)                       │
│  ├─ Fraud Detection                                             │
│  ├─ Payment Processing (Stripe API)                            │
│  ├─ Transaction Audit Trail (PostgreSQL)                       │
│  └─ Payment Logging                                             │
├─────────────────────────────────────────────────────────────────┤
│         HTTPS / TLS 1.2+ (Encrypted)                            │
├─────────────────────────────────────────────────────────────────┤
│  Payment Processor (Stripe)                                      │
│  ├─ Card Tokenization                                           │
│  ├─ Charge Processing                                           │
│  └─ Transaction Status                                          │
├─────────────────────────────────────────────────────────────────┤
│  Databases                                                       │
│  ├─ PostgreSQL: idempotency_cache, transactions, payment_logs  │
│  └─ Stripe: Customer, Payment Method, Charge records           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step 1: Backend Setup

### 1.1 Prerequisites

```bash
# Install dependencies
npm install express pg stripe uuid dotenv

# Other required packages
npm install cors helmet express-rate-limit
```

### 1.2 Environment Variables

Create `.env` file:

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/shopping_app
DB_MAX_CONNECTIONS=20

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# API
PORT=3000
NODE_ENV=production
LOG_LEVEL=info

# CORS
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100
```

### 1.3 Server Setup

```javascript
// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();

// Security middleware
app.use(helmet());
app.use(express.json({ limit: '10mb' }));

// CORS configuration
app.use(cors({
  origin: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(','),
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: 'Too many requests from this IP'
});

app.use('/api/', limiter);

// Import payment routes
const paymentRoutes = require('./routes/payment');
app.use('/api/v1/payments', paymentRoutes);

// Import payment processor
const { initializeDatabase } = require('./payment-processor-server');

// Start server
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
```

### 1.4 Database Initialization

```bash
# Connect to your PostgreSQL database
psql postgresql://user:password@localhost:5432/shopping_app

# Run initialization
node -e "require('./payment-processor-server').initializeDatabase()"
```

### 1.5 Routes Setup

```javascript
// routes/payment.js
const express = require('express');
const router = express.Router();
const PaymentProcessor = require('../payment-processor-server').PaymentProcessor;

const processor = new PaymentProcessor();

// Payment creation endpoint
router.post('/create', async (req, res) => {
  const result = await processor.processPayment(req);
  res.status(result.statusCode).json(result.body);
});

// Get transaction details
router.get('/:transactionId', async (req, res) => {
  // Implementation from payment-processor-server
});

// Webhook for Stripe events
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  try {
    const event = stripe.webhooks.constructEvent(
      req.rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    switch (event.type) {
      case 'charge.succeeded':
        // Log successful charge
        break;
      case 'charge.failed':
        // Handle failed charge
        break;
      case 'charge.refunded':
        // Handle refund
        break;
    }

    res.json({ received: true });
  } catch (err) {
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

module.exports = router;
```

---

## Step 2: Frontend Setup

### 2.1 Include Required Libraries

```html
<!DOCTYPE html>
<html>
<head>
  <!-- Stripe.js -->
  <script src="https://js.stripe.com/v3/"></script>
  
  <!-- Your payment handler -->
  <script src="/js/payment-handler-client.js"></script>
</head>
<body>
  <!-- Shopping cart content -->
  <div id="shopping-cart">
    <!-- Cart items -->
  </div>

  <!-- Payment form -->
  <form id="payment-form">
    <input type="hidden" id="cart-data" 
      data-cart-json='{"orderId":"ORD-12345","customerId":"cust_123","email":"user@example.com","billingZip":"97201","totalCents":9999,"items":[]}'>
    
    <div id="card-element"></div>
    <div id="card-errors" role="alert"></div>
    
    <button id="pay-button" type="button">Pay $99.99</button>
    <div id="payment-message"></div>
  </form>

  <script>
    // Initialize payment handler when DOM is ready
    document.addEventListener('DOMContentLoaded', () => {
      const handler = new SecurePaymentHandler({
        stripePublishableKey: '{{ STRIPE_PUBLIC_KEY }}',
        apiEndpoint: '/api/v1/payments/create',
        cardContainer: '#card-element',
        submitButton: '#pay-button',
        messageContainer: '#payment-message'
      });
    });
  </script>
</body>
</html>
```

### 2.2 React Integration Example

```jsx
// CheckoutForm.jsx
import React, { useState, useCallback } from 'react';
import { SecurePaymentHandler } from './payment-handler-client';

export default function CheckoutForm({ cart }) {
  const [paymentHandler, setPaymentHandler] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // Initialize payment handler on mount
    const handler = new SecurePaymentHandler({
      stripePublishableKey: process.env.REACT_APP_STRIPE_PUBLIC_KEY,
      apiEndpoint: '/api/v1/payments/create',
      apiKey: localStorage.getItem('api_key'),
      cardContainer: '#card-element',
      submitButton: '#pay-button',
      messageContainer: '#payment-message'
    });

    setPaymentHandler(handler);

    return () => handler.destroy();
  }, []);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    
    if (!paymentHandler) return;

    setProcessing(true);
    setError('');

    try {
      // Use retry logic
      const result = await paymentHandler.submitPaymentWithRetry(cart);

      if (result.success) {
        // Redirect to confirmation
        window.location.href = `/confirmation?txn=${result.transactionId}`;
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setProcessing(false);
    }
  }, [paymentHandler, cart]);

  return (
    <form onSubmit={handleSubmit}>
      <div id="card-element" className="form-group" />
      {error && <div className="error-message">{error}</div>}
      <button 
        id="pay-button" 
        type="submit" 
        disabled={processing}
        className="btn btn-primary"
      >
        {processing ? 'Processing...' : `Pay $${(cart.totalCents / 100).toFixed(2)}`}
      </button>
    </form>
  );
}
```

---

## Step 3: Testing

### 3.1 Test Scenarios

#### Scenario 1: Normal Payment Flow
```bash
# Start server
npm start

# Test with valid card
curl -X POST http://localhost:3000/api/v1/payments/create \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{
    "idempotencyKey": "550e8400-e29b-41d4-a716-446655440000",
    "paymentMethod": {
      "type": "card_token",
      "token": "tok_visa"
    },
    "transaction": {
      "amount": 9999,
      "currency": "USD",
      "orderId": "ORD-12345"
    },
    "customer": {
      "customerId": "cust_123",
      "email": "test@example.com",
      "billingAddress": {
        "zip": "97201",
        "country": "US"
      }
    }
  }'
```

#### Scenario 2: Duplicate Request (Idempotency Test)
```bash
# Send same request twice with same idempotency key
# Expected: First succeeds, second returns cached response (no double charge)

for i in {1..2}; do
  curl -X POST http://localhost:3000/api/v1/payments/create \
    -H "Content-Type: application/json" \
    -H "X-Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
    -d '{ ... same payload ... }'
  
  sleep 1
done
```

#### Scenario 3: Network Timeout Recovery
```javascript
// Simulate network failure then retry
const handler = new SecurePaymentHandler({ ... });

// First attempt times out
const result1 = await handler.submitPayment(cartData);
// Returns: { success: false, retryable: true, error: 'timeout' }

// Retry uses same idempotency key (from cache)
const result2 = await handler.submitPayment(cartData);
// Returns: Cached successful response - NO double charge
```

#### Scenario 4: Page Refresh
```javascript
// User submits payment
handler.submitPayment(cartData);  // idempotencyKey stored in localStorage

// Page refreshes before response
// User clicks "Pay" again - should use same idempotencyKey

const cachedKey = handler.getOrCreateIdempotencyKey(cartData.orderId);
// Returns same key from localStorage
// Server detects duplicate, returns cached response
```

### 3.2 Stripe Test Cards

```
Success:     4242 4242 4242 4242
Decline:     4000 0000 0000 0002
No funds:    4000 0000 0000 9995
Block fraud: 4100 0000 0000 0019

Expiry: 12/25
CVC: Any 3 digits
ZIP: Any 5 digits
```

### 3.3 Monitoring During Testing

```javascript
// Check cache hits in real-time
const result = await pool.query(
  `SELECT COUNT(*) as count, status 
   FROM idempotency_cache 
   WHERE created_at > NOW() - INTERVAL '1 hour'
   GROUP BY status`
);

// Should see:
// { count: 5, status: 'completed' }
// { count: 0, status: 'failed' }
// (indicating successful caching and deduplication)
```

---

## Step 4: Production Deployment

### 4.1 Security Checklist

- [ ] Use HTTPS/TLS 1.2+ everywhere
- [ ] Enable HSTS (HTTP Strict Transport Security)
- [ ] Configure CORS to only allow your domain
- [ ] Implement rate limiting (done in code)
- [ ] Set up Web Application Firewall (AWS WAF, Cloudflare)
- [ ] Enable database encryption at rest
- [ ] Use secrets manager (AWS Secrets Manager, HashiCorp Vault)
- [ ] Never log sensitive data (card tokens, customer IDs in plaintext)
- [ ] Enable request signing (API key rotation every 90 days)
- [ ] Set up VPC/private networking for database

### 4.2 Database Backups

```sql
-- Automated backup script (cron: daily)
pg_dump --clean --if-exists \
  --username=dbuser \
  --host=localhost \
  shopping_app > backup_$(date +\%Y\%m\%d).sql

-- Store in S3
aws s3 cp backup_*.sql s3://backups-bucket/payments/
```

### 4.3 Monitoring & Alerts

```javascript
// Setup CloudWatch/Datadog monitoring
const metrics = {
  cacheHitRate: cacheHits / totalRequests,
  avgProcessingTime: totalTime / requestCount,
  failureRate: failures / totalRequests,
  duplicateRequestCount: duplicates / totalRequests
};

// Alert if:
// - cacheHitRate < 50% (potential duplicate requests not working)
// - avgProcessingTime > 2000ms (database performance issue)
// - failureRate > 5% (payment processor issues)
```

### 4.4 Deployment Script

```bash
#!/bin/bash
# deploy.sh

set -e

echo "🚀 Deploying payment service..."

# 1. Run tests
echo "Running tests..."
npm test

# 2. Build
echo "Building..."
npm run build

# 3. Run migrations
echo "Running database migrations..."
npm run migrate

# 4. Start service
echo "Starting service..."
pm2 start payment-processor-server.js --name payment-api

# 5. Health check
sleep 5
curl http://localhost:3000/health || exit 1

echo "✓ Deployment complete"
```

---

## Step 5: Troubleshooting

### Issue: Double Charges Occurring

**Cause**: Idempotency key not being reused on retry

**Solution**:
```javascript
// ✗ Wrong: Generate new key on every attempt
async submitPayment() {
  const key = generateUUID();  // Creates new key!
  await api.post('/payment', { idempotencyKey: key });
}

// ✓ Correct: Reuse key for retries
async submitPayment() {
  const key = this.getOrCreateIdempotencyKey(orderId);
  // Store in localStorage
  await api.post('/payment', { idempotencyKey: key });
  // Retries use same key
}
```

### Issue: Cache Entries Growing Too Large

**Solution**:
```sql
-- Check cache size
SELECT pg_size_pretty(pg_total_relation_size('idempotency_cache'));

-- Run cleanup job
DELETE FROM idempotency_cache WHERE expires_at < NOW();

-- Vacuum to reclaim space
VACUUM ANALYZE idempotency_cache;

-- Add cron job (PostgreSQL pg_cron extension)
SELECT cron.schedule('cleanup-payment-cache', '0 2 * * *', 
  'DELETE FROM idempotency_cache WHERE expires_at < NOW()');
```

### Issue: Stripe Webhook Not Receiving Events

**Solution**:
```bash
# Install Stripe CLI
brew install stripe/stripe-cli/stripe

# Login
stripe login

# Forward webhooks to local server
stripe listen --forward-to localhost:3000/api/v1/payments/webhook

# Test webhook
stripe trigger charge.succeeded
```

### Issue: CORS Errors from Frontend

**Solution**:
```javascript
// In server.js, ensure CORS is configured correctly
app.use(cors({
  origin: ['https://yourdomain.com', 'https://www.yourdomain.com'],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key']
}));

// Also handle preflight
app.options('*', cors());
```

---

## Step 6: Performance Optimization

### 6.1 Database Query Optimization

```sql
-- Add proper indexes
CREATE INDEX CONCURRENTLY idx_idempotency_cache_lookup 
ON idempotency_cache(idempotency_key) 
WHERE expires_at > NOW();

-- Monitor query performance
EXPLAIN ANALYZE 
SELECT response_payload FROM idempotency_cache 
WHERE idempotency_key = $1 AND expires_at > NOW();

-- Should show: Seq Scan (bad) → Index Scan (good)
```

### 6.2 Cache Warming

```javascript
// Pre-load frequently accessed data
const warmCache = async () => {
  const topOrders = await pool.query(
    `SELECT idempotency_key FROM idempotency_cache 
     WHERE created_at > NOW() - INTERVAL '1 hour'
     ORDER BY created_at DESC LIMIT 1000`
  );
  
  // Keep in memory cache (Redis) for faster access
  for (const order of topOrders.rows) {
    await redis.setex(`payment:${order.idempotency_key}`, 3600, 'ok');
  }
};
```

### 6.3 Redis for Faster Caching (Optional)

```javascript
// Replace PostgreSQL cache checks with Redis (faster)
const redis = require('redis');
const client = redis.createClient(process.env.REDIS_URL);

async function checkIdempotencyCache(key) {
  // Try Redis first (10ms)
  const cached = await client.get(`payment:${key}`);
  if (cached) return JSON.parse(cached);

  // Fall back to PostgreSQL (100ms)
  const result = await pool.query(
    'SELECT response_payload FROM idempotency_cache WHERE idempotency_key = $1',
    [key]
  );

  if (result.rows.length > 0) {
    // Store in Redis for next time
    await client.setex(`payment:${key}`, 3600, 
      JSON.stringify(result.rows[0].response_payload));
    return result.rows[0].response_payload;
  }
}
```

---

## Summary Checklist

- [ ] Backend: Express server with payment processor
- [ ] Database: PostgreSQL with idempotency cache
- [ ] Frontend: Stripe Elements + SecurePaymentHandler
- [ ] Idempotency: Keys generated, cached, and reused
- [ ] Retry Logic: Exponential backoff (2s, 4s, 8s)
- [ ] Error Handling: Retryable vs non-retryable errors
- [ ] Security: HTTPS, no sensitive data in requests
- [ ] Testing: All scenarios (double-click, timeout, refresh)
- [ ] Monitoring: Cache hit rate, processing time, failures
- [ ] Deployment: Security hardening, backups, alerts

---

## Support & Resources

- **Stripe Documentation**: https://stripe.com/docs
- **PostgreSQL Docs**: https://www.postgresql.org/docs/
- **Idempotency RFC**: https://tools.ietf.org/html/draft-idempotency-header-def
- **Payment PCI Compliance**: https://www.pcisecuritystandards.org/

Your payment system is now secure, idempotent, and production-ready! 🎉
