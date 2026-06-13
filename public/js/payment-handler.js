// ============================================================================
// CLIENT-SIDE PAYMENT HANDLER (Browser JavaScript)
// ============================================================================
// This implementation demonstrates:
// 1. Secure card tokenization (via Stripe)
// 2. Idempotency key generation and management
// 3. Retry logic with exponential backoff
// 4. Local storage of payment state
// 5. User feedback and error handling

// ============================================================================
// REQUEST CACHE (Local Storage Wrapper)
// ============================================================================

class RequestCache {
  constructor(storageKey = 'payment_cache') {
    this.storageKey = storageKey;
    this.storage = window.localStorage;
  }

  /**
   * Store idempotency key for a specific order
   * Keep it in memory even after success to prevent double-processing
   */
  set(orderId, idempotencyKey, ttlSeconds = 3600) {
    const entry = {
      key: idempotencyKey,
      created: Date.now(),
      ttl: ttlSeconds * 1000,
      order: orderId
    };

    const cache = this.getAll();
    cache[orderId] = entry;
    this.storage.setItem(this.storageKey, JSON.stringify(cache));
  }

  /**
   * Retrieve stored idempotency key for an order
   */
  get(orderId) {
    const cache = this.getAll();
    const entry = cache[orderId];

    if (!entry) return null;

    // Check if expired
    if (Date.now() - entry.created > entry.ttl) {
      delete cache[orderId];
      this.storage.setItem(this.storageKey, JSON.stringify(cache));
      return null;
    }

    return entry.key;
  }

  /**
   * Check if an entry is expired
   */
  isExpired(orderId) {
    const cache = this.getAll();
    const entry = cache[orderId];

    if (!entry) return true;
    return Date.now() - entry.created > entry.ttl;
  }

  /**
   * Clear an order's cache after successful payment
   */
  delete(orderId) {
    const cache = this.getAll();
    delete cache[orderId];
    this.storage.setItem(this.storageKey, JSON.stringify(cache));
  }

  /**
   * Get all cached entries
   */
  getAll() {
    try {
      return JSON.parse(this.storage.getItem(this.storageKey) || '{}');
    } catch {
      return {};
    }
  }
}

// ============================================================================
// PAYMENT HANDLER
// ============================================================================

class SecurePaymentHandler {
  constructor(options = {}) {
    // Initialize Stripe
    this.stripe = Stripe(options.stripePublishableKey || process.env.REACT_APP_STRIPE_PUBLIC_KEY);
    this.elements = this.stripe.elements();
    this.cardElement = this.elements.create('card');

    // API configuration
    this.apiEndpoint = options.apiEndpoint || '/api/v1/payments/create';
    this.apiKey = options.apiKey || localStorage.getItem('api_key');

    // Request cache
    this.cache = new RequestCache();

    // UI elements
    this.cardContainer = options.cardContainer || '#card-element';
    this.submitButton = options.submitButton || '#pay-button';
    this.messageContainer = options.messageContainer || '#payment-message';

    this.setupUI();
  }

  /**
   * Mount Stripe card element to the page
   */
  setupUI() {
    const container = document.querySelector(this.cardContainer);
    if (container) {
      this.cardElement.mount(container);

      // Handle real-time validation errors
      this.cardElement.addEventListener('change', (e) => {
        const displayError = document.getElementById('card-errors');
        if (e.error) {
          displayError.textContent = e.error.message;
        } else {
          displayError.textContent = '';
        }
      });
    }

    // Setup submit button
    const button = document.querySelector(this.submitButton);
    if (button) {
      button.addEventListener('click', (e) => {
        e.preventDefault();
        this.handlePaymentSubmit();
      });
    }
  }

