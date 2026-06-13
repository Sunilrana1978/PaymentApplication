# PaymentApplication

A secure, idempotent payment processing system built with Node.js, Express, PostgreSQL, and Stripe. Prevents duplicate charges, protects sensitive data, and handles network failures gracefully.

## Features

- **Idempotency** — duplicate requests (double-clicks, retries, page refreshes) never result in double charges
- **Tokenization** — raw card data never touches the server; Stripe Elements handles it client-side
- **Fraud detection** — velocity checks and transaction anomaly flagging
- **Audit trail** — immutable transaction log in PostgreSQL
- **Retry logic** — exponential backoff (2s, 4s, 8s) with retryable/non-retryable error classification

## Project Structure

```
PaymentApplication/
├── src/
│   ├── config/db.js                  # PostgreSQL connection pool
│   ├── db/schema.js                  # Database table initialization
│   ├── utils/logger.js               # Payment event logger
│   ├── utils/hash.js                 # Payload hashing and UUID validation
│   ├── services/PaymentProcessor.js  # Core payment processing logic
│   ├── routes/payments.js            # Express route handlers
│   └── app.js                        # Express app (middleware + routes)
├── public/js/
│   └── payment-handler.js            # Browser client (Stripe Elements + idempotency)
├── docs/
│   ├── api-spec.md                   # Full API request/response specification
│   └── integration-guide.md         # Step-by-step integration guide
├── index.js                          # Server entry point
├── package.json
└── .env.example
```

## Prerequisites

- Node.js 18+
- PostgreSQL 13+
- Stripe account

## Getting Started

**1. Install dependencies**
```bash
npm install
```

**2. Configure environment**
```bash
cp .env.example .env
```

Edit `.env` with your values:
```
DATABASE_URL=postgresql://user:password@localhost:5432/shopping_app
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
PORT=3000
ALLOWED_ORIGINS=https://yourdomain.com
```

**3. Initialize the database**
```bash
npm run db:init
```

**4. Start the server**
```bash
npm start        # production
npm run dev      # development (auto-reload)
```

## API

### POST `/api/v1/payments/create`

| Header | Description |
|--------|-------------|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer <api-key>` |
| `X-Idempotency-Key` | UUID v4 (same key on retries) |

**Request body:**
```json
{
  "idempotencyKey": "550e8400-e29b-41d4-a716-446655440000",
  "paymentMethod": { "type": "card_token", "token": "tok_visa" },
  "transaction": { "amount": 9999, "currency": "USD", "orderId": "ORD-12345" },
  "customer": {
    "customerId": "cust_123",
    "email": "user@example.com",
    "billingAddress": { "zip": "97201", "country": "US" }
  }
}
```

> Amounts are in the smallest currency unit (cents). $99.99 → `9999`

**Success response:**
```json
{
  "status": "success",
  "transactionId": "txn_abc123",
  "amount": 9999,
  "currency": "USD",
  "orderId": "ORD-12345",
  "timestamp": "2024-06-15T10:30:50Z"
}
```

### GET `/api/v1/payments/:transactionId`
Returns transaction details from the audit trail.

### GET `/health`
Returns `{ "status": "healthy" }` when the server and database are reachable.

### POST `/api/v1/payments/admin/cleanup-cache`
Deletes expired idempotency cache entries.

## Frontend Integration

Include Stripe.js and the payment handler on your checkout page:

```html
<script src="https://js.stripe.com/v3/"></script>
<script src="/js/payment-handler.js"></script>

<div id="card-element"></div>
<button id="pay-button">Pay $99.99</button>
<div id="payment-message"></div>

<script>
  const handler = new SecurePaymentHandler({
    stripePublishableKey: 'pk_live_...',
    apiEndpoint: '/api/v1/payments/create',
    cardContainer: '#card-element',
    submitButton: '#pay-button',
    messageContainer: '#payment-message'
  });
</script>
```

Cart data is read from a `data-cart-json` attribute or `window.CART_DATA`:

```html
<input type="hidden" data-cart-json='{"orderId":"ORD-12345","customerId":"cust_123","email":"user@example.com","billingZip":"97201","totalCents":9999,"items":[]}'>
```

See [`docs/integration-guide.md`](docs/integration-guide.md) for React integration and full examples.

## Testing

**Stripe test cards:**

| Card | Scenario |
|------|----------|
| `4242 4242 4242 4242` | Success |
| `4000 0000 0000 0002` | Card declined |
| `4000 0000 0000 9995` | Insufficient funds |

Expiry: any future date — CVC: any 3 digits

**Test idempotency (no double charge on duplicate request):**
```bash
for i in {1..2}; do
  curl -X POST http://localhost:3000/api/v1/payments/create \
    -H "Content-Type: application/json" \
    -H "X-Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
    -d '{ ...same payload... }'
done
```

**Test webhooks locally:**
```bash
stripe listen --forward-to localhost:3000/api/v1/payments/webhook
stripe trigger charge.succeeded
```

## How Idempotency Works

1. Client generates a UUID v4 on the first "Pay" click and stores it in `localStorage`
2. The same key is reused on every retry for that order
3. Server checks `idempotency_cache` before processing — if the key exists, the cached response is returned immediately with no charge
4. Cache entries expire after 24 hours

This means double-clicks, network timeouts, and page refreshes are all safe — only one charge ever occurs per order.

## Database Schema

| Table | Purpose |
|-------|---------|
| `idempotency_cache` | Request deduplication; stores request + response JSON, expires after 24h |
| `transactions` | Immutable audit trail; one row per successful charge |
| `payment_logs` | Event log for every processing step, keyed by `request_id` |

## Resources

- [Stripe Documentation](https://stripe.com/docs)
- [API Specification](docs/api-spec.md)
- [Integration Guide](docs/integration-guide.md)
- [PCI DSS Standards](https://www.pcisecuritystandards.org/)
