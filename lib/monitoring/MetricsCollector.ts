import { EventEmitter } from 'events';
import { redis } from '../redis';

export interface Metric {
  name: string;
  value: number;
  type: 'counter' | 'gauge' | 'histogram' | 'summary';
  timestamp: number;
  labels?: Record<string, string>;
}

export interface MetricsSummary {
  timestamp: number;
  period: string;
  metrics: {
    requests: {
      total: number;
      byStatus: Record<string, number>;
      byEndpoint: Record<string, number>;
      averageResponseTime: number;
    };
    sdk: {
      operations: number;
      errors: number;
      connectionState: string;
      activeSessions: number;
      averageOperationTime: number;
    };
    payments: {
      sent: number;
      received: number;
      failed: number;
      totalVolume: string;
      averageAmount: string;
    };
    system: {
      memoryUsage: NodeJS.MemoryUsage;
      cpuUsage: NodeJS.CpuUsage;
      uptime: number;
      activeConnections: number;
      redisConnections: number;
    };
    cache: {
      hits: number;
      misses: number;
      hitRate: number;
      size: number;
    };
  };
}

export class MetricsCollector extends EventEmitter {
  private static instance: MetricsCollector;
  private metrics: Map<string, Metric[]> = new Map();
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();
  private histograms: Map<string, number[]> = new Map();
  private flushInterval: NodeJS.Timer | null = null;
  private readonly maxMetricsAge = 3600000; // 1 hour
  private readonly flushIntervalMs = 60000; // 1 minute

  private constructor() {
    super();
    this.startFlushInterval();
  }

