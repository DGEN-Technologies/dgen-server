export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
}

export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private windowMs: number;
  private maxRequests: number;
  private lastCleanup: number = Date.now();
  private readonly MAX_ENTRIES = 10000; // Prevent unbounded growth
  private readonly CLEANUP_INTERVAL = 60000; // Clean every minute

  constructor(options: RateLimiterOptions) {
    this.windowMs = options.windowMs;
    this.maxRequests = options.maxRequests;
  }

  check(key: string): boolean {
    const now = Date.now();

    // Periodic cleanup to prevent memory leak
    if (now - this.lastCleanup > this.CLEANUP_INTERVAL) {
      this.cleanup();
      this.lastCleanup = now;
    }

    const requests = this.requests.get(key) || [];

    // Remove old requests outside window
    const validRequests = requests.filter(time => now - time < this.windowMs);

    // Check if limit exceeded
    if (validRequests.length >= this.maxRequests) {
      // Only keep valid requests, not old ones
      if (validRequests.length > 0) {
        this.requests.set(key, validRequests);
      } else {
        // No valid requests, remove the key entirely
        this.requests.delete(key);
      }
      return false;
    }

    // Add new request
    validRequests.push(now);
    this.requests.set(key, validRequests);

    // Prevent map from growing too large
    if (this.requests.size > this.MAX_ENTRIES) {
      this.cleanup();
    }

    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    // Remove entries with no valid requests
    for (const [key, times] of this.requests.entries()) {
      if (times.every(t => now - t > this.windowMs)) {
        this.requests.delete(key);
      }
    }
  }

  reset(key: string): void {
    this.requests.delete(key);
  }

  resetAll(): void {
    this.requests.clear();
  }

  getStats(): any {
    return {
      totalKeys: this.requests.size,
      windowMs: this.windowMs,
      maxRequests: this.maxRequests
    };
  }
}