  /**
   * Main payment submission handler
   */
  async handlePaymentSubmit() {
    const button = document.querySelector(this.submitButton);
    const messageDiv = document.querySelector(this.messageContainer);

    try {
      // Disable button during processing
      this.setButtonState(button, 'processing', true);
      this.showMessage(messageDiv, 'Processing payment...', 'info');

      // Get cart data from page
      const cartData = this.getCartData();

      // Submit payment with retry logic
      const result = await this.submitPaymentWithRetry(cartData);

      if (result.success) {
        this.showMessage(messageDiv, 
          `✓ Payment successful! Transaction ID: ${result.transactionId}`, 
          'success'
        );
        this.setButtonState(button, 'success', false);
        
        // Redirect to confirmation page after 2 seconds
        setTimeout(() => {
          window.location.href = `/order-confirmation?transactionId=${result.transactionId}`;
        }, 2000);
      } else {
        if (result.retryable) {
          this.showMessage(messageDiv, 
            `✗ ${result.error} (Will retry automatically)`, 
            'error'
          );
        } else {
          this.showMessage(messageDiv, 
            `✗ Payment failed: ${result.error}. Please try a different payment method.`, 
            'error'
          );
        }
        this.setButtonState(button, 'error', false);
      }

    } catch (err) {
      console.error('Payment submission error:', err);
      this.showMessage(messageDiv, 
        `An unexpected error occurred: ${err.message}`, 
        'error'
      );
      this.setButtonState(button, 'error', false);
    }
  }

  /**
   * Submit payment with exponential backoff retry
   */
  async submitPaymentWithRetry(cartData, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`Payment attempt ${attempt} of ${maxRetries}`);

      const result = await this.submitPayment(cartData);

      // Success
      if (result.success) {
        return result;
      }

      // Non-retryable error
      if (!result.retryable) {
        return result;
      }

      // Last attempt - return error
      if (attempt === maxRetries) {
        return result;
      }