  public static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }

  private startFlushInterval(): void {
    this.flushInterval = setInterval(() => {
      this.flush();
      this.cleanOldMetrics();
    }, this.flushIntervalMs);
  }

  public incrementCounter(name: string, value: number = 1, labels?: Record<string, string>): void {
    const key = this.getMetricKey(name, labels);
    const current = this.counters.get(key) || 0;
    this.counters.set(key, current + value);
    
    this.recordMetric({
      name,
      value: current + value,
      type: 'counter',
      timestamp: Date.now(),
      labels
    });
  }

  public setGauge(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.getMetricKey(name, labels);
    this.gauges.set(key, value);
    
    this.recordMetric({
      name,
      value,
      type: 'gauge',
      timestamp: Date.now(),
      labels
    });
  }

  public recordHistogram(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.getMetricKey(name, labels);
    const values = this.histograms.get(key) || [];
    values.push(value);
    this.histograms.set(key, values);
    
    this.recordMetric({
      name,
      value,
      type: 'histogram',
      timestamp: Date.now(),
      labels
    });
  }

  public recordHttpRequest(
    method: string,
    endpoint: string,
    statusCode: number,
    responseTime: number
  ): void {
    this.incrementCounter('http_requests_total', 1, { method, endpoint, status: statusCode.toString() });
    this.recordHistogram('http_request_duration_ms', responseTime, { method, endpoint });
    
    if (statusCode >= 500) {
      this.incrementCounter('http_errors_5xx', 1, { endpoint });
    } else if (statusCode >= 400) {
      this.incrementCounter('http_errors_4xx', 1, { endpoint });
    }
  }

  public recordSDKOperation(
    operation: string,
    success: boolean,
    duration: number,
    userId?: string
  ): void {
    this.incrementCounter('sdk_operations_total', 1, { operation, success: success.toString() });
    this.recordHistogram('sdk_operation_duration_ms', duration, { operation });
    
    if (!success) {
      this.incrementCounter('sdk_errors_total', 1, { operation });
    }
  }

  public recordPayment(
    type: 'sent' | 'received' | 'failed',
    amount: bigint,
    paymentType: string
  ): void {
    this.incrementCounter(`payments_${type}_total`, 1, { type: paymentType });
    this.incrementCounter(`payments_${type}_satoshis`, Number(amount), { type: paymentType });
  }

  public recordCacheOperation(hit: boolean): void {
    if (hit) {
      this.incrementCounter('cache_hits_total', 1);
    } else {
      this.incrementCounter('cache_misses_total', 1);
    }
  }

  public recordSystemMetrics(): void {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    this.setGauge('memory_heap_used_bytes', memUsage.heapUsed);
    this.setGauge('memory_heap_total_bytes', memUsage.heapTotal);
    this.setGauge('memory_rss_bytes', memUsage.rss);
    this.setGauge('memory_external_bytes', memUsage.external);
    
    this.setGauge('cpu_user_microseconds', cpuUsage.user);
    this.setGauge('cpu_system_microseconds', cpuUsage.system);
    
    this.setGauge('process_uptime_seconds', process.uptime());
  }

  public async getSummary(period: string = '1h'): Promise<MetricsSummary> {
    const now = Date.now();
    const periodMs = this.parsePeriod(period);
    const startTime = now - periodMs;
    
    const httpRequests = this.getMetricsInRange('http_requests_total', startTime, now);
    const httpDurations = this.getMetricsInRange('http_request_duration_ms', startTime, now);
    const sdkOperations = this.getMetricsInRange('sdk_operations_total', startTime, now);
    const sdkErrors = this.getMetricsInRange('sdk_errors_total', startTime, now);
    const paymentsSent = this.getMetricsInRange('payments_sent_total', startTime, now);
    const paymentsReceived = this.getMetricsInRange('payments_received_total', startTime, now);
    const paymentsFailed = this.getMetricsInRange('payments_failed_total', startTime, now);
    const cacheHits = this.getMetricsInRange('cache_hits_total', startTime, now);
    const cacheMisses = this.getMetricsInRange('cache_misses_total', startTime, now);
    
    const requestsByStatus = this.groupByLabel(httpRequests, 'status');
    const requestsByEndpoint = this.groupByLabel(httpRequests, 'endpoint');
    
    const totalCacheOps = cacheHits.length + cacheMisses.length;
    const cacheHitRate = totalCacheOps > 0 ? cacheHits.length / totalCacheOps : 0;
    
    const redisInfo = await redis.info('clients').catch(() => '');
    const redisInfoStr = typeof redisInfo === 'string' ? redisInfo : String(redisInfo);
    const redisConnections = parseInt(redisInfoStr.match(/connected_clients:(\d+)/)?.[1] || '0');
    
    return {
      timestamp: now,
      period,
      metrics: {
        requests: {
          total: httpRequests.length,
          byStatus: requestsByStatus,
          byEndpoint: requestsByEndpoint,
          averageResponseTime: this.calculateAverage(httpDurations.map(m => m.value))
        },
        sdk: {
          operations: sdkOperations.length,
          errors: sdkErrors.length,
          connectionState: this.gauges.get('sdk_connection_state') === 1 ? 'connected' : 'disconnected',
          activeSessions: this.gauges.get('sdk_active_sessions') || 0,
          averageOperationTime: this.calculateAverage(
            this.getMetricsInRange('sdk_operation_duration_ms', startTime, now).map(m => m.value)
          )
        },
        payments: {
          sent: paymentsSent.length,
          received: paymentsReceived.length,
          failed: paymentsFailed.length,
          totalVolume: this.calculateSum(
            [...this.getMetricsInRange('payments_sent_satoshis', startTime, now),
             ...this.getMetricsInRange('payments_received_satoshis', startTime, now)]
            .map(m => m.value)
          ).toString(),
          averageAmount: this.calculateAverage(
            [...this.getMetricsInRange('payments_sent_satoshis', startTime, now),
             ...this.getMetricsInRange('payments_received_satoshis', startTime, now)]
            .map(m => m.value)
          ).toString()
        },
        system: {
          memoryUsage: process.memoryUsage(),
          cpuUsage: process.cpuUsage(),
          uptime: process.uptime(),
          activeConnections: this.gauges.get('websocket_connections') || 0,
          redisConnections
        },
        cache: {
          hits: cacheHits.length,
          misses: cacheMisses.length,
          hitRate: cacheHitRate,
          size: this.gauges.get('cache_size_bytes') || 0
        }
      }
    };
  }

  private recordMetric(metric: Metric): void {
    const metrics = this.metrics.get(metric.name) || [];
    metrics.push(metric);
    this.metrics.set(metric.name, metrics);
  }

  private getMetricKey(name: string, labels?: Record<string, string>): string {
    if (!labels) return name;
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return `${name}{${labelStr}}`;
  }

  private getMetricsInRange(name: string, startTime: number, endTime: number): Metric[] {
    const metrics = this.metrics.get(name) || [];
    return metrics.filter(m => m.timestamp >= startTime && m.timestamp <= endTime);
  }

  private groupByLabel(metrics: Metric[], label: string): Record<string, number> {
    const grouped: Record<string, number> = {};
    for (const metric of metrics) {
      const labelValue = metric.labels?.[label] || 'unknown';
      grouped[labelValue] = (grouped[labelValue] || 0) + 1;
    }
    return grouped;
  }

  private calculateAverage(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private calculateSum(values: number[]): number {
    return values.reduce((a, b) => a + b, 0);
  }

  private parsePeriod(period: string): number {
    const match = period.match(/^(\d+)([mhd])$/);
    if (!match) return 3600000; // Default to 1 hour
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    switch (unit) {
      case 'm': return value * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      case 'd': return value * 24 * 60 * 60 * 1000;
      default: return 3600000;
    }
  }

  private cleanOldMetrics(): void {
    const cutoff = Date.now() - this.maxMetricsAge;
    
    for (const [name, metrics] of this.metrics.entries()) {
      const filtered = metrics.filter(m => m.timestamp > cutoff);
      if (filtered.length > 0) {
        this.metrics.set(name, filtered);
      } else {
        this.metrics.delete(name);
      }
    }
  }

  private async flush(): Promise<void> {
    try {
      const summary = await this.getSummary('1m');
      await redis.zAdd(
        'metrics:summaries',
        {
          score: Date.now(),
          value: JSON.stringify(summary)
        }
      );
      
      // Keep only last 24 hours of summaries
      const cutoff = Date.now() - 86400000;
      await redis.zRemRangeByScore('metrics:summaries', '-inf', cutoff);
    } catch (error) {
      console.error('Failed to flush metrics:', error);
    }
  }

  public stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }
}