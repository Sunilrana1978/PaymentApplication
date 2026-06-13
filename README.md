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
├── .github/workflows/
│   ├── ci.yml                        # CI — runs on every PR (audit, validate template)
│   └── deploy.yml                    # CD — deploys to AWS on push to main
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
│   ├── aws-deployment.md             # Step-by-step AWS deployment guide
│   └── cicd-setup.md                 # CI/CD pipeline setup guide
├── infrastructure/
│   ├── cloudformation.yml            # Serverless app stack (Lambda, API GW, DynamoDB)
│   └── github-oidc.yml              # One-time OIDC setup (GitHub → AWS auth)
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

## CI/CD Pipeline

Every push to `main` automatically deploys to production via GitHub Actions.

```
Pull Request ──► CI (audit + validate template)
                        │
                 merge to main
                        │
                        ▼
             Deploy workflow
                  │
       ┌──────────┼──────────┐
       ▼          ▼          ▼
    Package    Upload     Deploy
    (ZIP)       (S3)  (CloudFormation)
                           │
                           ▼
                     Smoke tests
               (health check + payment endpoint)
```

| Workflow | Trigger | Steps |
|----------|---------|-------|
| `ci.yml` | Every PR and push | `npm audit`, CloudFormation template validation |
| `deploy.yml` | Push to `main` or manual | Package → S3 → CloudFormation → smoke test |

**Authentication uses GitHub OIDC** — no long-lived AWS access keys stored in GitHub secrets. The `infrastructure/github-oidc.yml` stack creates a scoped IAM role that GitHub Actions assumes via short-lived tokens.

**Required GitHub secrets:**

| Secret | Description |
|--------|-------------|
| `AWS_ROLE_ARN` | IAM role ARN from the OIDC stack |
| `LAMBDA_DEPLOY_BUCKET` | S3 bucket for Lambda ZIPs |
| `STRIPE_SECRET_KEY` | `sk_live_...` |
| `STRIPE_PUBLISHABLE_KEY` | `pk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` |
| `ALLOWED_ORIGINS` | `https://yourdomain.com` |

Each Lambda package is named `payment-app-{commit-sha}.zip`, making rollback as simple as redeploying with a previous SHA.

See [`docs/cicd-setup.md`](docs/cicd-setup.md) for the full setup guide (OIDC stack, GitHub secrets, environment protection rules).

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

Idempotency ensures that no matter how many times a payment request is submitted with the same key — due to a double-click, network timeout, retry, or page refresh — **only one charge is ever created**.

### Key generation (client side)

```
User clicks "Pay"
      │
      ▼
localStorage has key for this orderId?
      │
   Yes│                    No│
      ▼                      ▼
Reuse existing key      Generate UUID v4
(within 1h TTL)         Store in localStorage
                        under "payment_<orderId>"
      │                      │
      └──────────┬───────────┘
                 ▼
      Attach key to every request
      (body: idempotencyKey + header: X-Idempotency-Key)
```

- The key is generated **once** per order on the very first "Pay" click.
- It is stored in `localStorage` with a 1-hour TTL so the same key survives page refreshes and network retries.
- On success or a non-retryable failure (e.g. card declined), the key is cleared from `localStorage`.

### Server-side deduplication (Lambda + DynamoDB)

```
POST /api/v1/payments/create  {idempotencyKey: "uuid-v4", ...}
      │
      ▼
1. Validate idempotency key format (must be UUID v4)
      │
      ▼
2. DynamoDB GetItem on IdempotencyCacheTable
      │
   Hit│                   Miss│
      ▼                       ▼
Return cached            3. Validate payload
response (HTTP 200)         (amount, currency, token, customerId, orderId)
← no Stripe call                │
← no second charge              ▼
                         4. Fraud checks
                            • Velocity: >5 charges by same customer in 5 min → block
                            • Anomaly: >10× 90-day avg → log & flag
                                │
                                ▼
                         5. stripe.charges.create
                                │
                                ▼
                         6. DynamoDB PutItem → TransactionsTable
                            (condition: attribute_not_exists — immutable write)
                                │
                                ▼
                         7. DynamoDB PutItem → IdempotencyCacheTable
                            (TTL = now + 24h)
                                │
                                ▼
                         Return success response
```

### What the cache stores

Each entry in `IdempotencyCacheTable` holds the original response payload so that replays return **identical data** — same `transactionId`, same `amount`, same `timestamp`:

| Field | Value |
|-------|-------|
| `idempotencyKey` (PK) | UUID v4 from the client |
| `response` | Serialised success/error response |
| `ttl` | Unix epoch — 24 hours from first request |

DynamoDB TTL deletes the entry automatically after 24 hours; no cleanup job needed.

### Scenario walkthrough

