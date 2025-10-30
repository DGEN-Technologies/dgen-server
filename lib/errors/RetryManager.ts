import { Logger } from "../services/interfaces";
import { ErrorType, ErrorHandler } from "./ErrorHandler";
import { CircuitBreaker, CircuitBreakerConfig } from "./CircuitBreaker";

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterMs?: number;
  retryableErrors?: string[];
  circuitBreakerConfig?: CircuitBreakerConfig;
}

export interface RetryContext {
  attempt: number;
  totalAttempts: number;
  lastError?: Error;
  delayMs: number;
  operationId: string;
}

export class RetryManager {
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private defaultConfig: RetryConfig = {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    jitterMs: 100,
    retryableErrors: ["transport error", "network", "timeout", "connection"]
  };

  constructor(
    private errorHandler: ErrorHandler,
    private logger: Logger
  ) {}

  async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    config?: Partial<RetryConfig>,
    userId?: string
  ): Promise<T> {
    const fullConfig = { ...this.defaultConfig, ...config };
    const operationId = `${operationName}-${Date.now()}`;
    
    let circuitBreaker: CircuitBreaker | undefined;
    if (fullConfig.circuitBreakerConfig) {
      circuitBreaker = this.getOrCreateCircuitBreaker(operationName, fullConfig.circuitBreakerConfig);
    }

    const execute = async (): Promise<T> => {
      if (circuitBreaker) {
        return await circuitBreaker.execute(operation);
      }
      return await operation();
    };

    let lastError: Error | undefined;
    
    for (let attempt = 1; attempt <= fullConfig.maxRetries + 1; attempt++) {
      const isLastAttempt = attempt > fullConfig.maxRetries;
      
      try {
        const result = await execute();
        
        if (attempt > 1) {
          this.logger.info(`Operation ${operationName} succeeded on attempt ${attempt}`, {
            operationId,
            userId,
            attempt,
            totalAttempts: fullConfig.maxRetries + 1
          });
        }
        
        return result;
      } catch (error) {
        lastError = error as Error;
        
        const errorContext = await this.errorHandler.handleError(
          lastError,
          operationName,
          userId,
          { operationId, attempt, totalAttempts: fullConfig.maxRetries + 1 }
        );

        if (isLastAttempt || !this.shouldRetry(lastError, fullConfig)) {
          this.logger.error(`Operation ${operationName} failed after ${attempt} attempts`, {
            operationId,
            userId,
            errorId: errorContext.errorId,
            finalError: lastError.message
          });
          throw lastError;
        }

        const delayMs = this.calculateDelay(attempt - 1, fullConfig);
        
        this.logger.warn(`Operation ${operationName} failed on attempt ${attempt}, retrying in ${delayMs}ms`, {
          operationId,
          userId,
          attempt,
          error: lastError.message,
          nextRetryIn: delayMs
        });

        await this.delay(delayMs);
      }
    }

    throw lastError || new Error("Retry operation failed unexpectedly");
  }

  private shouldRetry(error: Error, config: RetryConfig): boolean {
    const errorType = this.errorHandler.classifyError(error);
    const strategy = this.errorHandler.getRecoveryStrategy(errorType);
    
    if (strategy && !strategy.shouldRetry) {
      return false;
    }

    if (config.retryableErrors) {
      const message = error.message.toLowerCase();
      return config.retryableErrors.some(retryableError => 
        message.includes(retryableError.toLowerCase())
      );
    }

    return errorType === ErrorType.Network || errorType === ErrorType.Sdk;
  }

  private calculateDelay(attemptIndex: number, config: RetryConfig): number {
    const exponentialDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attemptIndex);
    const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);
    
    if (config.jitterMs) {
      const jitter = Math.random() * config.jitterMs;
      return Math.round(cappedDelay + jitter);
    }
    
    return Math.round(cappedDelay);
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getOrCreateCircuitBreaker(
    name: string, 
    config: CircuitBreakerConfig
  ): CircuitBreaker {
    if (!this.circuitBreakers.has(name)) {
      const circuitBreaker = new CircuitBreaker(name, config, this.logger);
      this.circuitBreakers.set(name, circuitBreaker);
      
      circuitBreaker.on("stateChange", (state) => {
        this.logger.info(`Circuit breaker ${name} state changed to ${state}`);
      });
    }
    
    return this.circuitBreakers.get(name)!;
  }

  getCircuitBreakerStats(name: string) {
    const breaker = this.circuitBreakers.get(name);
    return breaker?.getStats();
  }

  resetCircuitBreaker(name: string): boolean {
    const breaker = this.circuitBreakers.get(name);
    if (breaker) {
      breaker.reset();
      return true;
    }
    return false;
  }

  cleanup(): void {
    for (const [name, breaker] of this.circuitBreakers.entries()) {
      breaker.cleanup();
      this.logger.debug(`Cleaned up circuit breaker: ${name}`);
    }
    this.circuitBreakers.clear();
  }
}