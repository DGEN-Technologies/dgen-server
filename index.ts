import app from "./lib/app";
import { admin, auth, optional } from "./lib/auth";
import { initializeServices } from "./lib/services";
import { BackgroundTaskManager } from "./lib/services/BackgroundTaskManager";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";

initializeServices();

// Ensure upload directory exists on startup
const uploadDir = join(process.cwd(), "data", "uploads");
if (!existsSync(uploadDir)) {
  mkdirSync(uploadDir, { recursive: true });
  console.log("Created upload directory:", uploadDir);
}

import { getLocations } from "./lib/locations";
// import nwc from "./lib/nwc"; // Nostr Wallet Connect disabled for MVP
// import { catchUp, check } from "./lib/payments"; // Payment operations handled by browser SDK
import { sendHeartbeat } from "./lib/sockets";
// import { startPaymentMonitoring } from "./lib/lightning"; // Payment monitoring handled by browser SDK

// import ecash from "./routes/ecash"; // Cashu disabled for MVP
import email from "./routes/email";
import info from "./routes/info";
import invoices from "./routes/invoices";
import items from "./routes/items";
import lnurl from "./routes/lnurl";
import locations from "./routes/locations";
// import nostr from "./routes/nostr"; // Nostr disabled for MVP
// import payments from "./routes/payments"; // Payment operations moved to browser SDK
import rates from "./routes/rates";
import shopify from "./routes/shopify";
import square from "./routes/square";
import users from "./routes/users";
import wallet from "./routes/wallet";
import health from "./routes/health";
import metrics from "./routes/metrics";
import webhook from "./routes/webhook";
import { websocketManager } from "./lib/websocket/WebSocketManager";

// Initialize background task manager
const backgroundTaskManager = BackgroundTaskManager.getInstance();

try {
  getLocations();
  
  // Start background tasks that don't need user context
  backgroundTaskManager.startTasks();
  
  // catchUp(); // Handled by browser SDK
  // nwc(); // Nostr Wallet Connect disabled for MVP
  // check(); // Handled by browser SDK
  
  // DON'T restore all sessions on startup - SDK instances should only be created when users connect
  // Sessions will be restored when users actually access their wallets
  // This prevents having multiple SDK instances running when users aren't active
} catch (e) {
  console.log(e);
}

// setTimeout(startPaymentMonitoring, 2000); // Payment monitoring handled by browser SDK
setInterval(sendHeartbeat, 2000);

app.get("/health", health.health);
app.get("/health/live", health.liveness);
app.get("/health/ready", health.readiness);

app.get("/metrics", metrics.metrics);

app.post("/email", email.send);

app.get("/fx", rates.fx);
app.get("/rate", rates.last);
app.get("/rates", rates.index);

app.get("/locations", locations.list);

app.get("/invoice/:id", invoices.get);
app.get("/invoices", auth, invoices.list);
app.post("/invoice", optional, invoices.create);
app.post("/invoice/:id", invoices.update);

app.get("/assetlinks.json", (_, res) => res.type("application/json").send("[]"));
// Nostr routes disabled for MVP
// app.get("/nostr.json", nostr.identities);
// app.get("/profile/:profile", nostr.profile);
// app.get("/:pubkey/count", nostr.count);
// app.get("/:pubkey/followers", nostr.followers);
// app.get("/:pubkey/follows", nostr.follows);
// app.get("/:pubkey/events", nostr.events);
// app.get("/event/:id", nostr.event);
// app.get("/event/:id/full", nostr.event);
// app.post("/event", auth, nostr.publish);
// app.post("/parseEvent", nostr.parse);
// app.get("/zaps/:id", nostr.zaps);
// app.post("/zap", auth, nostr.zap);
// app.post("/zapRequest", auth, nostr.zapRequest);
// app.get("/thread/:id", nostr.thread);