| Scenario | What happens |
|----------|-------------|
| User double-clicks "Pay" | Second request arrives with the same key while first is in-flight — server processes it sequentially; DynamoDB conditional write on `TransactionsTable` ensures only one record is inserted |
| Network timeout on first attempt | Client retries with the same `localStorage` key → cache hit → same response, no new charge |
| Page refresh mid-payment | Key is still in `localStorage` (1h TTL) → retry reuses key → cache hit if first attempt succeeded |
| User opens a new tab | `localStorage` is shared across tabs → same key → deduplicated |
| 24+ hours later, user retries | Cache entry has expired → treated as a new payment → new charge (expected) |
| Non-retryable error (card declined) | Key is cleared from `localStorage` → next attempt generates a fresh key (correct — no charge to deduplicate) |

### Why UUID v4?

UUIDs are validated server-side with a strict regex. Sequential or predictable keys would let callers "guess" another customer's key and hijack their cached response. UUID v4 has ~122 bits of entropy, making collisions statistically impossible.

Double-clicks, network timeouts, and page refreshes are all safe — only one charge ever occurs per order.

## How Fraud Detection Works

Two independent checks run on every new payment request (cache misses only — replays skip fraud checks entirely).

```
Incoming payment request (cache miss)
             │
             ▼
┌─────────────────────────────────┐
│  Check 1: Velocity              │  DynamoDB Query on
│  >5 transactions by this        │  customerId-createdAt-index
│  customer in the last 5 min?    │  (SELECT COUNT)
└────────────┬────────────────────┘
             │
          Yes│ Block                   No│ Continue
             ▼                          ▼
    HTTP 403 fraud_detected   ┌─────────────────────────────────┐
    (not cached, not charged) │  Check 2: Amount Anomaly        │  DynamoDB Query on
                              │  Is this amount >10× the        │  customerId-createdAt-index
                              │  customer's 90-day average?     │  (ProjectionExpression: amount)
                              └────────────┬────────────────────┘
                                           │
                                   Yes│ Warn            No│ Pass
                                       ▼                   ▼
                               console.warn +        Proceed to
                               log, but allow        stripe.charges.create
                               the charge
```

### Check 1 — Velocity (hard block)

Queries `TransactionsTable` via the `customerId-createdAt-index` GSI for all records where `createdAt > now - 5 minutes`. Only the count is fetched (`Select: COUNT`) — no data is transferred.

| Threshold | Action | HTTP response |
|-----------|--------|---------------|
| ≤ 5 transactions in 5 min | Allow | Continue to charge |
| > 5 transactions in 5 min | **Block** | `403 fraud_detected` |

The block response is **not cached** in `IdempotencyCacheTable`. If the same idempotency key is retried after the velocity window clears, the check runs again and may pass.

### Check 2 — Amount Anomaly (soft flag)

Queries the same GSI for all transactions in the past 90 days, projecting only the `amount` field. Computes the customer's average and compares it to the current request.

| Condition | Action |
|-----------|--------|
| No history (new customer) | Skip — no average to compare |
| Amount ≤ 10× 90-day average | Allow silently |
| Amount > 10× 90-day average | `console.warn` + allow (charge still proceeds) |

This is a **soft signal** — it flags unusual amounts for manual review without blocking legitimate large purchases (e.g. a customer's first enterprise order).

### Why two separate checks?

| | Velocity | Amount Anomaly |
|-|----------|----------------|
| **Detects** | Credential stuffing, card testing loops | Account takeover, unusual single transaction |
| **Time window** | 5 minutes | 90 days |
| **Data fetched** | COUNT only (cheap) | All amounts (heavier, but infrequent trigger) |
| **Action** | Hard block | Log & allow |
| **False-positive risk** | Low (rate is the signal) | Medium (first big purchase looks anomalous) |

### What is NOT checked

- **Geographic / IP anomaly** — not implemented; would require storing IP per transaction.
- **Card BIN validation** — Stripe handles this on their end.
- **Cross-customer patterns** — checks are scoped per `customerId`; no global velocity ring is implemented.
- **Cached responses** — fraud checks are **skipped entirely** for idempotency cache hits. The first request bears the cost; retries are free.

### DynamoDB access pattern

Both checks share the same GSI: `customerId-createdAt-index` on `TransactionsTable`.

```
GSI Key:   customerId (PK)  +  createdAt (SK, ISO 8601 string)
           ──────────────────────────────────────────────────
           Enables range queries:  createdAt > "<cutoff>"
           Without a full table scan
```

ISO 8601 strings sort lexicographically in the same order as chronologically, so `createdAt > "2026-06-13T10:00:00.000Z"` is a valid and efficient DynamoDB range condition.

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
- [CI/CD Setup Guide](docs/cicd-setup.md)
- [PCI DSS Standards](https://www.pcisecuritystandards.org/)
