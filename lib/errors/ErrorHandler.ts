import { randomUUID } from "crypto";
import { Logger } from "../services/interfaces";

export enum ErrorType {
  Network = "network",
  Sdk = "sdk", 
  User = "user",
  System = "system"
}

export enum ErrorSeverity {
  Low = "low",
  Medium = "medium", 
  High = "high",
  Critical = "critical"
}

export interface ErrorContext {
  errorId: string;
  errorType: ErrorType;
  severity: ErrorSeverity;
  userId?: string;
  operation?: string;
  originalMessage: string;
  timestamp: number;
  stack?: string;
  metadata?: Record<string, any>;
}

export interface RecoveryStrategy {
  shouldRetry: boolean;
  maxRetries?: number;
  backoffMs?: number;
  fallbackAction?: () => Promise<void>;
  userMessage?: string;
}

export class NetworkError extends Error {
  readonly type = ErrorType.Network;
  constructor(message: string, public readonly originalError?: Error) {
    super(message);
    this.name = "NetworkError";
  }
}

export class SdkError extends Error {
  readonly type = ErrorType.Sdk;
  constructor(message: string, public readonly originalError?: Error) {
    super(message);
    this.name = "SdkError";
  }
}

export class UserError extends Error {
  readonly type = ErrorType.User;
  constructor(message: string, public readonly originalError?: Error) {
    super(message);
    this.name = "UserError";
  }
}

export class SystemError extends Error {
  readonly type = ErrorType.System;
  constructor(message: string, public readonly originalError?: Error) {
    super(message);
    this.name = "SystemError";
  }
}

export class ErrorHandler {
  private recoveryStrategies = new Map<ErrorType, RecoveryStrategy>();
  private userMessages = new Map<string, string>();

  constructor(private logger: Logger) {
    this.setupDefaultStrategies();
    this.setupUserMessages();
  }

  private setupDefaultStrategies(): void {
    this.recoveryStrategies.set(ErrorType.Network, {
      shouldRetry: true,
      maxRetries: 3,
      backoffMs: 2000,
      userMessage: "Network connection issue. Please try again."
    });

    this.recoveryStrategies.set(ErrorType.Sdk, {
      shouldRetry: true,
      maxRetries: 2,
      backoffMs: 5000,
      userMessage: "Wallet service temporarily unavailable. Please try again."
    });

    this.recoveryStrategies.set(ErrorType.User, {
      shouldRetry: false,
      userMessage: "Please check your input and try again."
    });

    this.recoveryStrategies.set(ErrorType.System, {
      shouldRetry: false,
      userMessage: "System error occurred. Please contact support if this persists."
    });
  }

  private setupUserMessages(): void {
    this.userMessages.set("transport error", "Network connection failed. Please check your internet connection.");
    this.userMessages.set("insufficient_balance", "Insufficient balance to complete this transaction.");
    this.userMessages.set("incorrect_payment_details", "Payment details are incorrect. Please verify and try again.");
    this.userMessages.set("payment_timeout", "Payment timed out. Please try again.");
    this.userMessages.set("no_route", "No route found for this payment. Please try again later.");
    this.userMessages.set("invalid_invoice", "Invalid payment request. Please check and try again.");
    this.userMessages.set("invoice_expired", "Payment request has expired. Please request a new one.");
    this.userMessages.set("already_paid", "This payment has already been completed.");
    this.userMessages.set("amount_out_of_range", "Payment amount is outside allowed limits.");
    this.userMessages.set("invalid_network", "Invalid network configuration.");
    this.userMessages.set("connection_failed", "Failed to connect to wallet service. Please try again.");
    this.userMessages.set("mnemonic_invalid", "Invalid backup phrase. Please check your words and try again.");
    this.userMessages.set("dns_error", "Network connectivity issue. Please check your internet connection.");
  }

