import { randomUUID } from 'crypto';
import pino from 'pino';
import { FastifyRequest, FastifyReply } from 'fastify';

export interface LogContext {
  correlationId: string;
  userId?: string;
  sessionId?: string;
  operation?: string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  metadata?: Record<string, any>;
}

export class StructuredLogger {
  private static instance: StructuredLogger;
  private logger: pino.Logger;
  private contextStore = new Map<string, LogContext>();

  private constructor() {
    this.logger = pino({
      level: process.env.LOG_LEVEL || 'info',
      formatters: {
        level: (label) => ({ level: label }),
        log: (object) => {
          const enriched = { ...object };
          
          if (!enriched.correlationId) {
            enriched.correlationId = this.getCurrentCorrelationId() || randomUUID();
          }
          
          if (!enriched.timestamp) {
            enriched.timestamp = new Date().toISOString();
          }
          
          const context = this.contextStore.get(enriched.correlationId);
          if (context) {
            enriched.userId = enriched.userId || context.userId;
            enriched.sessionId = enriched.sessionId || context.sessionId;
            enriched.operation = enriched.operation || context.operation;
            enriched.requestId = enriched.requestId || context.requestId;
          }
          
          return enriched;
        }
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      serializers: {
        error: pino.stdSerializers.err,
        req: (req: FastifyRequest) => ({
          method: req.method,
          url: req.url,
          headers: req.headers,
          params: req.params,
          query: req.query
        }),
        res: (res: FastifyReply) => ({
          statusCode: res.statusCode
        })
      }
    });
  }

  public static getInstance(): StructuredLogger {
    if (!StructuredLogger.instance) {
      StructuredLogger.instance = new StructuredLogger();
    }
    return StructuredLogger.instance;
  }

  private getCurrentCorrelationId(): string | undefined {
    const contexts = Array.from(this.contextStore.values());
    return contexts.length > 0 ? contexts[contexts.length - 1].correlationId : undefined;
  }

  public createContext(context: Partial<LogContext>): LogContext {
    const fullContext: LogContext = {
      correlationId: context.correlationId || randomUUID(),
      userId: context.userId,
      sessionId: context.sessionId,
      operation: context.operation,
      requestId: context.requestId,
      traceId: context.traceId,
      spanId: context.spanId,
      metadata: context.metadata
    };
    
    this.contextStore.set(fullContext.correlationId, fullContext);
    return fullContext;
  }

  public updateContext(correlationId: string, updates: Partial<LogContext>): void {
    const context = this.contextStore.get(correlationId);
    if (context) {
      Object.assign(context, updates);
    }
  }

  public clearContext(correlationId: string): void {
    this.contextStore.delete(correlationId);
  }

  public child(context: Partial<LogContext>): pino.Logger {
    return this.logger.child(context);
  }

  public logOperation(
    operation: string,
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    metadata?: Record<string, any>
  ): void {
    const logData = {
      operation,
      message,
      ...metadata
    };
    
    this.logger[level](logData);
  }

  public logRequest(req: FastifyRequest, res: FastifyReply, responseTime: number): void {
    const logData = {
      type: 'http_request',
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      responseTime,
      userId: (req as any).user?.id,
      userAgent: req.headers['user-agent'],
      ip: req.ip
    };
    
    if (res.statusCode >= 500) {
      this.logger.error(logData);
    } else if (res.statusCode >= 400) {
      this.logger.warn(logData);
    } else {
      this.logger.info(logData);
    }
  }

  public logSDKOperation(
    operation: string,
    userId: string,
    success: boolean,
    duration: number,
    metadata?: Record<string, any>
  ): void {
    const logData = {
      type: 'sdk_operation',
      operation,
      userId,
      success,
      duration,
      ...metadata
    };
    
    if (success) {
      this.logger.info(logData);
    } else {
      this.logger.error(logData);
    }
  }

  public logPaymentEvent(
    eventType: string,
    userId: string,
    paymentId: string,
    amount?: bigint,
    metadata?: Record<string, any>
  ): void {
    this.logger.info({
      type: 'payment_event',
      eventType,
      userId,
      paymentId,
      amount: amount?.toString(),
      ...metadata
    });
  }

  public logErrorWithContext(
    error: Error,
    context: Partial<LogContext>,
    metadata?: Record<string, any>
  ): void {
    this.logger.error({
      error: {
        message: error.message,
        name: error.name,
        stack: error.stack
      },
      ...context,
      ...metadata
    });
  }

  public logPerformanceMetric(
    metric: string,
    value: number,
    unit: string,
    metadata?: Record<string, any>
  ): void {
    this.logger.info({
      type: 'performance_metric',
      metric,
      value,
      unit,
      ...metadata
    });
  }

  public info(message: string, metadata?: Record<string, any>): void {
    this.logger.info({ message, ...metadata });
  }

  public warn(message: string, metadata?: Record<string, any>): void {
    this.logger.warn({ message, ...metadata });
  }

  public error(message: string, metadata?: Record<string, any>): void {
    this.logger.error({ message, ...metadata });
  }

  public debug(message: string, metadata?: Record<string, any>): void {
    this.logger.debug({ message, ...metadata });
  }
}