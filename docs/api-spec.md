# Secure Idempotent Payment API Specification

## Overview
This specification defines a secure, idempotent payment API that prevents duplicate charges, protects sensitive user data, and handles network failures gracefully.

## 1. Security Principles

### Never Expose Sensitive Data
- NO card numbers (full or partial) in payloads
- NO SSNs, dates of birth, or PII
- NO plain-text sensitive data transmitted over the network
- Use tokenization: client tokenizes card → server uses token

### Payment Flow
```
User Card Data → Client-Side Tokenization → Reusable Token
Token + Amount + Order → API Payload → Payment Service
```

## 2. API Payload Format (Request)

```json
{
  "idempotencyKey": "550e8400-e29b-41d4-a716-446655440000",
  "paymentMethod": {
    "type": "card_token",
    "token": "tok_live_4eC39HqLyjWDarh5vA22..."
  },
  "transaction": {
    "amount": 9999,
    "currency": "USD",
    "orderId": "ORD-20240615-12345"
  },
  "customer": {
    "customerId": "cust_abc123xyz",
    "email": "customer@example.com",
    "billingAddress": {
      "zip": "97201",
      "country": "US"
    }
  },
  "metadata": {
    "cartChecksum": "sha256_hash_of_cart_items",
    "userAgent": "Mozilla/5.0...",
    "timestamp": "2024-06-15T10:30:45Z"
  }
}
```

### Field Descriptions

#### idempotencyKey (REQUIRED)
- Format: UUID v4
- Client generates once per payment attempt
- Used to deduplicate requests
- Stored in localStorage/sessionStorage with TTL
- Example: `550e8400-e29b-41d4-a716-446655440000`

#### paymentMethod (REQUIRED)
- **type**: Always `card_token` or `wallet_token` (never raw card data)
- **token**: Secure token from payment tokenizer (Stripe, Square, etc.)
- NEVER send card number, CVV, or expiry in request

#### transaction (REQUIRED)
- **amount**: Integer (cents/smallest currency unit). $99.99 = 9999
- **currency**: ISO 4217 code (USD, EUR, GBP)
- **orderId**: Unique order identifier (for reconciliation)

#### customer (REQUIRED)
- **customerId**: Hashed or non-sensitive customer ID
- **email**: For receipt/notifications (validation occurs server-side)
- **billingAddress**: Only ZIP + country (enough for AVS validation)

#### metadata (OPTIONAL but RECOMMENDED)
- **cartChecksum**: SHA256 hash of cart contents (prevents manipulation)
- **userAgent**: Browser user agent (fraud detection)
- **timestamp**: ISO 8601 client-side timestamp (for sequencing)

---

## 3. API Payload Format (Response - Success)

```json
{
  "status": "success",
  "transactionId": "txn_1234567890abcdef",
  "idempotencyKey": "550e8400-e29b-41d4-a716-446655440000",
  "amount": 9999,
  "currency": "USD",
  "orderId": "ORD-20240615-12345",
  "timestamp": "2024-06-15T10:30:50Z",
  "receipt": {
    "receiptUrl": "https://receipts.payment.com/txn_1234567890abcdef",
    "receiptId": "RCPT_12345"
  }
}
```

---

## 4. API Payload Format (Response - Error)

```json
{
  "status": "error",
  "error": {
    "code": "insufficient_funds",
    "message": "Card has insufficient funds",
    "type": "card_error"
  },
  "idempotencyKey": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2024-06-15T10:30:50Z",
  "retryable": true,
  "retryAfter": 5
}
```

### Error Codes

| Code | Type | Retryable | Action |
|------|------|-----------|--------|
| `insufficient_funds` | card_error | Yes | Show error, suggest retry |
| `card_declined` | card_error | No | Card rejected, try different card |
| `invalid_token` | validation_error | No | Invalid/expired token, resubmit |
| `duplicate_transaction` | idempotency | No | Already processed (return cached) |
| `rate_limit` | server_error | Yes | Wait 30s and retry |
| `timeout` | network_error | Yes | Connection timeout, retry |
| `invalid_amount` | validation_error | No | Amount validation failed |

---

## 5. Idempotency Mechanism

### How It Works

1. **Client generates idempotencyKey** (UUID) when user clicks "Pay"
2. **Store key + amount + orderId** in client-side storage
3. **Send request** to server with idempotencyKey in header/body
4. **Server checks cache** before processing:
   - If key exists → return cached response immediately
   - If key doesn't exist → process payment, cache result
5. **Duplicate request** (same key) → instant response, no double charge

### Database Schema for Idempotency Cache

```sql
CREATE TABLE idempotency_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key VARCHAR(36) NOT NULL UNIQUE,
  customer_id VARCHAR(255) NOT NULL,
  order_id VARCHAR(255) NOT NULL,
  request_payload JSONB NOT NULL,
  response_payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL,  -- 'pending', 'completed', 'failed'
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours',
  
  INDEX idx_idempotency_key (idempotency_key),
  INDEX idx_customer_order (customer_id, order_id),
  INDEX idx_expires (expires_at)
);

-- Example inserts:
INSERT INTO idempotency_cache 
  (idempotency_key, customer_id, order_id, request_payload, response_payload, status)
VALUES 
  ('550e8400-e29b-41d4-a716-446655440000', 'cust_abc123', 'ORD-20240615-12345',
   '{"amount": 9999, "currency": "USD", ...}'::jsonb,
   '{"transactionId": "txn_1234567890abcdef", "status": "success", ...}'::jsonb,
   'completed');
```

