import { walletCache } from "../cache/WalletCache";

interface SdkMetrics {
  connectTime: number;
  disconnectTime: number;
  operationCount: number;
  errorCount: number;
  lastActivity: number;
}

export class SdkOptimizer {
  private static instance: SdkOptimizer;
  private metrics: SdkMetrics = {
    connectTime: 0,
    disconnectTime: 0,
    operationCount: 0,
    errorCount: 0,
    lastActivity: Date.now()
  };

  static getInstance(): SdkOptimizer {
    if (!SdkOptimizer.instance) {
      SdkOptimizer.instance = new SdkOptimizer();
    }
    return SdkOptimizer.instance;
  }

  private constructor() {}

  trackConnect(): void {
    this.metrics.connectTime = Date.now();
    this.metrics.lastActivity = Date.now();
  }

  trackDisconnect(): void {
    this.metrics.disconnectTime = Date.now();
  }

  trackOperation(): void {
    this.metrics.operationCount++;
    this.metrics.lastActivity = Date.now();
  }

  trackError(): void {
    this.metrics.errorCount++;
    this.metrics.lastActivity = Date.now();
  }

  shouldReconnect(): boolean {
    const inactiveTime = Date.now() - this.metrics.lastActivity;
    return inactiveTime > 600000; // 10 minutes
  }

  async invalidateUserCache(userId: string): Promise<void> {
    await walletCache.invalidateUser(userId);
  }

  getMetrics(): SdkMetrics {
    return { ...this.metrics };
  }

  reset(): void {
    this.metrics = {
      connectTime: 0,
      disconnectTime: 0,
      operationCount: 0,
      errorCount: 0,
      lastActivity: Date.now()
    };
  }
}

export const sdkOptimizer = SdkOptimizer.getInstance();