export interface Logger {
  info(message: string | object, ...args: any[]): void;
  warn(message: string | object, ...args: any[]): void;
  error(message: string | object, ...args: any[]): void;
  debug(message: string | object, ...args: any[]): void;
}

export interface ServiceFactory {
  createLogger(): Logger;
}

export interface LanguageBinding {
  connect(request: any): Promise<any>;
  defaultConfig(network: string, apiKey: string): any;
  disconnect(sdk: any): Promise<void>;
}

export interface ServiceInjectorInterface {
  getLogger(): Logger;

  registerService<T>(name: string, service: T): void;
  getService<T>(name: string): T;

  disconnect(): Promise<void>;
}