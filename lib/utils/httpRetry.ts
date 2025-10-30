/**
 * HTTP Retry Utility
 * Provides resilient HTTP requests with exponential backoff
 */

import got, { Options, HTTPError } from 'got';

interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  timeout?: number;
  throwOnAllFailed?: boolean;
}

/**
 * Make an HTTP request with automatic retry logic
 */
export async function httpWithRetry(
  url: string, 
  options?: Options,
  retryOptions?: RetryOptions
): Promise<any> {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    backoffMultiplier = 2,
    timeout = 5000,
    throwOnAllFailed = false
  } = retryOptions || {};

  let lastError: Error | null = null;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Add timeout to request options
      const requestOptions: Options = {
        ...options,
        timeout: {
          request: timeout
        },
        retry: {
          limit: 0 // Disable got's built-in retry, we handle it ourselves
        }
      };

      const response = await got(url, requestOptions);
      
      // Success - return the response
      if (response.body) {
        try {
          return JSON.parse(response.body as string);
        } catch {
          return response.body;
        }
      }
      return response;

    } catch (error: any) {
      lastError = error;
      
      // Log the error (but not too verbosely)
      const errorMsg = error.message || error.toString();
      const statusCode = error.response?.statusCode;
      
      // Don't retry on client errors (4xx) except 429 (rate limit)
      if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
        if (statusCode === 451 || statusCode === 403) {
          // Geo-blocked or forbidden - silently skip (common for regional APIs)
          // Only log if debugging
          if (process.env.DEBUG_HTTP) {
            console.log(`API blocked (${statusCode}): ${url.split('/')[2]}`);
          }
        } else {
          console.warn(`Client error ${statusCode} from ${url.split('/')[2]}, not retrying`);
        }
        break;
      }

      // Check if this is a server error worth retrying
      const isRetryable = 
        statusCode === 429 || // Rate limited
        statusCode === 502 || // Bad Gateway
        statusCode === 503 || // Service Unavailable
        statusCode === 504 || // Gateway Timeout
        statusCode >= 500 ||  // Any server error
        errorMsg.includes('ETIMEDOUT') ||
        errorMsg.includes('ECONNRESET') ||
        errorMsg.includes('ECONNREFUSED') ||
        errorMsg.includes('socket hang up');

      if (!isRetryable) {
        // Only log non-retryable errors if they're not common geo-blocks
        const domain = url.split('/')[2];
        if (!domain.includes('nobitex') && !domain.includes('.ir')) {
          console.warn(`Non-retryable error from ${domain}: ${errorMsg}`);
        }
        break;
      }

      // Don't wait after the last attempt
      if (attempt < maxRetries) {
        console.log(`Request to ${url.split('/')[2]} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
        
        // Wait with exponential backoff
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Increase delay for next attempt
        delay = Math.min(delay * backoffMultiplier, maxDelay);
      } else {
        // Only log if not a known geo-blocked domain
        const domain = url.split('/')[2];
        if (!domain.includes('nobitex') && !domain.includes('.ir')) {
          console.warn(`All ${maxRetries} attempts failed for ${domain}`);
        }
      }
    }
  }

  // All retries failed
  if (throwOnAllFailed && lastError) {
    throw lastError;
  }

  return null; // Return null instead of throwing
}

/**
 * Try multiple URL providers until one succeeds
 */
export async function tryMultipleProviders<T>(
  providers: Array<{
    name: string;
    url: string;
    transform?: (data: any) => T;
    options?: Options;
  }>,
  retryOptions?: RetryOptions
): Promise<{ data: T | null; provider: string | null }> {
  
  for (const provider of providers) {
    try {
      const response = await httpWithRetry(provider.url, provider.options, {
        ...retryOptions,
        maxRetries: 2, // Fewer retries per provider when trying multiple
        throwOnAllFailed: false
      });

      if (response) {
        const data = provider.transform ? provider.transform(response) : response;
        if (data) {
          return { data, provider: provider.name };
        }
      }
    } catch (error) {
      // Continue to next provider
      continue;
    }
  }

  return { data: null, provider: null };
}

/**
 * Simple GET request with retry
 */
export async function getWithRetry(url: string, retryOptions?: RetryOptions): Promise<any> {
  return httpWithRetry(url, { method: 'GET' }, retryOptions);
}

/**
 * Simple POST request with retry
 */
export async function postWithRetry(url: string, json: any, retryOptions?: RetryOptions): Promise<any> {
  return httpWithRetry(url, { method: 'POST', json }, retryOptions);
}