import { ServiceInjectorInterface, Logger } from "./interfaces";
import { RefundService } from "./RefundService";

export class ServiceInjector implements ServiceInjectorInterface {
  private static _instance: ServiceInjector;
  private services: Map<string, any> = new Map();
  private _logger?: Logger;
  private _refundService?: RefundService;

  private constructor() {}

  public static getInstance(): ServiceInjector {
    if (!ServiceInjector._instance) {
      ServiceInjector._instance = new ServiceInjector();
    }
    return ServiceInjector._instance;
  }

  public registerService<T>(name: string, service: T): void {
    this.services.set(name, service);

    switch (name) {
      case 'logger':
        this._logger = service as Logger;
        break;
    }
  }

  public getService<T>(name: string): T {
    const service = this.services.get(name);
    if (!service) {
      throw new Error(`Service '${name}' not registered`);
    }
    return service as T;
  }

  public getLogger(): Logger {
    if (!this._logger) {
      throw new Error('Logger not registered');
    }
    return this._logger;
  }

  public async disconnect(): Promise<void> {
    try {
      this.services.clear();
      this._logger = undefined;
    } catch (error) {
      const logger = this._logger;
      if (logger) {
        logger.error('Error during ServiceInjector cleanup:', error);
      }
      throw error;
    }
  }
}