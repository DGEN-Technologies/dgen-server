import pino from "pino";

// Create a single logger instance for performance
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  }
});

// Helper to properly serialize messages including Error objects
const formatMessage = (...msgs: any[]): string => {
  return msgs.map(msg => {
    if (msg instanceof Error) {
      // Properly serialize Error objects with stack traces
      return `${msg.message}${msg.stack ? '\nStack: ' + msg.stack : ''}`;
    }
    if (typeof msg === 'object' && msg !== null) {
      try {
        return JSON.stringify(msg);
      } catch (e) {
        return String(msg);
      }
    }
    return String(msg);
  }).join(' ');
};

export const l = (...msgs: any[]) => logger.info(formatMessage(...msgs));
export const warn = (...msgs: any[]) => logger.warn(formatMessage(...msgs));
export const err = (...msgs: any[]) => logger.error(formatMessage(...msgs));

export const line = () => {
  const stack = new Error().stack;
  const stackLine = stack.split("\n")[1];
  const match = stackLine.match(/at\s+(.*):(\d+):(\d+)/);
  return `${match[1]}:${match[2]}`;
};
