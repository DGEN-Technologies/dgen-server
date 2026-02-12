import { getConfig } from "./config-loader";
import { enforceHTTPS } from "./validation/ConfigValidator";
import cors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyProxy from "@fastify/http-proxy";
import fastifyMultipart from "@fastify/multipart";
import fastifyPassport from "@fastify/passport";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifySecureSession from "@fastify/secure-session";
import fastify from "fastify";
import pino from "pino";


import { jwtStrategy } from "./auth";
import { setupLoggingMiddleware } from "./logging/middleware";
import { setupMetricsMiddleware } from "./monitoring/middleware";
import { securityHeaders } from "./middleware/security";

const config = getConfig();

const app = fastify({
  logger: true,
  disableRequestLogging: true,
  maxParamLength: 500,
  trustProxy: config.security?.trustProxy ?? false,
});

const reqLogger = pino(pino.destination("req"));
const resLogger = pino(pino.destination("res"));
enforceHTTPS();

const helmetOptions: any = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "ws:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"]
    }
  },
  hsts: config.security?.enforceHTTPS ? {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  } : false,
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" }
};

if (process.env.NODE_ENV === 'production') {
  helmetOptions.forceHTTPS = true;
  helmetOptions.noCache = false;
  helmetOptions.contentSecurityPolicy.directives.upgradeInsecureRequests = [];
}

app.register(fastifyHelmet, helmetOptions);

if (config.security?.trustProxy) {
  app.addHook('onRequest', async (req) => {
    if (req.headers['x-forwarded-proto'] === 'http' && config.security?.enforceHTTPS) {
      throw new Error('HTTPS required');
    }
  });
}

setupLoggingMiddleware(app);
setupMetricsMiddleware(app);

app.addHook("onRequest", securityHeaders);

// app.addHook("onRequest", async (req) => {
//   reqLogger.info({ url: req.raw.url, id: req.id });
// });
//

// Commented out detailed request logging to prevent Railway rate limiting
// app.addHook("preHandler", async (req) => {
//   const url = req.raw.url;
//   const ignore = [
//     "/login",
//     "/ws",
//     "/me",
//     "/confirm",
//     "/public",
//     "/rates",
//     "/challenge",
//     "/rate",
//     "/lnurlp",
//     "/subscriptions",
//     "/accounts",
//     "/contacts",
//     "/users",
//   ];
//   if (ignore.some((path) => url.startsWith(path))) return;

//   reqLogger.info({
//     method: req.method,
//     url,
//     headers: req.headers,
//     query: req.query,
//     body: req.body,
//     user: (req.user as any)?.username,
//     id: req.id,
//   });
// });

// Simplified response logging to reduce log volume
app.addHook("onResponse", async (req, reply) => {
  // Only log errors and slow requests (>1s)
  if (reply.raw.statusCode >= 400 || reply.elapsedTime > 1000) {
    const rawCookies = req.raw.headers.cookie || "";

    const cookies: any = rawCookies.split(";").reduce((acc, cookie) => {
      const [key, value] = cookie.split("=").map((s) => s.trim());
      if (key && value) acc[key] = value;
      return acc;
    }, {});

    resLogger.info({
      id: req.id,
      url: req.raw.url,
      statusCode: reply.raw.statusCode,
      durationMs: reply.elapsedTime,
      username: cookies.username,
    });
  }
});

app.register(fastifyRateLimit, {
  allowList: (req) => {
    const url = req.raw.url || "";
    return url.startsWith("/public/");
  },
  max: 2000,
  timeWindow: 10000,
  keyGenerator: (req) => req.ip,
  errorResponseBuilder: () => {
    return {
      statusCode: 429,
      error: "Too Many Requests",
      message: "Rate limit exceeded, retry in 10 seconds",
    };
  },
});

