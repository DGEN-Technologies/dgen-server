const parseIntStrict = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const port = parseIntStrict(process.env.PORT, 3119);

export default {
  port,
  url: process.env.URL || `http://localhost:${port}`,
  archive: process.env.REDIS_PASSWORD
    ? `${process.env.REDIS_TLS === 'true' ? 'rediss' : 'redis'}://:${process.env.REDIS_PASSWORD}@localhost:6379`
    : (process.env.REDIS_TLS === 'true' ? 'rediss://localhost:6379' : 'redis://localhost:6379'),
  arc2: process.env.REDIS_PASSWORD
    ? `${process.env.REDIS_TLS === 'true' ? 'rediss' : 'redis'}://:${process.env.REDIS_PASSWORD}@localhost:6379`
    : (process.env.REDIS_TLS === 'true' ? 'rediss://localhost:6379' : 'redis://localhost:6379'),
  db: process.env.REDIS_PASSWORD
    ? `${process.env.REDIS_TLS === 'true' ? 'rediss' : 'redis'}://:${process.env.REDIS_PASSWORD}@localhost:6379`
    : (process.env.REDIS_TLS === 'true' ? 'rediss://localhost:6379' : 'redis://localhost:6379'),
  // nostr: "wss://relay.primal.net", // Nostr disabled for MVP
  // relays: [
  //   "ws://nostr:8080",
  //   "wss://nostr-pub.wellorder.net",
  //   "wss://brb.io",
  //   "wss://nostr.v0l.io",
  //   "wss://relay.nostr.bg",
  //   "wss://nostr.orangepill.dev"
  // ],
  jwt: process.env.JWT_SECRET || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  // Browser SDK handles all wallet operations
  fee: 0.001,
  adminpass: process.env.ADMIN_PASSWORD || "change-this-admin-password",
  support: process.env.SUPPORT_EMAIL || "support@dgentech.io",
  // nostrKey: process.env.NOSTR_PRIVATE_KEY || "", // Nostr disabled for MVP
  mintUrl: "http://mint:3338",
  // square: { // Square disabled for MVP
  //   scopes: [],
  //   url: "https://connect.squareup.com",
  //   appId: "test",
  //   environment: "sandbox"
  // },
  redis: {
    maxConnections: parseIntStrict(process.env.REDIS_MAX_CONNECTIONS, 5),
    connectionTimeout: parseIntStrict(process.env.REDIS_CONNECTION_TIMEOUT, 3000),
    lazyConnect: true,
    retryDelayOnFailover: 100,
    enableReadyCheck: true,
    maxRetriesPerRequest: 2
  },
  cors: {
    allowedOrigins: process.env.CORS_ALLOWED_ORIGINS ? 
      process.env.CORS_ALLOWED_ORIGINS.split(',').map(origin => origin.trim()) : 
      ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173', 'http://127.0.0.1:3000']
  },
  security: {
    enforceHTTPS: false,
    trustProxy: false,
    sessionSecret: process.env.SESSION_SECRET || process.env.JWT_SECRET || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  },
  esplora: {
    bitcoinUrl: process.env.BITCOIN_ESPLORA_URL || "https://blockstream.info/api",
    liquidUrl: process.env.LIQUID_ESPLORA_URL || "https://blockstream.info/liquid/api",
  }
};
