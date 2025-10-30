export default {
  archive: process.env.REDIS_PASSWORD ? `redis://:${process.env.REDIS_PASSWORD}@localhost:6380` : "redis://localhost:6380",
  db: process.env.REDIS_PASSWORD ? `redis://:${process.env.REDIS_PASSWORD}@localhost:6379` : "redis://localhost:6379",
  arc2: process.env.REDIS_PASSWORD ? `redis://:${process.env.REDIS_PASSWORD}@localhost:6379` : "redis://localhost:6379",
  jwt: "test-jwt-secret",
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
  breezApiKey: "test-breez-api-key",
  fee: 0.001,
  adminpass: "test-admin-password",
  support: "test@example.com",
  mintUrl: "http://localhost:3338",
  port: 3119,
  cors: {
    allowedOrigins: ["http://localhost:5173"]
  },
  redis: {
    maxConnections: parseInt(process.env.REDIS_MAX_CONNECTIONS || "15"),
    connectionTimeout: parseInt(process.env.REDIS_CONNECTION_TIMEOUT || "2000"),
    lazyConnect: true,
    retryDelayOnFailover: 50,
    enableReadyCheck: false,
    maxRetriesPerRequest: 3
  }
};