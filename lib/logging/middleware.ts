import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { StructuredLogger } from './StructuredLogger';
import { randomUUID } from 'crypto';

export function setupLoggingMiddleware(app: FastifyInstance): void {
  const logger = StructuredLogger.getInstance();
  
  app.decorateRequest('correlationId', null);
  app.decorateRequest('logContext', null);
  
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const correlationId = (req.headers['x-correlation-id'] as string) || randomUUID();
    const requestId = randomUUID();
    
    (req as any).correlationId = correlationId;
    (req as any).requestStart = Date.now();
    
    const context = logger.createContext({
      correlationId,
      requestId,
      userId: (req as any).user?.id,
      operation: `${req.method} ${req.url}`,
      metadata: {
        method: req.method,
        url: req.url,
        ip: req.ip,
        userAgent: req.headers['user-agent']
      }
    });
    
    (req as any).logContext = context;
    
    reply.header('X-Correlation-Id', correlationId);
    reply.header('X-Request-Id', requestId);
  });
  
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const responseTime = Date.now() - (req as any).requestStart;
    const correlationId = (req as any).correlationId;
    
    logger.logRequest(req, reply, responseTime);
    
    if (correlationId) {
      logger.clearContext(correlationId);
    }
  });
  
  app.addHook('onError', async (req: FastifyRequest, reply: FastifyReply, error: Error) => {
    const correlationId = (req as any).correlationId;
    const context = (req as any).logContext || {};
    
    logger.logErrorWithContext(error, context, {
      requestMethod: req.method,
      requestUrl: req.url,
      statusCode: reply.statusCode
    });
  });
}

export function getRequestLogger(req: FastifyRequest): StructuredLogger {
  const logger = StructuredLogger.getInstance();
  const context = (req as any).logContext;
  
  if (context) {
    return {
      ...logger,
      info: (message: string, metadata?: Record<string, any>) => 
        logger.info(message, { ...context, ...metadata }),
      warn: (message: string, metadata?: Record<string, any>) => 
        logger.warn(message, { ...context, ...metadata }),
      error: (message: string, metadata?: Record<string, any>) => 
        logger.error(message, { ...context, ...metadata }),
      debug: (message: string, metadata?: Record<string, any>) => 
        logger.debug(message, { ...context, ...metadata })
    } as StructuredLogger;
  }
  
  return logger;
}