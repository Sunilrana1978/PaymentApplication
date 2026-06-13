# AWS Deployment Guide

## Architecture

```
Browser / Client
       │
       ▼ HTTPS
┌─────────────────────┐
│  API Gateway        │  HTTP API (pay-per-request, built-in CORS)
│  (HTTP API v2)      │
└──────────┬──────────┘
           │ AWS_PROXY
           ▼
┌─────────────────────┐
│  AWS Lambda         │  Node.js 18 · 512 MB · 30s timeout
│  payment-app        │  (Express wrapped with serverless-http)
└──────────┬──────────┘
           │
    ┌──────┴──────┐
    ▼             ▼
┌────────┐  ┌──────────────┐
│DynamoDB│  │Secrets Manager│
│Tables  │  │Stripe keys    │
└────────┘  └──────────────┘
```

**AWS services:**
| Service | Purpose |
|---------|---------|
| API Gateway HTTP API | HTTPS endpoint, CORS, throttling |
| Lambda (Node.js 18) | Payment processing logic |
| DynamoDB | Idempotency cache, transactions, logs |
| Secrets Manager | Stripe API keys |
| CloudWatch Logs | Application logs (30-day retention) |

**DynamoDB tables:**
| Table | Key | TTL | Purpose |
|-------|-----|-----|---------|
| `payment-idempotency-cache-{env}` | `idempotencyKey` | 24h | Deduplication |
| `payment-transactions-{env}` | `transactionId` | — | Audit trail |
| `payment-logs-{env}` | `idempotencyKey` + `timestamp` | 90d | Event log |

> **No VPC required.** Lambda communicates with DynamoDB and Stripe over AWS managed networking. No NAT Gateway, no subnets, no infrastructure to manage.

---

## Prerequisites

```bash
# AWS CLI v2
aws --version

# Verify credentials
aws sts get-caller-identity

# Node.js 18+
node --version
```

---

## Step 1 — Create S3 Bucket for Lambda Code

```bash
export AWS_REGION=us-east-1
export DEPLOY_BUCKET=my-payment-app-lambda-deploys   # must be globally unique

aws s3 mb s3://$DEPLOY_BUCKET --region $AWS_REGION
```

---

## Step 2 — Package and Upload Lambda Code

```bash
# Install production dependencies only
npm ci --only=production

# Create ZIP (exclude dev files)
zip -r payment-app.zip . \
  --exclude "*.git*" \
  --exclude "*.DS_Store" \
  --exclude "docs/*" \
  --exclude "infrastructure/*" \
  --exclude "*.md" \
  --exclude ".env*" \
  --exclude "docker-compose.yml" \
  --exclude "public/*"

# Upload to S3
aws s3 cp payment-app.zip s3://$DEPLOY_BUCKET/payment-app.zip

# Clean up local zip
rm payment-app.zip
```

---

## Step 3 — Deploy CloudFormation Stack

```bash
aws cloudformation deploy \
  --template-file infrastructure/cloudformation.yml \
  --stack-name payment-app-production \
  --region $AWS_REGION \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    Environment=production \
    LambdaCodeBucket=$DEPLOY_BUCKET \
    LambdaCodeKey=payment-app.zip \
    AllowedOrigins=https://yourdomain.com \
    StripeSecretKey=sk_live_... \
    StripePublishableKey=pk_live_... \
    StripeWebhookSecret=whsec_...
```

> First deployment takes ~3 minutes (DynamoDB table creation). Subsequent deployments are ~30 seconds.

**Get the API endpoint:**
```bash
aws cloudformation describe-stacks \
  --stack-name payment-app-production \
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" \
  --output text
```

This outputs something like:
```
https://abc123def.execute-api.us-east-1.amazonaws.com
```

---

## Step 4 — Verify Deployment

