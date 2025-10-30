// Simple in-memory cache - wallet state is managed in browser

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export class CacheManager {
  private static instance: CacheManager;
  private readonly defaultTTL = 30 * 1000; // 30 seconds
  private cache = new Map<string, CacheEntry<any>>();

  static getInstance(): CacheManager {
    if (!CacheManager.instance) {
      CacheManager.instance = new CacheManager();
    }
    return CacheManager.instance;
  }

  private constructor() {
    // Clean up expired entries every minute
    setInterval(() => this.cleanExpired(), 60 * 1000);
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
      }
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const entry = this.cache.get(key);
      if (!entry) return null;

      const now = Date.now();

      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
        return null;
      }

      return entry.data as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, data: T, ttl?: number): Promise<void> {
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL
    };

    this.cache.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async deletePattern(pattern: string): Promise<void> {
    // Simple pattern matching with * wildcard
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
      }
    }
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }
}
