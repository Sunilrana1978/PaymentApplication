# CI/CD Pipeline Setup

## Overview

```
Pull Request ──► CI workflow (audit + validate template)
                       │
                       ▼ (merge to main)
              Deploy workflow
                       │
              ┌────────┼────────┐
              ▼        ▼        ▼
           Package  Upload   Deploy
           (ZIP)    (S3)   (CloudFormation)
                               │
                               ▼
                        Smoke tests
                    (health + payment endpoint)
```

**Workflows:**
| File | Trigger | What it does |
|------|---------|-------------|
| `.github/workflows/ci.yml` | Every PR and push | `npm audit`, CloudFormation template validation |
| `.github/workflows/deploy.yml` | Push to `main` or manual | Package Lambda, upload to S3, deploy stack, smoke test |

Authentication uses **GitHub OIDC** — no long-lived AWS access keys stored in GitHub.

---

## Step 1 — Create the S3 Deployment Bucket

```bash
export AWS_REGION=us-east-1
export DEPLOY_BUCKET=payment-app-lambda-deploys-$(aws sts get-caller-identity --query Account --output text)

aws s3 mb s3://$DEPLOY_BUCKET --region $AWS_REGION
echo "Bucket: $DEPLOY_BUCKET"
```

---

## Step 2 — Set Up GitHub OIDC (one-time)

This deploys an IAM role that GitHub Actions assumes via short-lived tokens — no AWS access keys required.

```bash
aws cloudformation deploy \
  --template-file infrastructure/github-oidc.yml \
  --stack-name payment-app-github-oidc \
  --region $AWS_REGION \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    GitHubOrg=Sunilrana1978 \
    GitHubRepo=PaymentApplication \
    DeployBucketName=$DEPLOY_BUCKET
```

Get the IAM role ARN:
```bash
aws cloudformation describe-stacks \
  --stack-name payment-app-github-oidc \
  --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" \
  --output text
```

---

## Step 3 — Add GitHub Secrets and Variables

Go to **GitHub → Repository → Settings → Secrets and variables → Actions**.

**Secrets** (encrypted, never shown in logs):

| Secret | Value |
|--------|-------|
| `AWS_ROLE_ARN` | ARN from Step 2 (e.g. `arn:aws:iam::123456789012:role/github-actions-payment-app`) |
| `LAMBDA_DEPLOY_BUCKET` | S3 bucket name from Step 1 |
| `STRIPE_SECRET_KEY` | `sk_live_...` |
| `STRIPE_PUBLISHABLE_KEY` | `pk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` |
| `ALLOWED_ORIGINS` | `https://yourdomain.com` |

**Variables** (non-sensitive, visible in logs):

| Variable | Value |
|----------|-------|
| `AWS_REGION` | `us-east-1` |

---

## Step 4 — Configure GitHub Environment (Optional but Recommended)

GitHub Environments let you add **manual approval gates** before production deploys.

1. Go to **Settings → Environments → New environment**
2. Create an environment named `production`
3. Under **Protection rules**, enable **Required reviewers** and add yourself
4. The deploy workflow will pause and wait for approval before deploying to production

For `staging`, create a second environment with no protection rules (auto-deploys on merge).

---

## How the Pipeline Works

### CI (`ci.yml`) — runs on every PR

```
Checkout
   ├─► npm ci
   │      └─► npm audit --audit-level=high
   │              (fails if high/critical vulnerabilities found)
   │
   └─► Configure AWS via OIDC
          └─► aws cloudformation validate-template
                  (catches YAML syntax and resource errors early)
```

### Deploy (`deploy.yml`) — runs on merge to `main`

```
Checkout
   │
   ▼
npm ci --only=production
   │
   ▼
zip -r payment-app.zip .   (excludes docs, infrastructure, public, .env)
   │
   ▼
aws s3 cp payment-app-{sha}.zip s3://DEPLOY_BUCKET/
   │
   ▼
aws cloudformation deploy   (creates or updates the stack)
   │
   ▼
Smoke tests
   ├─► GET /health → expect HTTP 200
   └─► POST /api/v1/payments/create → expect valid response
   │
   ▼
GitHub Step Summary (endpoint URL, commit SHA, stack name)
```

Each Lambda ZIP is named with the commit SHA (`payment-app-abc1234.zip`) so you can roll back by redeploying an older CloudFormation revision pointing to the previous SHA.

---

## Manual Deploy (Workflow Dispatch)

You can deploy to a specific environment without merging to `main`:

1. Go to **GitHub → Actions → Deploy**
2. Click **Run workflow**
3. Select `staging` or `production`
4. Click **Run workflow**

This is useful for hotfixes or deploying to staging before merging.

---

## Rolling Back

To roll back to a previous deployment, find the commit SHA from the GitHub Actions run you want to restore and re-deploy with that package:

```bash
export OLD_SHA=abc1234def567

aws lambda update-function-code \
  --function-name payment-app-production \
  --s3-bucket $DEPLOY_BUCKET \
  --s3-key payment-app-$OLD_SHA.zip \
  --region $AWS_REGION

aws lambda wait function-updated \
  --function-name payment-app-production
```

---

## Monitoring the Pipeline

- **CI failures**: Check the PR — the `audit` or `validate-template` job will show what failed
- **Deploy failures**: Check the CloudFormation events in the AWS console or:
  ```bash
  aws cloudformation describe-stack-events \
    --stack-name payment-app-production \
    --query 'StackEvents[?ResourceStatus==`CREATE_FAILED` || ResourceStatus==`UPDATE_FAILED`]'
  ```
- **Smoke test failures**: The Lambda logs will show the error:
  ```bash
  aws logs tail /aws/lambda/payment-app-production --follow
  ```
