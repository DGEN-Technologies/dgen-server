import { validateConfiguration } from './validation/ConfigValidator';

let _config: any = null;

export function loadConfig(): any {
  if (_config) return _config;
  
  validateConfiguration();

  const env = process.env.NODE_ENV || 'development';
  
  switch (env) {
    case 'production':
      _config = require('../config.production.ts').default;
      break;
    case 'test':
      _config = {
        url: process.env.URL || "http://localhost:3119",
        archive: "redis://localhost:6379",
        db: "redis://localhost:6379",
        arc2: "redis://localhost:6379",
        jwt: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        bitcoin: {
          host: "localhost",
          wallet: "test",
          user: "test", 
          password: "test",
          network: "regtest",
          port: 18443,
        },
        liquid: {
          host: "localhost",
          wallet: "test",
          user: "test",
          password: "test", 
          network: "regtest",
          port: 18884,
          btc: "5ac9f65c0efcc4775e0baec4ec03abdde22473cd3cf33c0419ca290e0751b225"
        },
        lightning: "/tmp/lightning-rpc",
        lightningb: "/tmp/lightning-rpc-b",
        fee: 0.001,
        adminpass: "test-admin-password",
        support: "test@example.com",
        mintUrl: "http://localhost:3338",
        port: 3119,
        redis: {
          maxConnections: 3,
          connectionTimeout: 3000,
          lazyConnect: true,
          retryDelayOnFailover: 100,
          enableReadyCheck: true,
          maxRetriesPerRequest: 2
        },
        cors: {
          allowedOrigins: ["http://localhost:5173"]
        },
        security: {
          enforceHTTPS: false,
          trustProxy: false,
          sessionSecret: "test-session-secret"
        }
      };
      break;
    default:
      _config = require('../config.ts').default;
      break;
  }
  
  return _config;
}

export function getConfig(): any {
  return loadConfig();
}