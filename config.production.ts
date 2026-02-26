export default {
  archive: process.env.ARCHIVE_REDIS_URL || (process.env.REDIS_PASSWORD ? `redis://:${process.env.REDIS_PASSWORD}@localhost:6380` : "redis://localhost:6380"),
  db: process.env.DATABASE_URL || process.env.REDIS_URL || (process.env.REDIS_PASSWORD ? `redis://:${process.env.REDIS_PASSWORD}@localhost:6379` : "redis://localhost:6379"),
  arc2: process.env.ARCHIVE2_REDIS_URL || (process.env.REDIS_PASSWORD ? `redis://:${process.env.REDIS_PASSWORD}@localhost:6379` : "redis://localhost:6379"),
  // nostr: process.env.NOSTR_WS_URL, // Nostr disabled for MVP
  // relays: [
  //   "wss://nostr-pub.wellorder.net",
  //   "wss://brb.io",
  //   "wss://nostr.v0l.io",
  //   "wss://relay.nostr.bg",
  //   "wss://nostr.orangepill.dev"
  // ],
  jwt: process.env.JWT_SECRET || (() => { throw new Error("JWT_SECRET environment variable is required in production") })(),
  bitcoin: {
    host: process.env.BITCOIN_HOST || "localhost",
    wallet: process.env.BITCOIN_WALLET || "dgen",
    user: process.env.BITCOIN_USER || "", 
    password: process.env.BITCOIN_PASSWORD || "",
    network: process.env.BITCOIN_NETWORK || "mainnet",
    port: parseInt(process.env.BITCOIN_PORT || "8332"),
  },
  liquid: {
    host: process.env.LIQUID_HOST || "localhost",
    wallet: process.env.LIQUID_WALLET || "dgen",
    user: process.env.LIQUID_USER || "",
    password: process.env.LIQUID_PASSWORD || "", 
    network: process.env.LIQUID_NETWORK || "mainnet",
    port: parseInt(process.env.LIQUID_PORT || "7040"),
    btc: process.env.LIQUID_BTC_ASSET_ID || "5ac9f65c0efcc4775e0baec4ec03abdde22473cd3cf33c0419ca290e0751b225"
  },
  lightning: process.env.LIGHTNING_SOCKET || "/tmp/lightning-rpc",
  lightningb: process.env.LIGHTNINGB_SOCKET || "/tmp/lightning-rpc",
  fee: parseFloat(process.env.FEE || "0.001"),
  adminpass: process.env.ADMIN_PASSWORD || (() => { throw new Error("ADMIN_PASSWORD environment variable is required in production") })(),
  support: process.env.SUPPORT_EMAIL || "support@dgentech.io",
  // nostrKey: process.env.NOSTR_PRIVATE_KEY || "", // Nostr disabled for MVP
  mintUrl: process.env.MINT_URL || "http://mint:3338",
  // square: { // Square disabled for MVP
  //   scopes: [],
  //   url: process.env.SQUARE_URL || "https://connect.squareup.com",
  //   appId: process.env.SQUARE_APP_ID,
  //   environment: process.env.SQUARE_ENVIRONMENT || "production"
  // },
  port: parseInt(process.env.PORT || "3119"),
  url: process.env.URL || (() => {
    // Railway provides RAILWAY_PUBLIC_DOMAIN automatically
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
      return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
    }
    const port = process.env.PORT || "3119";
    if (process.env.HTTPS === 'true') {
      return `https://localhost:${port}`;
    }
    throw new Error("Production requires either URL, RAILWAY_PUBLIC_DOMAIN, or HTTPS=true environment variable");
  })(),
  redis: {
    maxConnections: parseInt(process.env.REDIS_MAX_CONNECTIONS || "50"),
    connectionTimeout: parseInt(process.env.REDIS_CONNECTION_TIMEOUT || "5000"),
    lazyConnect: true,
    retryDelayOnFailover: 100,
    enableReadyCheck: true,
    maxRetriesPerRequest: 3
  },
  cors: {
    allowedOrigins: process.env.CORS_ALLOWED_ORIGINS ? 
      process.env.CORS_ALLOWED_ORIGINS.split(',').map(origin => origin.trim()) : 
      []
  },
  security: {
    enforceHTTPS: true,
    trustProxy: process.env.TRUST_PROXY === 'true',
    sessionSecret: process.env.SESSION_SECRET || (() => { throw new Error("SESSION_SECRET environment variable is required in production") })()
  }
};