// app.get("/info", payments.info); // Handled by browser SDK
// Payment creation moved to browser SDK
// app.post("/payments", {
//   preValidation: auth.preValidation,
//   config: {
//     rateLimit: {
//       max: 10,
//       timeWindow: 60000,
//       keyGenerator: (req) => `payments:${(req.user as any)?.id || req.ip}`,
//       errorResponseBuilder: () => ({
//         statusCode: 429,
//         error: "Too Many Requests",
//         message: "Payment creation rate limit exceeded, retry in 1 minute"
//       })
//     }
//   }
// }, payments.create);
// Payment list/get moved to browser SDK
// app.get("/payments", auth, payments.list);
// app.get("/payments/:hash", optional, payments.get);
// app.get("/payment/:hash", optional, payments.get); // Alias for UI compatibility
// app.post("/parse", auth, payments.parse); // Handled by browser SDK
// Fund management moved to browser SDK
// app.get("/fund/:id", payments.fund);
// app.get("/fund/:name/withdraw", auth, payments.withdraw);
// app.get("/fund/:name/managers", payments.managers);
// app.post("/fund/managers", auth, payments.addManager);
// app.post("/fund/:name/managers/delete", auth, payments.deleteManager);
// Authorization operations moved to browser SDK
// app.post("/authorize", auth, payments.authorize);
// app.post("/take", auth, payments.take);
// app.post("/print", auth, payments.print);
// Send payments moved to browser SDK
// app.post("/send/:lnaddress/:amount", {
//   preValidation: auth.preValidation,
//   config: {
//     rateLimit: {
//       max: 5,
//       timeWindow: 60000,
//       keyGenerator: (req) => `send:${(req.user as any)?.id || req.ip}`,
//       errorResponseBuilder: () => ({
//         statusCode: 429,
//         error: "Too Many Requests",
//         message: "Send rate limit exceeded, retry in 1 minute"
//       })
//     }
//   }
// }, payments.lnaddress);
// app.post("/send", {
//   preValidation: auth.preValidation,
//   config: {
//     rateLimit: {
//       max: 5,
//       timeWindow: 60000,
//       keyGenerator: (req) => `send:${(req.user as any)?.id || req.ip}`,
//       errorResponseBuilder: () => ({
//         statusCode: 429,
//         error: "Too Many Requests",
//         message: "Send rate limit exceeded, retry in 1 minute"
//       })
//     }
//   }
// }, payments.internal);
// Gateway and invoice operations moved to browser SDK
// app.post("/gateway", payments.gateway);
// app.post("/replace", auth, payments.replace);
// app.get("/decode/:bolt11", payments.decode);
// app.post("/fetchinvoice", payments.fetchinvoice);

app.get("/square/connect", auth, square.connect);
app.get("/square/auth", auth, square.auth);
app.post("/square/payment", square.payment);

app.get("/encode", lnurl.encode);
app.get("/decode", lnurl.decode);
app.get("/lnurl/verify/:id", lnurl.verify);
app.get("/lnurlp/:username", lnurl.lnurlp);
app.get("/lnurl/:id", lnurl.lnurl);
app.get("/pay/:username", lnurl.pay);
app.get("/pay/:username/:amount", lnurl.pay);
// app.get("/lnurlw", lnurl.withdraw);

// Webhook endpoints for Breez Lightning Address integration
app.post("/api/v1/notify", webhook.notify); // Breez calls this
app.post("/api/webhook/respond", webhook.respond); // Browser responds here

// Freeze and confirm moved to browser SDK
// app.post("/freeze", payments.freeze);
// app.post("/confirm", payments.confirm);
// Bitcoin operations moved to browser SDK
// app.post("/bitcoin/fee", auth, payments.fee);
// app.post("/bitcoin/send", {
//   preValidation: auth.preValidation,
//   config: {
//     rateLimit: {
//       max: 5,
//       timeWindow: 60000,
//       keyGenerator: (req) => `send:${(req.user as any)?.id || req.ip}`,
//       errorResponseBuilder: () => ({
//         statusCode: 429,
//         error: "Too Many Requests",
//         message: "Send rate limit exceeded, retry in 1 minute"
//       })
//     }
//   }
// }, payments.send);

