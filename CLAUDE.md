# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A secure, idempotent payment processing system built with Node.js/Express and Stripe. The system prevents duplicate charges through server-side idempotency caching in PostgreSQL and client-side idempotency key persistence in `localStorage`.

## Project Structure

```
PaymentApplication/
├── src/
│   ├── config/db.js              # PostgreSQL pool (pg.Pool)
│   ├── db/schema.js              # initializeDatabase() — creates all tables
│   ├── utils/logger.js           # PaymentLogger singleton
│   ├── utils/hash.js             # hashPayload(), validateIdempotencyKey()
│   ├── services/PaymentProcessor.js  # Core payment logic class
│   ├── routes/payments.js        # Express route handlers
│   └── app.js                    # Express app setup (middleware, routes)
├── public/js/
│   └── payment-handler.js        # Browser client: SecurePaymentHandler, RequestCache
├── docs/
│   ├── api-spec.md               # Full API request/response spec
│   └── integration-guide.md     # Step-by-step integration guide
├── index.js                      # Entry point: DB init + app.listen
├── package.json
├── .env.example
└── .gitignore
```

## Setup

**Install dependencies:**
```bash
npm install
```

**Environment variables** — copy `.env.example` to `.env` and fill in values:
```
DATABASE_URL=postgresql://user:password@localhost:5432/shopping_app
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
PORT=3000
ALLOWED_ORIGINS=https://yourdomain.com
```

**Initialize database schema:**
```bash
npm run db:init
```

**Start the server:**
```bash
npm start          # production
npm run dev        # development (nodemon)
```

**Test a payment:**
```bash
curl -X POST http://localhost:3000/api/v1/payments/create \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{
    "idempotencyKey": "550e8400-e29b-41d4-a716-446655440000",
    "paymentMethod": { "type": "card_token", "token": "tok_visa" },
    "transaction": { "amount": 9999, "currency": "USD", "orderId": "ORD-12345" },
    "customer": { "customerId": "cust_123", "email": "test@example.com", "billingAddress": { "zip": "97201", "country": "US" } }
  }'
```

**Health check:** `GET /health`

**Test webhooks locally:**
```bash
stripe listen --forward-to localhost:3000/api/v1/payments/webhook
stripe trigger charge.succeeded
```

## Architecture

### Payment Flow (Server-side, `PaymentProcessor.processPayment`)
1. Validate idempotency key (must be UUID v4)
2. **Check `idempotency_cache`** — return cached response immediately if found (prevents double charges)
3. Validate payload (amount, currency ISO 4217, token not raw card, customerId, orderId)
4. Fraud checks: velocity (>5 transactions per customer in 5 minutes = blocked), amount anomaly (>10x historical average = logged)
5. Charge via `stripe.charges.create`
6. Write to `transactions` table (immutable audit trail)
7. Cache success response in `idempotency_cache` (24h TTL)

### Idempotency Key Lifecycle (Client-side, `SecurePaymentHandler`)
- Generated once per order as UUID v4 on first "Pay" click; stored in `localStorage` under `payment_<orderId>` with 1-hour TTL via `RequestCache`
- Reused on all retries for the same order — this is what prevents double charges on timeout/page refresh
- Deleted from localStorage on success or non-retryable failure
- Sent in both the request body (`idempotencyKey`) and `X-Idempotency-Key` header

### Database Tables (PostgreSQL)
- **`idempotency_cache`** — keyed by `idempotency_key` (UUID), stores full request+response JSON, expires after 24h
- **`transactions`** — immutable audit trail; one row per successful charge, references `stripe_charge_id`
- **`payment_logs`** — event log for every step (CACHE_HIT, CHARGE_SUCCESS, etc.) with `request_id` for tracing

### Retryable vs Non-retryable Errors
Retryable: `insufficient_funds`, `timeout`, `rate_limit`
Non-retryable: `card_declined`, `invalid_token`, `duplicate_transaction`, `invalid_amount`

Client uses exponential backoff (2s, 4s, 8s) for retryable errors up to 3 attempts.

### Stripe Test Cards
```
Success:  4242 4242 4242 4242
Decline:  4000 0000 0000 0002
No funds: 4000 0000 0000 9995
Expiry: 12/25, CVC: any 3 digits
```

## Key Invariants

- **Never send raw card data to the server** — `validatePayload` rejects tokens that look like card numbers (16-digit starting with 4). Card data is tokenized client-side via Stripe Elements before any network call.
- **Amounts are always in cents (smallest currency unit)** — $99.99 = `9999`.
- **Cache entries expire after 24 hours** — run `POST /api/v1/payments/admin/cleanup-cache` or a pg_cron job to purge expired rows.
- The `simpleHash` in `public/js/payment-handler.js` is a placeholder — production use should replace with `crypto.subtle` for the cart checksum.
