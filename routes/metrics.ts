import { FastifyRequest, FastifyReply } from 'fastify';
import { MetricsCollector } from '../lib/monitoring/MetricsCollector';

interface MetricsQuery {
  period?: string;
  format?: 'json' | 'prometheus';
}

export async function metrics(req: FastifyRequest<{ Querystring: MetricsQuery }>, reply: FastifyReply) {
  const collector = MetricsCollector.getInstance();
  const { period = '1h', format = 'json' } = req.query;
  
  if (format === 'prometheus') {
    const summary = await collector.getSummary(period);
    const prometheusFormat = convertToPrometheus(summary);
    reply.type('text/plain').send(prometheusFormat);
  } else {
    const summary = await collector.getSummary(period);
    reply.send(summary);
  }
}

function convertToPrometheus(summary: any): string {
  const lines: string[] = [];
  const timestamp = summary.timestamp;
  
  // HTTP metrics
  lines.push(`# HELP http_requests_total Total number of HTTP requests`);
  lines.push(`# TYPE http_requests_total counter`);
  lines.push(`http_requests_total ${summary.metrics.requests.total} ${timestamp}`);
  
  for (const [status, count] of Object.entries(summary.metrics.requests.byStatus as Record<string, number>)) {
    lines.push(`http_requests_total{status="${status}"} ${count} ${timestamp}`);
  }
  
  lines.push(`# HELP http_request_duration_ms HTTP request duration in milliseconds`);
  lines.push(`# TYPE http_request_duration_ms histogram`);
  lines.push(`http_request_duration_ms ${summary.metrics.requests.averageResponseTime} ${timestamp}`);
  
  // SDK metrics
  lines.push(`# HELP sdk_operations_total Total number of SDK operations`);
  lines.push(`# TYPE sdk_operations_total counter`);
  lines.push(`sdk_operations_total ${summary.metrics.sdk.operations} ${timestamp}`);
  
  lines.push(`# HELP sdk_errors_total Total number of SDK errors`);
  lines.push(`# TYPE sdk_errors_total counter`);
  lines.push(`sdk_errors_total ${summary.metrics.sdk.errors} ${timestamp}`);
  
  lines.push(`# HELP sdk_active_sessions Number of active SDK sessions`);
  lines.push(`# TYPE sdk_active_sessions gauge`);
  lines.push(`sdk_active_sessions ${summary.metrics.sdk.activeSessions} ${timestamp}`);
  
  // Payment metrics
  lines.push(`# HELP payments_sent_total Total number of sent payments`);
  lines.push(`# TYPE payments_sent_total counter`);
  lines.push(`payments_sent_total ${summary.metrics.payments.sent} ${timestamp}`);
  
  lines.push(`# HELP payments_received_total Total number of received payments`);
  lines.push(`# TYPE payments_received_total counter`);
  lines.push(`payments_received_total ${summary.metrics.payments.received} ${timestamp}`);
  
  lines.push(`# HELP payments_failed_total Total number of failed payments`);
  lines.push(`# TYPE payments_failed_total counter`);
  lines.push(`payments_failed_total ${summary.metrics.payments.failed} ${timestamp}`);
  
  // System metrics
  lines.push(`# HELP memory_heap_used_bytes Heap memory used in bytes`);
  lines.push(`# TYPE memory_heap_used_bytes gauge`);
  lines.push(`memory_heap_used_bytes ${summary.metrics.system.memoryUsage.heapUsed} ${timestamp}`);
  
  lines.push(`# HELP memory_rss_bytes RSS memory in bytes`);
  lines.push(`# TYPE memory_rss_bytes gauge`);
  lines.push(`memory_rss_bytes ${summary.metrics.system.memoryUsage.rss} ${timestamp}`);
  
  lines.push(`# HELP process_uptime_seconds Process uptime in seconds`);
  lines.push(`# TYPE process_uptime_seconds gauge`);
  lines.push(`process_uptime_seconds ${summary.metrics.system.uptime} ${timestamp}`);
  
  lines.push(`# HELP websocket_connections Number of active WebSocket connections`);
  lines.push(`# TYPE websocket_connections gauge`);
  lines.push(`websocket_connections ${summary.metrics.system.activeConnections} ${timestamp}`);
  
  lines.push(`# HELP redis_connections Number of Redis connections`);
  lines.push(`# TYPE redis_connections gauge`);
  lines.push(`redis_connections ${summary.metrics.system.redisConnections} ${timestamp}`);
  
  // Cache metrics
  lines.push(`# HELP cache_hits_total Total number of cache hits`);
  lines.push(`# TYPE cache_hits_total counter`);
  lines.push(`cache_hits_total ${summary.metrics.cache.hits} ${timestamp}`);
  
  lines.push(`# HELP cache_misses_total Total number of cache misses`);
  lines.push(`# TYPE cache_misses_total counter`);
  lines.push(`cache_misses_total ${summary.metrics.cache.misses} ${timestamp}`);
  
  lines.push(`# HELP cache_hit_rate Cache hit rate`);
  lines.push(`# TYPE cache_hit_rate gauge`);
  lines.push(`cache_hit_rate ${summary.metrics.cache.hitRate} ${timestamp}`);
  
  return lines.join('\n');
}

export default {
  metrics
};