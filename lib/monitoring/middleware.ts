import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { MetricsCollector } from './MetricsCollector';

export function setupMetricsMiddleware(app: FastifyInstance): void {
  const collector = MetricsCollector.getInstance();
  
  // Record system metrics every 30 seconds
  setInterval(() => {
    collector.recordSystemMetrics();
  }, 30000);
  
  // Initial system metrics
  collector.recordSystemMetrics();
  
  app.addHook('onRequest', async (req: FastifyRequest) => {
    (req as any).metricsStart = Date.now();
  });
  
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const responseTime = Date.now() - ((req as any).metricsStart || Date.now());
    const endpoint = req.routeOptions?.url || req.url;
    
    collector.recordHttpRequest(
      req.method,
      endpoint,
      reply.statusCode,
      responseTime
    );
  });
}

export function recordSDKMetric(
  operation: string,
  success: boolean,
  duration: number,
  userId?: string
): void {
  const collector = MetricsCollector.getInstance();
  collector.recordSDKOperation(operation, success, duration, userId);
}

export function recordPaymentMetric(
  type: 'sent' | 'received' | 'failed',
  amount: bigint,
  paymentType: string
): void {
  const collector = MetricsCollector.getInstance();
  collector.recordPayment(type, amount, paymentType);
}

export function recordCacheMetric(hit: boolean): void {
  const collector = MetricsCollector.getInstance();
  collector.recordCacheOperation(hit);
}

export function setGaugeMetric(name: string, value: number, labels?: Record<string, string>): void {
  const collector = MetricsCollector.getInstance();
  collector.setGauge(name, value, labels);
}

export function incrementCounterMetric(name: string, value: number = 1, labels?: Record<string, string>): void {
  const collector = MetricsCollector.getInstance();
  collector.incrementCounter(name, value, labels);
}