```bash
export API_URL=https://abc123def.execute-api.us-east-1.amazonaws.com

# Health check
curl $API_URL/health
# → {"status":"healthy","service":"payment-processor"}

# Test payment (Stripe test card)
curl -X POST $API_URL/api/v1/payments/create \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{
    "idempotencyKey": "550e8400-e29b-41d4-a716-446655440000",
    "paymentMethod": { "type": "card_token", "token": "tok_visa" },
    "transaction": { "amount": 9999, "currency": "USD", "orderId": "ORD-TEST-001" },
    "customer": {
      "customerId": "cust_test",
      "email": "test@example.com",
      "billingAddress": { "zip": "97201", "country": "US" }
    }
  }'

# Test idempotency — send same request again, expect same response, no double charge
curl -X POST $API_URL/api/v1/payments/create \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{ ...same payload... }'
```

---

## Subsequent Deployments

After code changes, repackage and upload, then update the Lambda:

```bash
# Package and upload
npm ci --only=production
zip -r payment-app.zip . --exclude "*.git*" --exclude "docs/*" --exclude "infrastructure/*" --exclude "*.md" --exclude ".env*" --exclude "docker-compose.yml" --exclude "public/*"
aws s3 cp payment-app.zip s3://$DEPLOY_BUCKET/payment-app.zip
rm payment-app.zip

# Update Lambda code directly (faster than full CloudFormation deploy)
aws lambda update-function-code \
  --function-name payment-app-production \
  --s3-bucket $DEPLOY_BUCKET \
  --s3-key payment-app.zip \
  --region $AWS_REGION

# Wait for update to complete
aws lambda wait function-updated \
  --function-name payment-app-production \
  --region $AWS_REGION
```

For infrastructure changes (new env vars, memory, timeout), run `aws cloudformation deploy` again instead.

---

## Local Development

Run the full stack locally with DynamoDB Local:

```bash
# Copy env example and fill in your Stripe test keys
cp .env.example .env

# Start app + DynamoDB Local + DynamoDB Admin UI
docker-compose up

# App:            http://localhost:3000
# DynamoDB Admin: http://localhost:8001  (browse tables visually)
```

**Create local DynamoDB tables** (one-time, after `docker-compose up`):

```bash
AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
aws dynamodb create-table \
  --table-name payment-idempotency-cache-development \
  --attribute-definitions AttributeName=idempotencyKey,AttributeType=S \
  --key-schema AttributeName=idempotencyKey,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --endpoint-url http://localhost:8000 \
  --region us-east-1

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
  --endpoint-url http://localhost:8000 \
  --region us-east-1

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
  --endpoint-url http://localhost:8000 \
  --region us-east-1
```

---

## Monitoring

**View live Lambda logs:**
```bash
aws logs tail /aws/lambda/payment-app-production --follow
```

**Check Lambda metrics (last hour):**
```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Errors \
  --dimensions Name=FunctionName,Value=payment-app-production \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 3600 \
  --statistics Sum
```

**Recommended CloudWatch alarms:**

| Metric | Threshold | Alarm |
|--------|-----------|-------|
| Lambda `Errors` | > 5 in 5 min | Alert |
| Lambda `Duration` | > 10s avg | Investigate |
| Lambda `Throttles` | > 0 | Raise concurrency limit |
| API Gateway `5XXError` | > 1% | Alert |

---

## Teardown

```bash
aws cloudformation delete-stack \
  --stack-name payment-app-production \
  --region $AWS_REGION
```

> DynamoDB tables are set to `DeletionPolicy: Retain` — they survive stack deletion to protect transaction data. Delete them manually only when certain:
> ```bash
> aws dynamodb delete-table --table-name payment-transactions-production
> aws dynamodb delete-table --table-name payment-idempotency-cache-production
> aws dynamodb delete-table --table-name payment-logs-production
> ```

---

## Approximate Monthly Cost

| Service | Usage assumption | Cost |
|---------|-----------------|------|
| API Gateway HTTP API | 1M requests | ~$1.00 |
| Lambda | 1M requests × 512 MB × 1s | ~$1.00 |
| DynamoDB | 1M reads + 1M writes | ~$2.50 |
| Secrets Manager | 1 secret | ~$0.40 |
| CloudWatch Logs | 5 GB/month | ~$2.50 |
| **Total** | | **~$7.50/month** |

Scales to near-zero cost in development. No fixed infrastructure cost.
