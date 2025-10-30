import { EventEmitter } from "events";
import { Logger } from "../services/interfaces";

export enum CircuitState {
  Closed = "closed",
  Open = "open", 
  HalfOpen = "half-open"
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeout: number;
  monitoringPeriod: number;
  expectedErrors?: string[];
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  totalRequests: number;
  lastFailureTime?: number;
  nextAttemptTime?: number;
}

export class CircuitBreaker extends EventEmitter {
  private state = CircuitState.Closed;
  private failureCount = 0;
  private successCount = 0;
  private totalRequests = 0;
  private lastFailureTime?: number;
  private nextAttemptTime?: number;
  private monitoringTimer?: NodeJS.Timeout;

  constructor(
    private name: string,
    private config: CircuitBreakerConfig,
    private logger: Logger
  ) {
    super();
    this.startMonitoring();
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.Open) {
      if (this.shouldAttemptReset()) {
        this.state = CircuitState.HalfOpen;
        this.logger.info(`Circuit breaker ${this.name} moving to half-open state`);
        this.emit("stateChange", CircuitState.HalfOpen);
      } else {
        const waitTime = this.nextAttemptTime ? this.nextAttemptTime - Date.now() : 0;
        throw new Error(`Circuit breaker ${this.name} is open. Next attempt in ${waitTime}ms`);
      }
    }

    this.totalRequests++;

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error as Error);
      throw error;
    }
  }

  private onSuccess(): void {
    this.successCount++;
    this.failureCount = 0;

    if (this.state === CircuitState.HalfOpen) {
      this.state = CircuitState.Closed;
      this.logger.info(`Circuit breaker ${this.name} closed after successful operation`);
      this.emit("stateChange", CircuitState.Closed);
    }
  }

  private onFailure(error: Error): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.isExpectedError(error)) {
      this.logger.debug(`Circuit breaker ${this.name} ignoring expected error: ${error.message}`);
      return;
    }

    if (this.state === CircuitState.HalfOpen) {
      this.openCircuit();
    } else if (this.failureCount >= this.config.failureThreshold) {
      this.openCircuit();
    }

    this.emit("failure", error, this.getStats());
  }

  private isExpectedError(error: Error): boolean {
    if (!this.config.expectedErrors) return false;
    return this.config.expectedErrors.some(expectedError => 
      error.message.toLowerCase().includes(expectedError.toLowerCase())
    );
  }

  private openCircuit(): void {
    this.state = CircuitState.Open;
    this.nextAttemptTime = Date.now() + this.config.recoveryTimeout;
    
    this.logger.warn(`Circuit breaker ${this.name} opened after ${this.failureCount} failures`);
    this.emit("stateChange", CircuitState.Open);
  }

  private shouldAttemptReset(): boolean {
    return this.nextAttemptTime !== undefined && Date.now() >= this.nextAttemptTime;
  }

  private startMonitoring(): void {
    this.monitoringTimer = setInterval(() => {
      this.emit("stats", this.getStats());
      
      if (this.totalRequests > 0) {
        this.logger.debug(`Circuit breaker ${this.name} stats:`, this.getStats());
      }
    }, this.config.monitoringPeriod);
  }

  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      totalRequests: this.totalRequests,
      lastFailureTime: this.lastFailureTime,
      nextAttemptTime: this.nextAttemptTime
    };
  }

  reset(): void {
    this.state = CircuitState.Closed;
    this.failureCount = 0;
    this.successCount = 0;
    this.totalRequests = 0;
    this.lastFailureTime = undefined;
    this.nextAttemptTime = undefined;
    
    this.logger.info(`Circuit breaker ${this.name} manually reset`);
    this.emit("stateChange", CircuitState.Closed);
  }

  forceOpen(): void {
    this.state = CircuitState.Open;
    this.nextAttemptTime = Date.now() + this.config.recoveryTimeout;
    
    this.logger.info(`Circuit breaker ${this.name} forced open`);
    this.emit("stateChange", CircuitState.Open);
  }

  cleanup(): void {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = undefined;
    }
    this.removeAllListeners();
  }
}