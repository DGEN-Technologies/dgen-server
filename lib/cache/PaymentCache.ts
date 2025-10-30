import { CacheManager } from './CacheManager';

export class PaymentCache {
  private static instance: PaymentCache;
  private cache: CacheManager;
  private readonly TTL = 300000; // 5 minutes default TTL
  private readonly PAYMENT_PREFIX = 'payment:';
  private readonly USER_PAYMENT_PREFIX = 'user_payment:';

  private constructor() {
    this.cache = CacheManager.getInstance();
  }

  public static getInstance(): PaymentCache {
    if (!PaymentCache.instance) {
      PaymentCache.instance = new PaymentCache();
    }
    return PaymentCache.instance;
  }

  /**
   * Store a payment in cache with multiple access keys
   */
  async storePayment(payment: any, userId?: string): Promise<void> {
    if (!payment) return;

    try {
      // Store by primary ID
      const primaryKey = this.PAYMENT_PREFIX + payment.id;
      await this.cache.set(primaryKey, payment, this.TTL);

      // Store by hash if different from ID
      if (payment.hash && payment.hash !== payment.id) {
        const hashKey = this.PAYMENT_PREFIX + payment.hash;
        await this.cache.set(hashKey, payment, this.TTL);
      }

      // Store by payment hash if available
      if (payment.paymentHash) {
        const paymentHashKey = this.PAYMENT_PREFIX + payment.paymentHash;
        await this.cache.set(paymentHashKey, payment, this.TTL);
      }

      // Store by txId if available
      if (payment.txId) {
        const txIdKey = this.PAYMENT_PREFIX + payment.txId;
        await this.cache.set(txIdKey, payment, this.TTL);
      }

      // Store reference to user's payment if userId provided
      if (userId) {
        const userPaymentKey = `${this.USER_PAYMENT_PREFIX}${userId}:${payment.id}`;
        await this.cache.set(userPaymentKey, payment.id, this.TTL * 2); // Longer TTL for user references
      }

      // Successfully cached payment
    } catch (error) {
      console.error('Failed to cache payment:', error);
    }
  }

  /**
   * Retrieve a payment from cache by any identifier
   */
  async getPayment(identifier: string): Promise<any | null> {
    if (!identifier) return null;

    try {
      // Try direct lookup
      const directKey = this.PAYMENT_PREFIX + identifier;
      const payment = await this.cache.get(directKey);
      
      if (payment) {
        return payment;
      }

      // Try without prefix (in case full key was provided)
      const paymentWithoutPrefix = await this.cache.get(identifier);
      if (paymentWithoutPrefix) {
        return paymentWithoutPrefix;
      }

      return null;
    } catch (error) {
      console.error('Failed to get payment from cache:', error);
      return null;
    }
  }

  /**
   * Store multiple payments at once (from list operations)
   */
  async storePayments(payments: any[], userId?: string): Promise<void> {
    if (!payments || !Array.isArray(payments)) return;

    for (const payment of payments) {
      await this.storePayment(payment, userId);
    }
  }

  /**
   * Clear payment cache for a specific user
   */
  async clearUserPayments(userId: string): Promise<void> {
    try {
      const pattern = `${this.USER_PAYMENT_PREFIX}${userId}:*`;
      await this.cache.deletePattern(pattern);
    } catch (error) {
      console.error('Failed to clear user payment cache:', error);
    }
  }

  /**
   * Update TTL for a payment
   */
  async refreshPayment(identifier: string): Promise<void> {
    const payment = await this.getPayment(identifier);
    if (payment) {
      await this.storePayment(payment);
    }
  }
}

// Export singleton instance getter
export const getPaymentCache = (): PaymentCache => PaymentCache.getInstance();