  async handleError(
    error: Error, 
    context: string, 
    userId?: string,
    metadata?: Record<string, any>
  ): Promise<ErrorContext> {
    const errorId = randomUUID();
    const errorType = this.classifyError(error);
    const severity = this.determineSeverity(errorType, error);
    const originalMessage = error.message;

    const errorContext: ErrorContext = {
      errorId,
      errorType,
      severity,
      userId,
      operation: context,
      originalMessage,
      timestamp: Date.now(),
      stack: error.stack,
      metadata
    };

    this.logger.error({
      errorId,
      errorType,
      severity,
      message: originalMessage,
      operation: context,
      userId,
      stack: error.stack,
      metadata
    });

    await this.applyRecoveryStrategy(errorType, error, errorContext);
    
    return errorContext;
  }

  classifyError(error: Error): ErrorType {
    if (error instanceof NetworkError) return ErrorType.Network;
    if (error instanceof SdkError) return ErrorType.Sdk;
    if (error instanceof UserError) return ErrorType.User;
    if (error instanceof SystemError) return ErrorType.System;

    const message = error.message.toLowerCase();

    if (message.includes("transport error") ||
        message.includes("dns error") ||
        message.includes("os error 104") ||
        (message.includes("network") && !message.includes("database"))) {
      return ErrorType.Network;
    }

    if (message.includes("sdk") ||
        message.includes("wallet") ||
        message.includes("lightning") ||
        message.includes("payment") ||
        message.includes("invoice") ||
        message.includes("swap") ||
        message.includes("channel")) {
      return ErrorType.Sdk;
    }

    if (message.includes("invalid") ||
        message.includes("insufficient") ||
        message.includes("incorrect") ||
        message.includes("expired") ||
        message.includes("mnemonic") ||
        message.includes("amount") ||
        message.includes("limit")) {
      return ErrorType.User;
    }

    if (message.includes("database") ||
        message.includes("connection lost") ||
        message.includes("system") ||
        message.includes("internal") ||
        message.includes("server")) {
      return ErrorType.System;
    }

    return ErrorType.System;
  }

  private determineSeverity(errorType: ErrorType, error: Error): ErrorSeverity {
    const message = error.message.toLowerCase();

    if (message.includes("critical") || 
        message.includes("fatal") ||
        message.includes("corrupt")) {
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

  private async applyRecoveryStrategy(
    errorType: ErrorType, 
    error: Error, 
    context: ErrorContext
  ): Promise<void> {
    const strategy = this.recoveryStrategies.get(errorType);
    if (!strategy) return;

    if (strategy.fallbackAction) {
      try {
        await strategy.fallbackAction();
      } catch (fallbackError) {
        this.logger.warn(`Fallback action failed for ${context.errorId}:`, fallbackError.message);
      }
    }
  }

  getRecoveryStrategy(errorType: ErrorType): RecoveryStrategy | undefined {
    return this.recoveryStrategies.get(errorType);
  }

  getUserFriendlyMessage(error: Error): string {
    const message = error.message.toLowerCase();

    for (const [key, userMessage] of this.userMessages.entries()) {
      if (message.includes(key)) {
        return userMessage;
      }
    }

    const errorType = this.classifyError(error);
    const strategy = this.recoveryStrategies.get(errorType);
    return strategy?.userMessage || "An unexpected error occurred. Please try again.";
  }

  extractInnerMessage(content: string): string | null {
    const innerMessageRegex = /message:\s*"([^"]+)"/;
    const causedByRegex = /Caused by:\s*(.+)/;
    const jsonErrorRegex = /JSON\(Error\("([^"]+)"/;

    return innerMessageRegex.exec(content)?.[1] ||
           causedByRegex.exec(content)?.[1] ||
           jsonErrorRegex.exec(content)?.[1] ||
           null;
  }

  setCustomRecoveryStrategy(errorType: ErrorType, strategy: RecoveryStrategy): void {
    this.recoveryStrategies.set(errorType, strategy);
  }

  setCustomUserMessage(errorKey: string, message: string): void {
    this.userMessages.set(errorKey, message);
  }
}