### TTL Strategy
- Cache entries expire after **24 hours**
- Daily cleanup job removes expired records
- Prevents memory bloat while maintaining 24h window for retries

---

## 6. HTTP Headers

```
POST /api/v1/payments/create

Headers:
  Content-Type: application/json
  Authorization: Bearer <api-key>
  X-Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
  X-Request-Id: req_abc123def456  (for tracing)
  User-Agent: <client user agent>
```

---

## 7. Security Considerations

### Data in Transit
- Use HTTPS/TLS 1.2+ (mandatory)
- Encrypt entire payload (TLS handles this)
- No sensitive data in query parameters or logs

### Data at Rest
- Hash card tokens in cache (only compare hashes)
- Encrypt sensitive fields in idempotency_cache JSONB
- Separate transaction ledger from cache (for compliance)

### PCI-DSS Compliance
- Never handle raw card data
- Use PCI-compliant tokenizer (Stripe, Square, etc.)
- Only store tokenized values

### Rate Limiting
- Limit to 5 payment requests per customer per minute
- Prevent brute-force attacks
- Return `429 Too Many Requests` + backoff time

### Fraud Detection Signals
- Detect rapid duplicate requests (same key, milliseconds apart)
- Verify cart checksum hasn't changed
- Validate billing address vs card issuer

---

## 8. Client-Side Implementation Pattern

```javascript
class PaymentHandler {
  constructor() {
    this.tokenizer = new CardTokenizer();  // Stripe, Square, etc.
    this.storage = new RequestCache();      // localStorage wrapper
  }

  async submitPayment(cart, cardElement) {
    // Step 1: Generate/retrieve idempotency key
    const idempotencyKey = this.getOrCreateIdempotencyKey(cart.orderId);
    
    // Step 2: Tokenize card (no raw card data)
    const token = await this.tokenizer.createToken(cardElement);
    
    // Step 3: Build secure payload
    const payload = this.buildPayload(cart, token, idempotencyKey);
    
    // Step 4: Send to payment API
    const response = await this.sendPayment(payload, idempotencyKey);
    
    // Step 5: Handle response
    return this.handlePaymentResponse(response, idempotencyKey);
  }

  getOrCreateIdempotencyKey(orderId) {
    const key = this.storage.get(`payment_${orderId}`);
    if (key && !this.storage.isExpired(key)) {
      return key.value;  // Reuse existing key (for retries)
    }
    
    const newKey = this.generateUUID();
    this.storage.set(`payment_${orderId}`, newKey, 3600);  // 1 hour TTL
    return newKey;
  }

  buildPayload(cart, token, idempotencyKey) {
    return {
      idempotencyKey,
      paymentMethod: { type: 'card_token', token: token.id },
      transaction: {
        amount: cart.totalCents,
        currency: 'USD',
        orderId: cart.orderId
      },
      customer: {
        customerId: cart.customerId,
        email: cart.email,
        billingAddress: { zip: cart.zipCode, country: 'US' }
      },
      metadata: {
        cartChecksum: this.hashCart(cart),
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString()
      }
    };
  }

  async sendPayment(payload, idempotencyKey) {
    try {
      const response = await fetch('/api/v1/payments/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok && response.status !== 400 && response.status !== 429) {
        throw new Error(`Network error: ${response.status}`);
      }

      return await response.json();
    } catch (err) {
      return { status: 'error', error: { code: 'network_error', retryable: true } };
    }
  }

  handlePaymentResponse(response, idempotencyKey) {
    if (response.status === 'success') {
      this.storage.delete(`payment_${response.orderId}`);  // Clear on success
      return { success: true, transactionId: response.transactionId };
    } else {
      if (response.retryable) {
        // Keep idempotencyKey in storage for retry
        return { success: false, retryable: true, error: response.error.message };
      } else {
        this.storage.delete(`payment_${response.orderId}`);  // Clear on non-retryable error
        return { success: false, retryable: false, error: response.error.message };
      }
    }
  }
}
```

---

## 9. Server-Side Implementation Pattern

