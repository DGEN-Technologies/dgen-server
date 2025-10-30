import { CacheManager } from "./CacheManager";
import { performanceMonitor } from "../performance/PerformanceMonitor";

interface WalletInfo {
  balanceSat: bigint;
  pendingSendSat: bigint;
  pendingReceiveSat: bigint;
  blockHeight: number;
}

interface PaymentCache {
  payments: any[];
  filters?: any;
  pagination?: { offset: number; limit: number };
}

export class WalletCache {
  private static instance: WalletCache;
  private cache: CacheManager;

  static getInstance(): WalletCache {
    if (!WalletCache.instance) {
      WalletCache.instance = new WalletCache();
    }
    return WalletCache.instance;
  }

  private constructor() {
    this.cache = CacheManager.getInstance();
  }

  async getWalletInfo(userId: string): Promise<WalletInfo | null> {
    const result = await this.cache.get<WalletInfo>(`wallet:info:${userId}`);
    if (result) {
      performanceMonitor.trackCacheHit();
    } else {
      performanceMonitor.trackCacheMiss();
    }
    return result;
  }

  async setWalletInfo(userId: string, info: WalletInfo, ttl: number = 15000): Promise<void> {
    await this.cache.set(`wallet:info:${userId}`, info, ttl);
  }

  async getPayments(userId: string, filters?: string): Promise<PaymentCache | null> {
    const key = filters ? `payments:${userId}:${filters}` : `payments:${userId}`;
    const result = await this.cache.get<PaymentCache>(key);
    if (result) {
      performanceMonitor.trackCacheHit();
    } else {
      performanceMonitor.trackCacheMiss();
    }
    return result;
  }

  async setPayments(userId: string, payments: any[], filters?: string, ttl: number = 60000): Promise<void> {
    const key = filters ? `payments:${userId}:${filters}` : `payments:${userId}`;
    await this.cache.set(key, { payments, filters, pagination: { offset: 0, limit: payments.length } }, ttl);
  }

  async invalidateUser(userId: string): Promise<void> {
    await this.cache.delete(`wallet:info:${userId}`);
    
    const paymentKeys = [`payments:${userId}`, `payments:${userId}:*`];
    for (const keyPattern of paymentKeys) {
      await this.cache.delete(keyPattern);
    }
  }

  async getBalance(userId: string): Promise<bigint | null> {
    const info = await this.getWalletInfo(userId);
    return info?.balanceSat || null;
  }
}

export const walletCache = WalletCache.getInstance();