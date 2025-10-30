export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
}

export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private windowMs: number;
  private maxRequests: number;

  constructor(options: RateLimiterOptions) {
    this.windowMs = options.windowMs;
    this.maxRequests = options.maxRequests;
  }

  check(key: string): boolean {
    const now = Date.now();
    const requests = this.requests.get(key) || [];
    
    // Remove old requests outside window
    const validRequests = requests.filter(time => now - time < this.windowMs);
    
    // Check if limit exceeded
    if (validRequests.length >= this.maxRequests) {
      this.requests.set(key, validRequests);
      return false;
    }
    
    // Add new request
    validRequests.push(now);
    this.requests.set(key, validRequests);
    return true;
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