app.register(fastifyRateLimit, {
  allowList: (req) => {
    const url = req.raw.url || "";
    const sensitiveEndpoints = ["/login", "/send", "/wallet/initialize", "/wallet/restore", "/wallet/show-mnemonic"];
    const matches = sensitiveEndpoints.some(endpoint => url.includes(endpoint));
    return !matches;
  },
  max: process.env.NODE_ENV === 'development' ? 300 : 200,
  timeWindow: process.env.NODE_ENV === 'development' ? 60000 : 120000,
  keyGenerator: (req) => {
    const userId = req.user?.id;
    if (userId) {
      return `user:${userId}`;
    }
    return `ip:${req.ip}`;
  },
  errorResponseBuilder: (req) => {
    const ip = req.ip;
    const ua = req.headers["user-agent"] || "unknown";
    const userId = req.user?.id || "anonymous";

    app.log.warn({
      event: "security_rate_limit_exceeded",
      userId,
      ip,
      userAgent: ua,
      url: req.raw.url,
      timestamp: new Date().toISOString(),
      message: `Rate limit hit for user ${userId} on ${req.raw.url}`
    });
    return {
      statusCode: 429,
      error: "Too Many Requests",
      message: process.env.NODE_ENV === 'development'
        ? "Rate limit exceeded. Please wait 1 minute before trying again."
        : "Rate limit exceeded for security. Please wait 2 minutes before trying again.",
      retryAfter: process.env.NODE_ENV === 'development' ? 60 : 120,
    };
  },
});

// Auth endpoints (/login, /register) are handled by the loginRateLimiter in routes/users.ts
// which provides 10 attempts per minute with a 5-minute lockout
// No need for an additional rate limiter here

// WebSocket handling is now done directly through WebSocketManager
// See lib/websocket/WebSocketManager.ts

app.register(fastifySecureSession, {
  key: Buffer.from(getConfig().jwt, "hex"),
});

app.register((fastifyPassport as any).initialize());
app.register((fastifyPassport as any).secureSession());

(fastifyPassport as any).use("jwt", jwtStrategy);

app.register(fastifyMultipart, { limits: { fileSize: 10 ** 7 } });

// Static files are handled by manual route in index.ts with proper CORS
// app.register(fastifyStatic, {
//   root: process.env.NODE_ENV === "production" 
//     ? path.join("/home/bun/app/data/uploads")
//     : path.resolve("./data/uploads"),
//   prefix: "/public/",
// });

await app.register(cors, {
  origin: (origin, cb) => {
    // Get allowed origins from config
    const config = getConfig();
    const allowedOrigins = config.cors?.allowedOrigins || [];
    
    // Debug logging only when explicitly enabled
    if (process.env.DEBUG_CORS === "true" && origin) {
      console.log(`CORS check - Origin: "${origin}", Allowed origins:`, allowedOrigins);
      console.log(`CORS_ALLOWED_ORIGINS env var: "${process.env.CORS_ALLOWED_ORIGINS}"`);
    }
    
    // Allow requests with no origin (like mobile apps or Postman)
    if (!origin) return cb(null, true);
    
    // In development, allow all origins
    if (process.env.NODE_ENV === 'development') {
      return cb(null, true);
    }
    
    // Check if origin is allowed - must match exactly
    if (allowedOrigins.length > 0 && allowedOrigins.includes(origin)) {
      cb(null, true);
    } else if (allowedOrigins.length === 0) {
      // If no origins specified, reject all in production
      console.warn(`CORS: No allowed origins configured, rejecting ${origin}`);
      cb(new Error('Not allowed by CORS - no origins configured'), false);
    } else {
      console.warn(`CORS: Origin ${origin} not in allowed list:`, allowedOrigins);
      cb(new Error('Not allowed by CORS'), false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Cache-Control']
});

app.setErrorHandler(async (error, request, reply) => {
  const { errorHandler } = await import('./errors/middleware');
  await errorHandler(error, request, reply);
});

app.setNotFoundHandler((_, reply) =>
  reply.code(404).type("text/html").send("Not Found"),
);

export default app;