// Wallet management endpoints - Watch-only wallets (NO seed storage)
app.get("/wallet/info", auth, wallet.info); // Check if wallet exists
app.post("/wallet/create", auth, wallet.create); // Create watch-only wallet (NO seed storage)
app.get("/wallet/get-mnemonic", auth, wallet.getMnemonic); // DEPRECATED - Returns 403
app.post("/wallet/store-mnemonic", auth, wallet.storeMnemonic); // DEPRECATED - Returns 403

app.get("/users", auth, users.list);
app.get("/me", auth, users.me);
app.get("/credits", auth, users.credits);
app.get("/users/:key", users.get);
app.post("/register", users.create);
app.post("/disable2fa", auth, users.disable2fa);
app.post("/enable2fa", auth, users.enable2fa);
app.post("/2fa", auth, users.enable2fa); // Keep for backwards compatibility
app.post("/user", auth, users.update);
app.post("/reset", optional, users.reset);
app.post("/upload/:type", users.upload);

// Handle preflight requests for public files
app.options("/public/:filename", async (_, res) => {
  const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS || '*';
  res
    .header('Access-Control-Allow-Origin', allowedOrigins)
    .header('Access-Control-Allow-Methods', 'GET, OPTIONS')
    .header('Access-Control-Allow-Headers', 'Content-Type')
    .send();
});

// Serve uploaded files
app.get("/public/:filename", async (req, res) => {
  const { filename } = req.params as { filename: string };
  const path = require("path");
  let filePath = path.join(process.cwd(), "data", "uploads", filename);
  
  try {
    let file = Bun.file(filePath);
    let exists = await file.exists();
    
    // If file doesn't exist and it's a .webp file, serve the default image
    if (!exists && filename.endsWith('.webp')) {
      filePath = path.join(process.cwd(), "data", "uploads", "default.png");
      file = Bun.file(filePath);
      exists = await file.exists();
    }
    
    if (!exists) {
      return res.code(404).send("File not found");
    }
    
    // Determine content type based on extension
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg', 
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif'
    };
    
    const contentType = contentTypes[ext] || 'application/octet-stream';
    
    // CORS handling: Use wildcard in dev, specific origins in production
    const corsOrigins = process.env.CORS_ALLOWED_ORIGINS || '*';
    const origin = req.headers.origin;
    
    // If specific origins are configured and request has origin, validate it
    let allowOrigin = '*';
    if (corsOrigins !== '*' && origin) {
      const allowedList = corsOrigins.split(',').map(o => o.trim());
      if (allowedList.includes(origin)) {
        allowOrigin = origin;
      }
    } else if (corsOrigins === '*') {
      allowOrigin = '*';
    }
    
    // Read file and send with proper headers using Fastify methods
    const buffer = await file.arrayBuffer();
    res
      .header('Content-Type', contentType)
      .header('Cache-Control', 'public, max-age=3600')
      .header('Content-Length', buffer.byteLength)
      .header('Access-Control-Allow-Origin', allowOrigin)
      .header('Access-Control-Allow-Methods', 'GET')
      .header('Access-Control-Allow-Headers', 'Content-Type')
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(Buffer.from(buffer));
  } catch (error) {
    console.error("Error serving file:", error);
    res.code(500).send("Error serving file");
  }
});

app.get("/users/delete/:username", users.del);
app.post("/acl", users.acl);
app.post("/superuser", users.superuser);
app.get("/verify/:code", users.verify);
app.post("/request", auth, users.request);
app.post("/forgot", users.forgot);
app.post(
  "/login",
  {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "5 seconds",
        keyGenerator: (req) => req.headers["cf-connecting-ip"] as string, // IP-based rate limiting
      },
    },
  },
  users.login,
);
app.post("/printer", users.printer);
app.get("/challenge", users.challenge);
// app.post("/nostrAuth", users.nostrAuth); // Nostr auth disabled
app.get("/app/:pubkey", auth, users.app);
app.get("/apps", auth, users.apps);
app.post("/app", auth, users.updateApp);
app.post("/apps/delete", auth, users.deleteApp);