```javascript
class PaymentProcessor {
  async handlePayment(req) {
    const { idempotencyKey, ...payload } = req.body;

    // Step 1: Validate idempotency key format
    if (!this.isValidUUID(idempotencyKey)) {
      return this.error(400, 'invalid_idempotency_key');
    }

    // Step 2: Check cache (FIRST!)
    const cached = await this.db.query(
      'SELECT response_payload, status FROM idempotency_cache WHERE idempotency_key = $1',
      [idempotencyKey]
    );

    if (cached.rows.length > 0) {
      // Return cached response
      const { response_payload, status } = cached.rows[0];
      return { cached: true, ...JSON.parse(response_payload) };
    }

    // Step 3: Validate request
    const validation = this.validatePayload(payload);
    if (!validation.valid) {
      return await this.cacheError(idempotencyKey, payload, validation.error);
    }

    // Step 4: Process payment
    let transactionResult;
    try {
      transactionResult = await this.chargeCard(payload);
    } catch (err) {
      return await this.cacheError(idempotencyKey, payload, 
        { code: 'payment_failed', message: err.message });
    }

    // Step 5: Create transaction record
    const transaction = await this.db.query(
      'INSERT INTO transactions (transaction_id, order_id, amount, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [transactionResult.id, payload.transaction.orderId, payload.transaction.amount, 'completed']
    );

    // Step 6: Cache success response
    const response = {
      status: 'success',
      transactionId: transactionResult.id,
      idempotencyKey,
      amount: payload.transaction.amount,
      currency: payload.transaction.currency,
      orderId: payload.transaction.orderId,
      timestamp: new Date().toISOString(),
      receipt: { receiptId: transactionResult.receiptId }
    };

    await this.db.query(
      'INSERT INTO idempotency_cache (idempotency_key, customer_id, order_id, request_payload, response_payload, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [idempotencyKey, payload.customer.customerId, payload.transaction.orderId, JSON.stringify(payload), JSON.stringify(response), 'completed']
    );

    return response;
  }

  async cacheError(idempotencyKey, payload, error) {
    const response = {
      status: 'error',
      error,
      idempotencyKey,
      timestamp: new Date().toISOString(),
      retryable: ['insufficient_funds', 'timeout', 'rate_limit'].includes(error.code)
    };

    await this.db.query(
      'INSERT INTO idempotency_cache (idempotency_key, customer_id, order_id, request_payload, response_payload, status) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
      [idempotencyKey, payload.customer.customerId, payload.transaction.orderId, JSON.stringify(payload), JSON.stringify(response), 'failed']
    );

    return response;
  }

  validatePayload(payload) {
    // Validate required fields
    if (!payload.transaction.amount || payload.transaction.amount <= 0) {
      return { valid: false, error: { code: 'invalid_amount', message: 'Amount must be positive' } };
    }
    if (!payload.paymentMethod.token) {
      return { valid: false, error: { code: 'invalid_token', message: 'Payment token required' } };
    }
    return { valid: true };
  }

  async chargeCard(payload) {
    // Call payment processor (Stripe, Square, etc.)
    const result = await stripeClient.charges.create({
      amount: payload.transaction.amount,
      currency: payload.transaction.currency,
      source: payload.paymentMethod.token,
      description: `Order ${payload.transaction.orderId}`
    });
    return result;
  }
}
```

---

## 10. Retry Strategy

### Client-Side Retry Logic

```javascript
async function paymentWithRetry(cart, cardElement, maxRetries = 3) {
  const handler = new PaymentHandler();
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await handler.submitPayment(cart, cardElement);
    
    if (result.success) {
      return result;  // Success
    }
    
    if (!result.retryable) {
      throw new Error(`Payment failed: ${result.error}`);  // Non-retryable, stop
    }
    
    if (attempt < maxRetries) {
      const delay = Math.pow(2, attempt) * 1000;  // Exponential backoff: 2s, 4s, 8s
      await new Promise(r => setTimeout(r, delay));
    }
  }
  
  throw new Error('Payment failed after max retries');
}
```

---

## 11. Testing Scenarios

### Scenario 1: Happy Path
1. User clicks "Pay" → idempotencyKey generated
2. Request sent → processed → cached
3. Response received → order completed
4. User sees success message

### Scenario 2: Double-Click
1. User clicks "Pay" → request #1 sent
2. User clicks "Pay" again before response → request #2 sent
3. Server: request #1 processes, cached
4. Server: request #2 arrives, cache hit, returns cached response
5. Result: Only ONE charge, user sees consistent response

### Scenario 3: Network Timeout
1. User clicks "Pay" → request sent
2. Network timeout (payment processed, but no response)
3. User clicks "Pay" again → sends same idempotencyKey
4. Server: cache hit, returns previous response
5. Result: No double charge, user recovers

### Scenario 4: Page Refresh
1. User clicks "Pay" → request sent
2. Page refreshes before response
3. User clicks "Pay" again → same idempotencyKey (from localStorage)
4. Server: cache hit, returns previous response
5. Result: Idempotent, safe retry

---

## 12. Monitoring & Alerts

### Metrics to Track
- Cache hit rate (high = good, means deduplication working)
- Duplicate requests detected per minute
- Time to process payment (should be <2s)
- Failed payments by error code
- Idempotency cache size (alert if > 10GB)

### Alerts
- Alert if > 10% of requests are duplicates (may indicate client issue)
- Alert if cache lookup > 100ms (database performance)
- Alert if response caching fails (audit trail protection)

---

## Summary

This specification ensures:
✓ **Security**: No sensitive data exposed, tokenized payments only
✓ **Idempotency**: Duplicate requests safely handled
✓ **Reliability**: Network failures don't cause double charges
✓ **Compliance**: PCI-DSS aligned, audit trail maintained
