import { FastifyRequest, FastifyReply } from 'fastify';
import { initializeServices } from '../lib/services';
import { db, safeDb } from '../lib/db';
import { AlertManager } from '../lib/monitoring/AlertManager';
import { MetricsCollector } from '../lib/monitoring/MetricsCollector';
import { websocketManager } from '../lib/websocket/WebSocketManager';
import { connectionPool } from '../lib/performance/ConnectionPool';

interface HealthCheckComponent {
  name: string;
  status: 'healthy' | 'unhealthy' | 'degraded';
  message?: string;
  responseTime?: number;
  metadata?: Record<string, any>;
}

interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: number;
  version: string;
  uptime: number;
  components: HealthCheckComponent[];
  activeSessions: number;
  recentAlerts: number;
  paymentStats: {
    successRate: number;
    totalPayments: number;
    failedPayments: number;
  };
}

const startTime = Date.now();

async function checkDatabase(): Promise<HealthCheckComponent> {
  const start = Date.now();
  try {
    await db.ping();
    return {
      name: 'database',
      status: 'healthy',
      responseTime: Date.now() - start
    };
  } catch (error) {
    return {
      name: 'database',
      status: 'unhealthy',
      message: error.message,
      responseTime: Date.now() - start
    };
  }
}

async function checkRedis(): Promise<HealthCheckComponent> {
  const start = Date.now();
  try {
    await safeDb.ping();
    const info = await safeDb.info('clients');
    const infoStr = typeof info === 'string' ? info : String(info);
    const connectedClients = parseInt(infoStr.match(/connected_clients:(\d+)/)?.[1] || '0');

    return {
      name: 'redis',
      status: 'healthy',
      responseTime: Date.now() - start,
      metadata: { connectedClients }
    };
  } catch (error) {
    return {
      name: 'redis',
      status: 'unhealthy',
      message: error.message,
      responseTime: Date.now() - start
    };
  }
}

async function checkConnectivity(): Promise<HealthCheckComponent> {
  const start = Date.now();
  // Connectivity is now handled client-side via Breez SDK in browser
  // Server only provides webhook endpoints and data storage
  return {
    name: 'connectivity',
    status: 'healthy',
    responseTime: Date.now() - start,
    metadata: {
      state: 'client-side',
      note: 'Breez SDK runs in browser'
    }
  };
}

async function checkWebSocket(): Promise<HealthCheckComponent> {
  const start = Date.now();
  try {
    const stats = websocketManager.getStats();
    const poolStats = connectionPool.getStats();

    // Check for connection pool saturation
    const poolUtilization = (poolStats.total / poolStats.maxConnections) * 100;

    function getStatus(): 'healthy' | 'degraded' | 'unhealthy' {
      const isHealthy = stats.totalConnections >= 0 && poolUtilization < 80;
      if (isHealthy) return 'healthy';
      if (poolUtilization >= 80 && poolUtilization < 90) return 'degraded';
      return 'unhealthy';
    }

    return {
      name: 'websocket',
      status: getStatus(),
      responseTime: Date.now() - start,
      metadata: {
        totalConnections: stats.totalConnections,
        authenticatedConnections: stats.authenticatedConnections,
        uniqueUsers: stats.uniqueUsers,
        connectionPool: {
          total: poolStats.total,
          active: poolStats.active,
          maxConnections: poolStats.maxConnections,
          utilization: poolUtilization.toFixed(2) + '%'
        }
      }
    };
  } catch (error) {
    return {
      name: 'websocket',
      status: 'unhealthy',
      message: error.message,
      responseTime: Date.now() - start
    };
  }
}

export async function health(req: FastifyRequest, reply: FastifyReply) {
  const components: HealthCheckComponent[] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkConnectivity(),
    checkWebSocket()
  ]);
  
  function determineOverallStatus(): 'healthy' | 'unhealthy' | 'degraded' {
    if (components.every(c => c.status === 'healthy')) return 'healthy';
    if (components.some(c => c.status === 'unhealthy')) return 'unhealthy';
    return 'degraded';
  }
  const overallStatus = determineOverallStatus();

  const metricsCollector = MetricsCollector.getInstance();
  const injector = initializeServices();
  const logger = injector.getLogger();
  
  let activeSessions = 0;
  let recentAlerts = 0;
  let paymentStats = { successRate: 100, totalPayments: 0, failedPayments: 0 };

  try {
    // Active sessions are now tracked via WebSocket connections (client-side SDK)
    const wsStats = websocketManager.getStats();
    activeSessions = wsStats.authenticatedConnections || 0;

    const alertManager = AlertManager.getInstance(logger, metricsCollector);
    recentAlerts = alertManager.getRecentAlerts(1).length;

    const summary = await metricsCollector.getSummary('1h');
    const { sent, received, failed } = summary.metrics.payments;
    const totalPayments = sent + received + failed;

    if (totalPayments > 0) {
      paymentStats = {
        successRate: ((sent + received) / totalPayments) * 100,
        totalPayments,
        failedPayments: failed
      };
    }
  } catch (error) {
    logger.error('Failed to collect health metrics', { error: error.message });
  }
  
  const response: HealthCheckResponse = {
    status: overallStatus,
    timestamp: Date.now(),
    version: process.env.npm_package_version || '1.0.0',
    uptime: Date.now() - startTime,
    components,
    activeSessions,
    recentAlerts,
    paymentStats
  };
  
  const statusCode = overallStatus === 'healthy' ? 200 : 503;
  reply.code(statusCode).send(response);
}

export async function liveness(req: FastifyRequest, reply: FastifyReply) {
  reply.code(200).send({ status: 'alive', timestamp: Date.now() });
}

export async function readiness(req: FastifyRequest, reply: FastifyReply) {
  const dbCheck = await checkDatabase();
  const redisCheck = await checkRedis();
  
  if (dbCheck.status === 'healthy' && redisCheck.status === 'healthy') {
    reply.code(200).send({ status: 'ready', timestamp: Date.now() });
  } else {
    reply.code(503).send({ 
      status: 'not ready', 
      timestamp: Date.now(),
      components: [dbCheck, redisCheck]
    });
  }
}

export default {
  health,
  liveness,
  readiness
};
