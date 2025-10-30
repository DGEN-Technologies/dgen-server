import store from "./store";
import jwt from "jsonwebtoken";
import { v4 } from "uuid";
import { err, warn, l } from "./logging";
import { fail, getUser } from "./utils";
import { ServiceInjector } from "./services/ServiceInjector";
import { connectionPool } from "./performance/ConnectionPool";
import { websocketManager } from "./websocket/WebSocketManager";

const code = 1000;
const all = {};
const subscriptions = [];
const users = {};
const paymentSubscriptions = new Map<string, Set<string>>();

// Helper to convert BigInt to string for JSON serialization
const safeBigIntConvert = (obj: any): any => {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(safeBigIntConvert);
  if (typeof obj === 'object') {
    const result: any = {};
    for (const key in obj) {
      result[key] = safeBigIntConvert(obj[key]);
    }
    return result;
  }
  return obj;
};

export const emit = (uid, type, data) => {
  // Use the WebSocketManager's emit function
  websocketManager.emit(uid, type, data);
  
  // Handle legacy subscription-based payment notifications
  const safeData = safeBigIntConvert(data);
  if (type === "payment" && safeData.amount > 0) {
    for (let i = subscriptions.length - 1; i >= 0; i--) {
      const s = subscriptions[i];
      if (s.invoice && s.invoice.id === safeData.iid && s.ws && s.ws.readyState === 1) {
        s.ws.send(JSON.stringify({ type, data: safeData }));
      }
    }
  }
};

export const broadcast = (type, data) => {
  // Use the WebSocketManager's broadcast function
  websocketManager.broadcast(type, data);
};

const track = async (ws, token) => {
  const { id } = ws;
  const { id: uid } = jwt.decode(token);

  if (!uid) fail("Invalid JWT token");
  const user = await getUser(uid);
  if (!user) fail(`User not found ${uid}`);

  if (!store.sockets[uid]) store.sockets[uid] = {};

  const existing = Object.keys(store.sockets[uid]);
  if (existing.length > 4) {
    const p = existing.find((sid) => sid !== uid);
    store.sockets[uid][p].close(code, "too many sockets");
  }

  store.sockets[uid][id] = ws;
  users[id] = uid;
  ws.user = user;

  // Payment tracking handled in browser
};

const setupPaymentTracking = async (uid: string, ws: any) => {
  // Payment tracking handled in browser
  return;
};

const emitToUser = (uid: string, type: string, data: any) => {
  if (!store.sockets[uid]) return;
  
  // Convert any BigInt values to strings for safe serialization
  const safeData = safeBigIntConvert(data);
  
  for (const id in store.sockets[uid]) {
    const ws = store.sockets[uid][id];
    try {
      ws.send(JSON.stringify({ type, data: safeData }));
    } catch (e) {
      err(`Failed to emit ${type} to ${uid}:`, e.message);
    }
  }
};

// Legacy WebSocket server on port 3120 disabled - WebSocket functionality is now integrated into the main server
// WebSocket handling is now done through WebSocketManager on the main port (3119)
// See lib/websocket/WebSocketManager.ts for the new implementation

export const sendHeartbeat = () => {
  // Update last heartbeat timestamp
  store.last = Date.now();
  
  // The WebSocketManager handles heartbeat internally
  // This function is kept for backward compatibility
};
