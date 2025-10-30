export { ServiceInjector } from "./ServiceInjector";
export { ServiceFactory } from "./ServiceFactory";
export { Logger } from "./Logger";
export { PaymentEventHandler } from "./PaymentEventHandler";
export * from "./interfaces";

import { ServiceInjector } from "./ServiceInjector";
import { ServiceFactory } from "./ServiceFactory";
import { PaymentEventHandler } from "./PaymentEventHandler";

let initialized = false;
let _serviceInjector: ServiceInjector | null = null;

export function initializeServices(): ServiceInjector {
  if (initialized && _serviceInjector) {
    return _serviceInjector;
  }

  const injector = ServiceInjector.getInstance();
  const factory = ServiceFactory.getInstance();

  const logger = factory.createLogger();

  injector.registerService('logger', logger);

  // Initialize payment event handler
  const paymentEventHandler = new PaymentEventHandler(injector);

  initialized = true;
  _serviceInjector = injector;
  return injector;
}

export function getServiceInjector(): ServiceInjector {
  if (!initialized || !_serviceInjector) {
    return initializeServices();
  }
  return _serviceInjector;
}