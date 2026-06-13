# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A secure, idempotent payment processing system. Serverless architecture: AWS Lambda (Node.js/Express via `serverless-http`) + API Gateway HTTP API + DynamoDB. Prevents duplicate charges through DynamoDB-backed idempotency caching and client-side `localStorage` key persistence.

## Project Structure

```
PaymentApplication/
├── src/
│   ├── config/dynamodb.js            # DynamoDB Document Client (AWS SDK v3)
│   ├── utils/logger.js               # PaymentLogger — writes to PaymentLogsTable
│   ├── utils/hash.js                 # hashPayload(), validateIdempotencyKey()
│   ├── services/PaymentProcessor.js  # Core payment logic (DynamoDB + Stripe)
│   ├── routes/payments.js            # Express routes
│   └── app.js                        # Express app setup (middleware, routes)
├── public/js/
│   └── payment-handler.js            # Browser client (Stripe Elements + idempotency)
├── docs/
│   ├── api-spec.md                   # Full API request/response specification
│   ├── integration-guide.md          # Frontend integration guide
│   └── aws-deployment.md            # Step-by-step AWS deployment guide
├── infrastructure/
│   └── cloudformation.yml           # Full serverless stack definition
├── lambda.js                         # AWS Lambda entry point (wraps Express)
├── index.js                          # Local development entry point
├── docker-compose.yml               # Local dev with DynamoDB Local
├── Dockerfile
├── package.json
└── .env.example
```

## Commands

**Local development (with DynamoDB Local):**
```bash
cp .env.example .env   # fill in STRIPE_SECRET_KEY
docker-compose up      # app on :3000, DynamoDB Admin UI on :8001
```

Run the local DynamoDB table setup commands from `docs/aws-deployment.md` on first start.

**Run server directly (requires AWS credentials + real DynamoDB tables):**
```bash
npm install
npm run dev    # nodemon
npm start      # node
```

**Deploy to AWS:**
```bash
# Package
npm ci --only=production
zip -r payment-app.zip . --exclude "*.git*" --exclude "docs/*" --exclude "infrastructure/*" --exclude "*.md" --exclude ".env*" --exclude "docker-compose.yml" --exclude "public/*"
aws s3 cp payment-app.zip s3://YOUR-DEPLOY-BUCKET/

# Deploy
aws cloudformation deploy \
  --template-file infrastructure/cloudformation.yml \
  --stack-name payment-app-production \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides Environment=production LambdaCodeBucket=YOUR-BUCKET ...
```

## Architecture

### Payment Flow (`PaymentProcessor.processPayment`)
1. Validate idempotency key (must be UUID v4)
2. **DynamoDB `GetItem` on `IdempotencyCacheTable`** — return cached response immediately if found
3. Validate payload (amount, currency, token, customerId, orderId)
4. Fraud checks: velocity (`QueryCommand` on `customerId-createdAt-index`, >5 in 5 min = blocked) and anomaly (>10x 90-day average = logged only)
5. Charge via `stripe.charges.create`
6. **DynamoDB `PutItem` on `TransactionsTable`** with `attribute_not_exists` condition (immutable write)
7. **DynamoDB `PutItem` on `IdempotencyCacheTable`** with 24h TTL

### DynamoDB Tables
| Table | PK | SK | TTL | Notes |
|-------|----|----|-----|-------|
| `payment-idempotency-cache-{env}` | `idempotencyKey` | — | 24h | Blocks double charges |
| `payment-transactions-{env}` | `transactionId` | — | — | Immutable audit trail; GSI on `customerId+createdAt` for fraud checks |
| `payment-logs-{env}` | `idempotencyKey` | `timestamp` | 90d | Event log per payment step |

### Lambda Entry Point
`lambda.js` wraps the Express app with `serverless-http`. The same Express app runs locally via `index.js`. No code change needed between environments.

### Environment Variables (Lambda auto-injects from CloudFormation)
- `IDEMPOTENCY_CACHE_TABLE`, `TRANSACTIONS_TABLE`, `PAYMENT_LOGS_TABLE` — table names
- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` — resolved from Secrets Manager at deploy time
- `DYNAMODB_ENDPOINT` — set to `http://localhost:8000` for local dev with DynamoDB Local; omit for AWS

### Idempotency Key Lifecycle (Client-side)
- UUID v4 generated on first "Pay" click, stored in `localStorage` under `payment_<orderId>` (1h TTL)
- Reused on every retry → server cache hit → no double charge
- Cleared on success or non-retryable failure

## Key Invariants
- **Raw card data never reaches the server** — `validatePayload` rejects 16-digit tokens starting with `4`. Card data tokenized client-side via Stripe Elements.
- **Amounts are always in cents** — $99.99 → `9999`.
- **DynamoDB TTL handles cache expiry** — `idempotency_cache` expires after 24h, logs after 90 days. No cleanup jobs needed.
- **`DeletionPolicy: Retain`** on all DynamoDB tables — deleting the CloudFormation stack does NOT delete transaction data.
- The `simpleHash` in `public/js/payment-handler.js` is a placeholder — replace with `crypto.subtle` for production cart checksums.

## Stripe Test Cards
```
Success:  4242 4242 4242 4242
Decline:  4000 0000 0000 0002
No funds: 4000 0000 0000 9995
Expiry: any future date, CVC: any 3 digits
```
