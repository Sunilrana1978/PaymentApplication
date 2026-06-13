# PaymentApplication

A secure, idempotent payment processing system built with Node.js, Express, and Stripe. Deployed serverlessly on AWS — Lambda + API Gateway + DynamoDB. Prevents duplicate charges, protects sensitive data, and handles network failures gracefully.

## Architecture

```
Browser / Client
       │
       ▼ HTTPS
┌─────────────────────┐
│  API Gateway        │  HTTP API — built-in CORS, throttling
│  (HTTP API v2)      │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  AWS Lambda         │  Node.js 18 · Express via serverless-http
│  payment-app        │
└──────────┬──────────┘
           │
    ┌──────┴──────┐
    ▼             ▼
┌────────┐  ┌───────────────┐
│DynamoDB│  │Secrets Manager│
│Tables  │  │(Stripe keys)  │
└────────┘  └───────────────┘
```

No VPC, no servers, no infrastructure to manage. Scales to zero when idle.

## Features

- **Idempotency** — duplicate requests (double-clicks, retries, page refreshes) never result in double charges
- **Tokenization** — raw card data never touches the server; Stripe Elements handles it client-side
- **Fraud detection** — velocity checks and transaction anomaly flagging
- **Audit trail** — immutable transaction log in DynamoDB with point-in-time recovery
- **Retry logic** — exponential backoff (2s, 4s, 8s) with retryable/non-retryable error classification
- **Serverless** — ~$7.50/month at moderate volume; scales to zero

## Project Structure

```
PaymentApplication/
├── src/
│   ├── config/dynamodb.js            # DynamoDB Document Client (AWS SDK v3)
│   ├── utils/logger.js               # Payment event logger (DynamoDB)
│   ├── utils/hash.js                 # Payload hashing and UUID validation
│   ├── services/PaymentProcessor.js  # Core payment processing logic
│   ├── routes/payments.js            # Express route handlers
│   └── app.js                        # Express app (middleware + routes)
├── public/js/
│   └── payment-handler.js            # Browser client (Stripe Elements + idempotency)
├── docs/
│   ├── api-spec.md                   # Full API request/response specification
│   ├── integration-guide.md          # Frontend integration guide
│   └── aws-deployment.md            # Step-by-step AWS deployment guide
├── infrastructure/
│   └── cloudformation.yml           # Full serverless stack (Lambda, API GW, DynamoDB)
├── lambda.js                         # AWS Lambda entry point
├── index.js                          # Local development entry point
├── docker-compose.yml               # Local dev with DynamoDB Local
├── Dockerfile
├── package.json
└── .env.example
```

## Local Development

**Requirements:** Docker, Node.js 18+, Stripe account

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Add your Stripe test key: STRIPE_SECRET_KEY=sk_test_...

# 3. Start app + DynamoDB Local + Admin UI
docker-compose up
```

| Service | URL |
|---------|-----|
| Payment API | http://localhost:3000 |
| DynamoDB Admin UI | http://localhost:8001 |

**Create local DynamoDB tables** (once, after first `docker-compose up`):

```bash
# Idempotency cache
AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
aws dynamodb create-table \
  --table-name payment-idempotency-cache-development \
  --attribute-definitions AttributeName=idempotencyKey,AttributeType=S \
  --key-schema AttributeName=idempotencyKey,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --endpoint-url http://localhost:8000 --region us-east-1

# Transactions
AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
aws dynamodb create-table \
  --table-name payment-transactions-development \
  --attribute-definitions \
    AttributeName=transactionId,AttributeType=S \
    AttributeName=customerId,AttributeType=S \
    AttributeName=createdAt,AttributeType=S \
  --key-schema AttributeName=transactionId,KeyType=HASH \
  --global-secondary-indexes '[{"IndexName":"customerId-createdAt-index","KeySchema":[{"AttributeName":"customerId","KeyType":"HASH"},{"AttributeName":"createdAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]' \
  --billing-mode PAY_PER_REQUEST \
  --endpoint-url http://localhost:8000 --region us-east-1

