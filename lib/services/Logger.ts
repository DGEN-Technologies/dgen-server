import { Logger as ILogger } from "./interfaces";
import pino from "pino";
import { randomUUID } from "crypto";

export class Logger implements ILogger {
  private pinoInstance = pino.default({
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => {
        if (!object.correlationId) {
          object.correlationId = randomUUID();
        }
        return object;
      }
    },
    timestamp: pino.stdTimeFunctions.isoTime
  });

  public info(message: string | object, ...args: any[]): void {
    if (typeof message === 'object') {
      this.pinoInstance.info(message);
    } else {
      this.pinoInstance.info(args.length > 0 ? { message, details: args } : message);
    }
  }

  public warn(message: string | object, ...args: any[]): void {
    if (typeof message === 'object') {
      this.pinoInstance.warn(message);
    } else {
      this.pinoInstance.warn(args.length > 0 ? { message, details: args } : message);
    }
  }

  public error(message: string | object, ...args: any[]): void {
    if (typeof message === 'object') {
      this.pinoInstance.error(message);
    } else {
      this.pinoInstance.error(args.length > 0 ? { message, details: args } : message);
    }
  }

  public debug(message: string | object, ...args: any[]): void {
    if (typeof message === 'object') {
      this.pinoInstance.debug(message);
    } else {
      this.pinoInstance.debug(args.length > 0 ? { message, details: args } : message);
    }
  }
}