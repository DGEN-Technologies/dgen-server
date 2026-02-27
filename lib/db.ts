import { getConfig } from "./config-loader";
import { fail, sleep } from "./utils";
import { createClient, defineScript } from "redis";
import { warn, err } from "./logging";

const config = getConfig();

// Redis operation timeout to prevent hanging requests when Redis is disconnected
const REDIS_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Redis timeout: ${operation}`)),
      REDIS_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

const DEBIT = `
local balanceKey = KEYS[1]
local creditKey = KEYS[2]
local insufficientString = KEYS[3];
local amount = tonumber(ARGV[1])
local tip = tonumber(ARGV[2])
local fee = tonumber(ARGV[3])
local ourfee = tonumber(ARGV[4])
local frozen = tonumber(ARGV[5])

local balance = tonumber(redis.call('get', balanceKey) or '0')
local credit = tonumber(redis.call('get', creditKey) or '0')

local covered = math.min(credit, ourfee)
ourfee = ourfee - covered

if balance - frozen < amount + tip + fee + ourfee then
    return {err = insufficientString .. ' ⚡️' .. balance - frozen .. ' / ' .. amount + tip + fee + ourfee}
end

redis.call('decrby', creditKey, tostring(math.floor(covered)))
redis.call('decrby', balanceKey, tostring(math.floor(amount + tip + fee + ourfee)))

return ourfee
`;

const REVERSE = `
local paymentKey = KEYS[1]
local balanceKey = KEYS[2]
local creditKey = KEYS[3]
local hashKey = KEYS[4]
local paymentsKey = KEYS[5]
local pid = KEYS[6]

local total = tonumber(ARGV[1])
local credit = tonumber(ARGV[2])
local hash = ARGV[3]

if redis.call('exists', paymentKey) == 1 then
    redis.call('del', paymentKey)
    redis.call('srem', 'pending', hash)
    redis.call('incrby', balanceKey, total)
    redis.call('incrby', creditKey, credit)
    redis.call('del', hashKey)
    redis.call('lrem', paymentsKey, 0, pid)
    redis.call('lrem', 'payments', 0, pid)
    return pid
else
    error("Payment has already been reversed" .. paymentKey)