      // Exponential backoff: 2s, 4s, 8s
      const delayMs = Math.pow(2, attempt) * 1000;
      console.log(`Retrying in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  /**
   * Core payment submission logic
   */
  async submitPayment(cartData) {
    const orderId = cartData.orderId;

    try {
      // STEP 1: Get or create idempotency key
      const idempotencyKey = this.getOrCreateIdempotencyKey(orderId);
      console.log(`Using idempotency key: ${idempotencyKey}`);

      // STEP 2: Tokenize card (no raw card data sent to server)
      const tokenResult = await this.stripe.createToken(this.cardElement);

      if (tokenResult.error) {
        return {
          success: false,
          retryable: false,
          error: tokenResult.error.message
        };
      }

      const cardToken = tokenResult.token;

      // STEP 3: Prepare payload (never includes card data)
      const payload = this.buildPayload(cartData, cardToken, idempotencyKey);

      // STEP 4: Send to payment API
      const response = await this.sendPaymentRequest(payload, idempotencyKey);

      // STEP 5: Handle response
      if (response.status === 'success') {
        // Clear from cache on success
        this.cache.delete(orderId);

        return {
          success: true,
          transactionId: response.transactionId,
          error: null,
          retryable: false
        };
      } else {
        // Error response
        return {
          success: false,
          transactionId: null,
          error: response.error.message,
          retryable: response.retryable !== false
        };
      }

    } catch (err) {
      console.error('Payment submission error:', err);

      // Network errors are retryable
      return {
        success: false,
        transactionId: null,
        error: err.message,
        retryable: true
      };
    }
  }

  /**
   * Get or create idempotency key
   * This is critical for handling retries and duplicate requests
   */
  getOrCreateIdempotencyKey(orderId) {
    // Try to get existing key from cache
    const cachedKey = this.cache.get(orderId);

    if (cachedKey && !this.cache.isExpired(orderId)) {
      console.log('Reusing cached idempotency key');
      return cachedKey;
    }

    // Generate new UUID
    const newKey = this.generateUUID();

    // Store in cache (1 hour TTL)
    this.cache.set(orderId, newKey, 3600);

    console.log('Generated new idempotency key');
    return newKey;
  }

  /**
   * Build secure payment payload
   * Contains NO sensitive data (card details handled by Stripe)
   */
  buildPayload(cartData, cardToken, idempotencyKey) {
    // Compute cart checksum (integrity check)
    const cartChecksum = this.computeCartChecksum(cartData);

    return {
      idempotencyKey,
      paymentMethod: {
        type: 'card_token',
        token: cardToken.id  // Stripe token, not card number
      },
      transaction: {
        amount: cartData.totalCents,  // Always in smallest unit (cents)
        currency: 'USD',
        orderId: cartData.orderId
      },
      customer: {
        customerId: cartData.customerId,
        email: cartData.email,
        billingAddress: {
          zip: cartData.billingZip,
          country: 'US'
        }
      },
      metadata: {
        cartChecksum,
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString()
      }
    };
  }

  /**
   * Send payment request to server
   */
  async sendPaymentRequest(payload, idempotencyKey) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
      const response = await fetch(this.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Idempotency-Key': idempotencyKey,
          'X-Request-ID': this.generateUUID()
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok && response.status !== 400) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();

    } catch (err) {
      clearTimeout(timeoutId);

      if (err.name === 'AbortError') {
        throw new Error('Request timeout - payment may still be processing');
      }

      throw err;
    }
  }

  /**
   * Compute SHA256 hash of cart contents
   * Prevents cart tampering between checkout and payment
   */
  computeCartChecksum(cartData) {
    const cartString = JSON.stringify({
      items: cartData.items.map(item => ({
        id: item.id,
        quantity: item.quantity,
        price: item.price
      })),
      total: cartData.totalCents
    });

    // Simple hash function (in production use crypto.subtle)
    return this.simpleHash(cartString);
  }

  /**
   * Simple hash for demo (use crypto.subtle for production)
   */
  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Generate UUID v4
   */
  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Get cart data from page
   * Assumes cart data is in a global variable or data attribute
   */
  getCartData() {
    // Example: Get from window.CART_DATA or data attribute
    const cartElement = document.querySelector('[data-cart-json]');
    
    if (cartElement) {
      return JSON.parse(cartElement.getAttribute('data-cart-json'));
    }

    // Fallback to window variable
    if (window.CART_DATA) {
      return window.CART_DATA;
    }

    throw new Error('Cart data not found on page');
  }

  /**
   * UI Helpers
   */
  setButtonState(button, state, disabled) {
    button.disabled = disabled;

    switch (state) {
      case 'processing':
        button.classList.remove('error', 'success');
        button.classList.add('processing');
        button.textContent = 'Processing...';
        break;
      case 'success':
        button.classList.remove('processing', 'error');
        button.classList.add('success');
        button.textContent = '✓ Payment Complete';
        break;
      case 'error':
        button.classList.remove('processing', 'success');
        button.classList.add('error');
        button.textContent = 'Try Again';
        break;
      default:
        button.classList.remove('processing', 'success', 'error');
        button.textContent = 'Pay Now';
    }
  }

  showMessage(container, message, type) {
    if (!container) return;

    container.textContent = message;
    container.className = `payment-message ${type}`;
    container.style.display = 'block';
  }

  /**
   * Cleanup
   */
  destroy() {
    this.cardElement.unmount();
  }
}

// ============================================================================
// USAGE EXAMPLE (HTML + Script)
// ============================================================================

/*
<!-- In your HTML -->
<form id="payment-form">
  <input type="hidden" id="cart-data" data-cart-json='{"orderId":"ORD-12345","customerId":"cust_abc","email":"user@example.com","billingZip":"97201","totalCents":9999,"items":[{"id":"PROD-1","quantity":2,"price":4999}]}'>
  
  <div id="card-element"></div>
  <div id="card-errors" role="alert"></div>
  
  <button id="pay-button" type="button">Pay $99.99</button>
  <div id="payment-message"></div>
</form>

<script src="https://js.stripe.com/v3/"></script>
<script src="payment-handler-client.js"></script>

<script>
  const handler = new SecurePaymentHandler({
    stripePublishableKey: 'pk_test_...',
    apiEndpoint: '/api/v1/payments/create',
    cardContainer: '#card-element',
    submitButton: '#pay-button',
    messageContainer: '#payment-message'
  });
</script>
*/

// ============================================================================
// ADVANCED: Detect Duplicate Submissions
// ============================================================================

class DuplicateSubmissionDetector {
  constructor(debounceMs = 1000) {
    this.lastSubmitTime = 0;
    this.debounceMs = debounceMs;
    this.pendingRequest = null;
  }

  canSubmit() {
    const now = Date.now();
    if (now - this.lastSubmitTime < this.debounceMs) {
      console.warn('Duplicate submission detected - ignoring');
      return false;
    }
    this.lastSubmitTime = now;
    return true;
  }
}

// ============================================================================
// EXPORT
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SecurePaymentHandler, RequestCache };
}
