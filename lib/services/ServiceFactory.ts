import { ServiceFactory as IServiceFactory, Logger } from "./interfaces";
import { Logger as LoggerImpl } from "./Logger";

export class ServiceFactory implements IServiceFactory {
  private static _instance: ServiceFactory;

  private constructor() {}

  public static getInstance(): ServiceFactory {
    if (!ServiceFactory._instance) {
      ServiceFactory._instance = new ServiceFactory();
    }
    return ServiceFactory._instance;
  }

  public createLogger(): Logger {
    return new LoggerImpl();
  }
}