end
`;

const debit = defineScript({
  NUMBER_OF_KEYS: 3,
  SCRIPT: DEBIT,
  transformArguments: (...args) => args.map((a) => a.toString()),
});

const reverse = defineScript({
  NUMBER_OF_KEYS: 6,
  SCRIPT: REVERSE,
  transformArguments: (...args) => args.map((a) => a.toString()),
});

const redisOptions = {
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 50, 5000),
    connectTimeout: config.redis?.connectionTimeout || 5000,
  },
  ...(config.redis && {
    lazyConnect: config.redis.lazyConnect,
    retryDelayOnFailover: config.redis.retryDelayOnFailover,
    enableReadyCheck: config.redis.enableReadyCheck,
    maxRetriesPerRequest: config.redis.maxRetriesPerRequest
  })
};

export const db = createClient({
  url: config.db,
  scripts: { debit, reverse },
  ...redisOptions
});

export const archive = createClient({
  url: config.archive,
  ...redisOptions
});

export const arc2 = createClient({
  url: config.arc2,
  ...redisOptions
});

function createReconnectHandler(client: typeof db, name: string): () => Promise<void> {
  async function reconnect(): Promise<void> {
    try {
      if (!client.isOpen) {
        await client.connect();
      }
    } catch (e) {
      console.error(`Failed to connect to Redis ${name}, retrying...`, e);
      setTimeout(reconnect, 5000);
    }
  }
  return reconnect;
}

const dbReconnect = createReconnectHandler(db, "db");
const archiveReconnect = createReconnectHandler(archive, "archive");

dbReconnect();
archiveReconnect();

db.on("error", (e) => {
  if (e.message.startsWith("getaddr")) return;
  err("Redis error", e.message);
});

db.on("end", () => {
  warn("Redis connection ended, attempting reconnect...");
  setTimeout(dbReconnect, 1000);
});

archive.on("error", (e) => {
  if (e.message.startsWith("getaddr")) return;
  err("Redis archive error", e.message);
});

archive.on("end", () => {
  warn("Redis archive connection ended, attempting reconnect...");
  setTimeout(archiveReconnect, 1000);
});

export default db;

export async function g(k: string): Promise<any> {
  const v = await withTimeout(db.get(k), `get ${k}`);
  try {
    return JSON.parse(v);
  } catch (e) {
    return v;
  }
}

export function s(k: string, v: any): Promise<void> {
  if (k === "user:null" || k === "user:undefined") fail("null user");
  return withTimeout(db.set(k, JSON.stringify(v)), `set ${k}`).catch((error) => {
    err("redis write failed (s)", k, error?.message || error);
  });
}

export async function ga(k: string): Promise<any> {
  const v = await withTimeout(archive.get(k), `archive get ${k}`);
  try {
    return JSON.parse(v);
  } catch (e) {
    return v;
  }
}

export function sa(k: string, v: any): Promise<void> {
  if (k === "user:null" || k === "user:undefined") {
    warn("###### NULL USER #######");
    console.trace();
  }
  return withTimeout(
    archive.set(k, JSON.stringify(v)),
    `archive set ${k}`,
  ).catch((error) => {
    err("redis archive write failed (sa)", k, error?.message || error);
  });
}

const retries: Record<string, number> = {};

export async function t(k: string, f: (val: string | null, client: typeof db) => Promise<void>): Promise<void> {
  try {
    await withTimeout(db.watch(k), `watch ${k}`);
    await f(await withTimeout(db.get(k), `get ${k}`), db);
  } catch (e) {
    if (!e.message.includes("watch") && !e.message.startsWith("Redis timeout")) throw e;

    const r = retries[k] || 0;
    retries[k] = r + 1;

    if (r < 10) {
      await sleep(100);
      await t(k, f);
    } else {
      delete retries[k];
      fail("unable to obtain lock");
    }
  }

  delete retries[k];
}

// Safe Redis operation wrappers with timeout protection
// Use these instead of direct db.* calls to prevent hanging requests

export const safeDb = {
  // Set operations
  sMembers: (key: string) => withTimeout(db.sMembers(key), `sMembers ${key}`),
  sIsMember: (key: string, member: string) => withTimeout(db.sIsMember(key, member), `sIsMember ${key}`),
  sAdd: (key: string, ...members: string[]) => withTimeout(db.sAdd(key, members), `sAdd ${key}`),
  sRem: (key: string, ...members: string[]) => withTimeout(db.sRem(key, members), `sRem ${key}`),

  // List operations
  lRange: (key: string, start: number, stop: number) => withTimeout(db.lRange(key, start, stop), `lRange ${key}`),
  lLen: (key: string) => withTimeout(db.lLen(key), `lLen ${key}`),

  // Key operations
  get: (key: string) => withTimeout(db.get(key), `get ${key}`),
  exists: (key: string) => withTimeout(db.exists(key), `exists ${key}`),
  del: (key: string, ...keys: string[]) =>
    withTimeout(db.del(key, ...keys), `del ${key}`),
  set: (key: string, value: string, options?: any) => withTimeout(db.set(key, value, options), `set ${key}`),
  setEx: (key: string, ttlSeconds: number, value: string) =>
    withTimeout(db.setEx(key, ttlSeconds, value), `setEx ${key}`),

  // Hash operations
  hSet(key: string, field: string | Record<string, string>, value?: string) {
    const operation = typeof field === "string" ? db.hSet(key, field, value!) : db.hSet(key, field);
    return withTimeout(operation, `hSet ${key}`);
  },
  hGet: (key: string, field: string) => withTimeout(db.hGet(key, field), `hGet ${key}`),

  // Health check
  ping: () => withTimeout(db.ping(), "ping"),
  info: (section?: string) => withTimeout(db.info(section), `info ${section || "all"}`),
};
