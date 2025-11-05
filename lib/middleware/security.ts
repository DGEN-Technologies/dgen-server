/**
 * Security Middleware
 * Comprehensive security controls for the DGEN server
 */

import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Security Headers Middleware
 * Adds essential security headers to all responses
 */
export async function securityHeaders(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Prevent clickjacking
  reply.header('X-Frame-Options', 'DENY');

  // Prevent MIME type sniffing
  reply.header('X-Content-Type-Options', 'nosniff');

  // Enable XSS filter
  reply.header('X-XSS-Protection', '1; mode=block');

  // Referrer policy
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions policy (formerly Feature-Policy)
  reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  // Strict Transport Security (HSTS) - only in production with HTTPS
  if (process.env.NODE_ENV === 'production') {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

/**
 * Input Sanitization
 * Validates and sanitizes common input patterns
 */
export class InputValidator {
  // Username: alphanumeric, underscore, hyphen (3-30 chars)
  static username(input: string): { valid: boolean; sanitized: string; error?: string } {
    const sanitized = String(input || '').toLowerCase().trim();

    if (sanitized.length < 3 || sanitized.length > 30) {
      return { valid: false, sanitized, error: 'Username must be 3-30 characters' };
    }

    if (!/^[a-z0-9_-]+$/.test(sanitized)) {
      return { valid: false, sanitized, error: 'Username can only contain letters, numbers, underscore, and hyphen' };
    }

    return { valid: true, sanitized };
  }

  // Email validation
  static email(input: string): { valid: boolean; sanitized: string; error?: string } {
    const sanitized = String(input || '').toLowerCase().trim();

    // Basic email regex
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(sanitized)) {
      return { valid: false, sanitized, error: 'Invalid email format' };
    }

    if (sanitized.length > 255) {
      return { valid: false, sanitized, error: 'Email too long' };
    }

    return { valid: true, sanitized };
  }

  // Amount validation (cryptocurrency amounts)
  static amount(input: any): { valid: boolean; value: number; error?: string } {
    const num = Number(input);

    if (isNaN(num) || !isFinite(num)) {
      return { valid: false, value: 0, error: 'Invalid amount' };
    }

    if (num < 0) {
      return { valid: false, value: num, error: 'Amount cannot be negative' };
    }

    if (num > Number.MAX_SAFE_INTEGER) {
      return { valid: false, value: num, error: 'Amount too large' };
    }

    return { valid: true, value: num };
  }

  // Generic string sanitization
  static string(input: any, maxLength: number = 1000): { valid: boolean; sanitized: string; error?: string } {
    const str = String(input || '').trim();

    if (str.length > maxLength) {
      return { valid: false, sanitized: str, error: `String exceeds maximum length of ${maxLength}` };
    }

    // Remove potentially dangerous characters
    const sanitized = str
      .replace(/[<>]/g, '') // Remove angle brackets
      .replace(/javascript:/gi, '') // Remove javascript: protocol
      .replace(/on\w+=/gi, ''); // Remove inline event handlers

    return { valid: true, sanitized };
  }

  // URL validation
  static url(input: string): { valid: boolean; sanitized: string; error?: string } {
    const str = String(input || '').trim();

    try {
      const url = new URL(str);

      // Only allow http and https
      if (!['http:', 'https:'].includes(url.protocol)) {
        return { valid: false, sanitized: str, error: 'Only HTTP(S) URLs allowed' };
      }

      return { valid: true, sanitized: url.toString() };
    } catch {
      return { valid: false, sanitized: str, error: 'Invalid URL format' };
    }
  }
}

/**
 * Enhanced Rate Limiter
 * More sophisticated than the basic implementation
 */
export class EnhancedRateLimiter {
  private attempts: Map<string, { count: number; resetAt: number; locked: boolean }> = new Map();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly lockoutMs: number;

  constructor(
    maxAttempts: number = 10,
    windowMs: number = 60000, // 1 minute
    lockoutMs: number = 300000  // 5 minutes
  ) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.lockoutMs = lockoutMs;

    // Clean up old entries every minute
    setInterval(() => this.cleanup(), 60000);
  }

  check(identifier: string): { allowed: boolean; remaining: number; resetAt?: number } {
    const now = Date.now();
    const record = this.attempts.get(identifier);

    // No previous attempts
    if (!record) {
      this.attempts.set(identifier, {
        count: 1,
        resetAt: now + this.windowMs,
        locked: false
      });
      return { allowed: true, remaining: this.maxAttempts - 1 };
    }

    // Check if locked out
    if (record.locked && now < record.resetAt) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: record.resetAt
      };
    }

    // Reset window has passed
    if (now > record.resetAt) {
      record.count = 1;
      record.resetAt = now + this.windowMs;
      record.locked = false;
      this.attempts.set(identifier, record);
      return { allowed: true, remaining: this.maxAttempts - 1 };
    }

    // Increment count
    record.count++;

    // Lock if exceeded
    if (record.count > this.maxAttempts) {
      record.locked = true;
      record.resetAt = now + this.lockoutMs; // Extended lockout
      this.attempts.set(identifier, record);
      return {
        allowed: false,
        remaining: 0,
        resetAt: record.resetAt
      };
    }

    this.attempts.set(identifier, record);
    return {
      allowed: true,
      remaining: this.maxAttempts - record.count,
      resetAt: record.resetAt
    };
  }

  reset(identifier: string): void {
    this.attempts.delete(identifier);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.attempts.entries()) {
      if (now > record.resetAt) {
        this.attempts.delete(key);
      }
    }
  }
}

/**
 * Error Handler
 * Prevents information disclosure in error messages
 */
export function sanitizeError(error: any, isDevelopment: boolean = false): {
  message: string;
  statusCode: number;
  details?: any;
} {
  // Default error response
  const defaultError = {
    message: 'An error occurred',
    statusCode: 500
  };

  // In development, show more details
  if (isDevelopment) {
    return {
      message: error.message || defaultError.message,
      statusCode: error.statusCode || error.status || defaultError.statusCode,
      details: error.stack
    };
  }

  // In production, sanitize error messages
  const statusCode = error.statusCode || error.status || defaultError.statusCode;

  // Safe error messages for common status codes
  const safeMessages: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    422: 'Invalid Input',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    503: 'Service Unavailable'
  };

  return {
    message: safeMessages[statusCode] || defaultError.message,
    statusCode
  };
}

/**
 * CSRF Token Generator and Validator
 */
export class CSRFProtection {
  private tokens: Map<string, { token: string; expiresAt: number }> = new Map();
  private readonly tokenLifetime = 3600000; // 1 hour

  generateToken(sessionId: string): string {
    const token = this.randomToken();
    const expiresAt = Date.now() + this.tokenLifetime;

    this.tokens.set(sessionId, { token, expiresAt });

    // Cleanup expired tokens
    this.cleanup();

    return token;
  }

  validateToken(sessionId: string, token: string): boolean {
    const record = this.tokens.get(sessionId);

    if (!record) return false;

    const now = Date.now();

    // Token expired
    if (now > record.expiresAt) {
      this.tokens.delete(sessionId);
      return false;
    }

    // Token matches
    return record.token === token;
  }

  private randomToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.tokens.entries()) {
      if (now > record.expiresAt) {
        this.tokens.delete(key);
      }
    }
  }
}

// Singleton instances
export const loginRateLimiter = new EnhancedRateLimiter(10, 60000, 300000); // 10 attempts per minute, 5min lockout
export const apiRateLimiter = new EnhancedRateLimiter(30, 60000, 300000); // 30 requests per minute, 5min lockout
export const csrfProtection = new CSRFProtection();
