import { FastifyReply, FastifyRequest } from "fastify";
import { ErrorRecoveryManager, ErrorType, ErrorSeverity } from "./ErrorRecoveryManager";
import { initializeServices } from "../services";
import { sanitizeError } from "../middleware/security";

export interface ErrorResponse {
  success: false;
  error: {
    message: string;
    type: string;
    severity: string;
    errorId: string;
    retryable?: boolean;
  };
}

export async function errorHandler(
  error: Error,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const injector = initializeServices();
    const errorRecoveryManager = injector.getErrorRecoveryManager();
    
    const userId = (request as any).user?.id;
    const operation = `${request.method} ${request.url}`;
    
    const errorType = errorRecoveryManager.classifyError(error);
    const userMessage = errorRecoveryManager.getUserFriendlyMessage(error);
    const errorId = `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const severity = determineSeverityForHttp(error, errorType);
    const statusCode = getHttpStatusCode(error, errorType);

    const isRetryable = isRetryableError(errorType, error);

    const isDevelopment = process.env.NODE_ENV === 'development';
    const sanitized = sanitizeError(error, isDevelopment);

    const response: ErrorResponse = {
      success: false,
      error: {
        message: sanitized.message || userMessage,
        type: errorType,
        severity,
        errorId,
        retryable: isRetryable
      }
    };

    if (isDevelopment) {
      (response.error as any).details = sanitized.details || {
        originalMessage: error.message,
        stack: error.stack,
        operation
      };
    }

    reply.status(sanitized.statusCode || statusCode).send(response);

    const logger = injector.getLogger();
    logger.error({
      errorId,
      errorType,
      severity,
      operation,
      userId,
      message: error.message,
      stack: error.stack,
      statusCode,
      userAgent: request.headers['user-agent'],
      ip: request.ip
    });

  } catch (handlerError) {
    console.error('Error in error handler:', handlerError);
    
    reply.status(500).send({
      success: false,
      error: {
        message: "An unexpected error occurred",
        type: "system",
        severity: "high",
        errorId: `fallback_${Date.now()}`
      }
    });
  }
}

function determineSeverityForHttp(error: Error, errorType: ErrorType): string {
  const message = error.message.toLowerCase();
  
  if (message.includes('critical') || 
      message.includes('fatal') || 
      message.includes('corrupt')) {
    return ErrorSeverity.Critical;
  }
  
  if (errorType === ErrorType.Network || errorType === ErrorType.Sdk) {
    return ErrorSeverity.High;
  }
  
  if (errorType === ErrorType.User) {
    return ErrorSeverity.Low;
  }
  
  return ErrorSeverity.Medium;
}

function getHttpStatusCode(error: Error, errorType: ErrorType): number {
  const message = error.message.toLowerCase();
  
  if (message.includes('unauthorized') || message.includes('not authenticated')) {
    return 401;
  }
  
  if (message.includes('forbidden') || message.includes('not authorized')) {
    return 403;
  }
  
  if (message.includes('not found')) {
    return 404;
  }
  
  if (message.includes('timeout')) {
    return 408;
  }
  
  if (message.includes('too many requests')) {
    return 429;
  }
  
  if (errorType === ErrorType.User) {
    return 400; // Bad Request
  }
  
  if (errorType === ErrorType.Network) {
    return 502; // Bad Gateway
  }
  
  if (errorType === ErrorType.Sdk) {
    return 503; // Service Unavailable
  }
  
  return 500; // Internal Server Error
}

function isRetryableError(errorType: ErrorType, error: Error): boolean {
  if (errorType === ErrorType.User) {
    return false;
  }
  
  const message = error.message.toLowerCase();
  
  if (message.includes('invalid') && 
      !message.includes('network') && 
      !message.includes('connection')) {
    return false;
  }
  
  return errorType === ErrorType.Network || 
         errorType === ErrorType.Sdk ||
         errorType === ErrorType.System;
}

export function wrapAsyncRoute(
  routeHandler: (request: FastifyRequest, reply: FastifyReply) => Promise<any>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await routeHandler(request, reply);
    } catch (error) {
      await errorHandler(error as Error, request, reply);
    }
  };
}

export function withErrorRecovery(
  operationName: string,
  userId?: string
) {
  return function (target: any, propertyName: string, descriptor: PropertyDescriptor) {
    const method = descriptor.value;
    
    descriptor.value = async function (...args: any[]) {
      const injector = initializeServices();
      const errorRecoveryManager = injector.getErrorRecoveryManager();
      
      return await errorRecoveryManager.withErrorRecovery(
        () => method.apply(this, args),
        operationName,
        userId
      );
    };
    
    return descriptor;
  };
}