# Payment logs
AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
aws dynamodb create-table \
  --table-name payment-logs-development \
  --attribute-definitions \
    AttributeName=idempotencyKey,AttributeType=S \
    AttributeName=timestamp,AttributeType=S \
  --key-schema \
    AttributeName=idempotencyKey,KeyType=HASH \
    AttributeName=timestamp,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --endpoint-url http://localhost:8000 --region us-east-1
```

## AWS Deployment

See [`docs/aws-deployment.md`](docs/aws-deployment.md) for the full guide. Quick summary:

```bash
# 1. Package Lambda code
npm ci --only=production
zip -r payment-app.zip . --exclude "*.git*" --exclude "docs/*" \
  --exclude "infrastructure/*" --exclude "*.md" --exclude ".env*" \
  --exclude "docker-compose.yml" --exclude "public/*"

# 2. Upload to S3
aws s3 cp payment-app.zip s3://YOUR-DEPLOY-BUCKET/

# 3. Deploy stack
aws cloudformation deploy \
  --template-file infrastructure/cloudformation.yml \
  --stack-name payment-app-production \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    Environment=production \
    LambdaCodeBucket=YOUR-DEPLOY-BUCKET \
    LambdaCodeKey=payment-app.zip \
    AllowedOrigins=https://yourdomain.com \
    StripeSecretKey=sk_live_... \
    StripePublishableKey=pk_live_... \
    StripeWebhookSecret=whsec_...
```

## API

### POST `/api/v1/payments/create`

| Header | Description |
|--------|-------------|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer <api-key>` |
| `X-Idempotency-Key` | UUID v4 — reuse the same key on retries |

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
Returns transaction details from DynamoDB.

### GET `/health`
Returns `{ "status": "healthy" }`.

## Frontend Integration

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

See [`docs/integration-guide.md`](docs/integration-guide.md) for React integration and full examples.

## Testing

**Stripe test cards:**

| Card | Scenario |
|------|----------|
| `4242 4242 4242 4242` | Success |
| `4000 0000 0000 0002` | Card declined |
| `4000 0000 0000 9995` | Insufficient funds |

Expiry: any future date — CVC: any 3 digits

**Test idempotency (send same request twice — expect one charge):**
```bash
for i in {1..2}; do
  curl -X POST http://localhost:3000/api/v1/payments/create \
    -H "Content-Type: application/json" \
    -H "X-Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
    -d '{
      "idempotencyKey": "550e8400-e29b-41d4-a716-446655440000",
      "paymentMethod": { "type": "card_token", "token": "tok_visa" },
      "transaction": { "amount": 9999, "currency": "USD", "orderId": "ORD-12345" },
      "customer": { "customerId": "cust_123", "email": "test@example.com", "billingAddress": { "zip": "97201", "country": "US" } }
    }'
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
3. Lambda checks DynamoDB `idempotency-cache` before processing — if the key exists, the cached response is returned immediately with no charge
4. Cache entries expire automatically after 24 hours via DynamoDB TTL

Double-clicks, network timeouts, and page refreshes are all safe — only one charge ever occurs per order.

## DynamoDB Tables

| Table | Key | TTL | Purpose |
|-------|-----|-----|---------|
| `payment-idempotency-cache-{env}` | `idempotencyKey` | 24h | Request deduplication |
| `payment-transactions-{env}` | `transactionId` | — | Immutable audit trail |
| `payment-logs-{env}` | `idempotencyKey` + `timestamp` | 90d | Per-step event log |

All tables have point-in-time recovery enabled and `DeletionPolicy: Retain` — deleting the CloudFormation stack never destroys transaction data.

## Resources

- [Stripe Documentation](https://stripe.com/docs)
- [API Specification](docs/api-spec.md)
- [Integration Guide](docs/integration-guide.md)
- [AWS Deployment Guide](docs/aws-deployment.md)
- [PCI DSS Standards](https://www.pcisecuritystandards.org/)
