import { connectionPool } from "./ConnectionPool";
import { sdkOptimizer } from "./SdkOptimizer";

interface PerformanceMetrics {
  timestamp: number;
  connections: {
    total: number;
    active: number;
    maxConnections: number;
  };
  sdk: {
    connectTime: number;
    disconnectTime: number;
    operationCount: number;
    errorCount: number;
    lastActivity: number;
  };
  cache: {
    hits: number;
    misses: number;
    hitRate: number;
  };
  memory: {
    used: number;
    free: number;
    total: number;
  };
}

export class PerformanceMonitor {
  private static instance: PerformanceMonitor;
  private cacheHits = 0;
  private cacheMisses = 0;

  static getInstance(): PerformanceMonitor {
    if (!PerformanceMonitor.instance) {
      PerformanceMonitor.instance = new PerformanceMonitor();
    }
    return PerformanceMonitor.instance;
  }

  private constructor() {}

  trackCacheHit(): void {
    this.cacheHits++;
  }

  trackCacheMiss(): void {
    this.cacheMisses++;
  }

  getMetrics(): PerformanceMetrics {
    const memUsage = process.memoryUsage();
    const cacheTotal = this.cacheHits + this.cacheMisses;
    
    return {
      timestamp: Date.now(),
      connections: connectionPool.getStats(),
      sdk: sdkOptimizer.getMetrics(),
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        hitRate: cacheTotal > 0 ? this.cacheHits / cacheTotal : 0
      },
      memory: {
        used: memUsage.heapUsed,
        free: memUsage.heapTotal - memUsage.heapUsed,
        total: memUsage.heapTotal
      }
    };
  }

  reset(): void {
    this.cacheHits = 0;
    this.cacheMisses = 0;
    sdkOptimizer.reset();
  }
}

export const performanceMonitor = PerformanceMonitor.getInstance();