app.post("/pins", auth, users.addPin);
app.post("/pins/delete", auth, users.deletePin);

app.get("/trust", auth, users.trust);
app.post("/trust", auth, users.addTrust);
app.post("/trust/delete", auth, users.deleteTrust);

app.get("/subscriptions", auth, users.subscriptions);
app.post("/subscription", auth, users.subscription);
app.post("/subscription/delete", auth, users.deleteSubscription);
app.post("/password", auth, users.password);
app.post("/pin", auth, users.pin);
app.post("/otpsecret", auth, users.otpsecret);
app.get("/contacts/:limit?", auth, users.contacts);

app.get("/:id/items", items.list);
app.get("/items/:id", items.get);
app.post("/items", auth, items.create);
app.post("/items/delete", auth, items.del);
app.post("/items/sort", auth, items.sort);

app.post("/shopify/:id", shopify);

app.post("/hidepay", admin, users.hidepay);
app.post("/unlimit", admin, users.unlimit);
// Admin payment operations moved to browser SDK
// app.post("/admin/reconcile", admin, payments.reconcile);
// app.post("/admin/refund", admin, payments.adminRefund);

// app.get("/bolt12", fixBolt12); // TODO: Replace with Breez SDK BOLT12 management

// WebSocket manager will be registered in startServer function

// eCash/Cashu routes disabled for MVP
// app.get("/cash/:id/:version", ecash.get);
// app.post("/cash", ecash.save);
// app.post("/claim", auth, ecash.claim);
// app.post("/mint", auth, ecash.mint);
// app.post("/melt", auth, ecash.melt);
// app.post("/ecash/:id", ecash.receive);

// app.get("/replay/:index", (req, res) => {
//   replay(req.params.index);
//   res.send({});
// }); // TODO: Replace with Breez SDK payment history replay

app.post("/echo", (_, res) => {
  res.send({ received: true });
});

// Railway automatically sets PORT, always bind to 0.0.0.0 in production
const host: string = process.env["HOST"] || "0.0.0.0";
const port: number = parseInt(process.env["PORT"] || "3119");

// Start the server after WebSocket registration
async function startServer() {
  try {
    // Register WebSocket manager before starting server
    console.log('Registering WebSocket manager...');
    await websocketManager.register(app);
    console.log('WebSocket manager registered');
    
    // In development, always use HTTP (Vite will handle HTTPS)
    // In production, use a reverse proxy (Caddy/nginx) for SSL
    await app.listen({ host, port });
    console.log(`DGEN Server running on http://${host}:${port}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`WebSocket endpoint: ws://${host}:${port}/ws`);
    
    // Verify WebSocket is accessible
    if (process.env.NODE_ENV === 'production') {
      console.log('Production mode - WebSocket will be accessible at wss://[domain]/ws');
    }
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

startServer();

const logerr = (e: Error) => console.log(e);
process.on("unhandledRejection", logerr);
process.on("uncaughtException", logerr);

process.on("SIGINT", async () => {
  console.log("Gracefully shutting down...");
  try {
    await backgroundTaskManager.stopTasks();
    const { getServiceInjector } = await import("./lib/services");
    await getServiceInjector().disconnect();
    await websocketManager.shutdown();
    console.log("Services disconnected successfully");
  } catch (e) {
    console.error("Error during shutdown:", e);
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Gracefully shutting down...");
  try {
    await backgroundTaskManager.stopTasks();
    const { getServiceInjector } = await import("./lib/services");
    await getServiceInjector().disconnect();
    await websocketManager.shutdown();
    console.log("Services disconnected successfully");
  } catch (e) {
    console.error("Error during shutdown:", e);
  }
  process.exit(0);
});
