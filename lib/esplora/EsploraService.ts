import { createHash } from "crypto";
import { db } from "../db";
import { BlockstreamAuth } from "./BlockstreamAuth";

interface EsploraConfig {
  bitcoinUrl: string;
  liquidUrl: string;
  breezLiquidUrl: string;
  breezApiKey?: string;
  breezApiKeyHeader?: string;
}

export class EsploraRateLimitError extends Error {
  public readonly statusCode = 429;
  constructor(message: string) {
    super(message);
    this.name = "EsploraRateLimitError";
  }
}

export class EsploraHttpError extends Error {
  public readonly statusCode: number;
  constructor(statusCode: number, statusText: string) {
    super(`HTTP ${statusCode}: ${statusText || "Unknown"}`);
    this.name = "EsploraHttpError";
    this.statusCode = statusCode;
  }
}

interface TxStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

interface Utxo {
  txid: string;
  vout: number;
  status: TxStatus;
  value: number;
}

interface EsploraTx {
  status?: TxStatus;
}

type Network = "bitcoin" | "liquid" | "testnet" | "liquidtestnet";

interface EndpointStats {
  calls: number;
  cacheHits: number;
  staleHits: number;
  deduped: number;
  upstreamCalls: number;
  rateLimited: number;
  errors: number;
  tipGatedHits: number;
}

// Cache TTLs in seconds (shorter for volatile data; longer for confirmed/stable data)
const CACHE_TTL = {
  TX_STATUS: 30,      // Transaction status (changes rarely after confirmation)
  TXS_LIST: 30,       // Address/scripthash tx lists
  UTXO: 15,           // UTXOs (more dynamic)
  UTXO_CONFIRMED: 60, // Confirmed-only UTXOs (more stable)
  TXS_LIST_CONFIRMED: 180, // Confirmed-only tx lists
  TIP_HEIGHT: 10,     // Block tip (updates frequently)
  TX_CONFIRMED: 300,  // Confirmed transactions (very stable)
  BLOCK_HEADER: 300,  // Block header (stable)
  SERVER_RECIPIENT: 300, // Breez server recipient (stable)
};

// Stale cache TTL multiplier to allow serving data during extended upstream issues.
const STALE_TTL_MULTIPLIER = 6;

// Cap in-flight deduped requests to avoid unbounded memory growth.
const MAX_INFLIGHT_ENTRIES = 200;
// Entries older than this are considered stuck and are evicted.
const MAX_INFLIGHT_AGE_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

// Single-flight tracking to prevent duplicate in-flight requests
const inFlightRequests = new Map<
  string,
  { promise: Promise<any>; startedAt: number }
>();

const TEXT_CACHE_KEY = "__dgen_text";
const hashCacheKeyPart = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const pruneInFlight = (): void => {
  const now = Date.now();
  for (const [key, value] of inFlightRequests.entries()) {
    if (now - value.startedAt > MAX_INFLIGHT_AGE_MS) {
      inFlightRequests.delete(key);
    }
  }

  if (inFlightRequests.size > MAX_INFLIGHT_ENTRIES) {
    console.warn(
      `[Esplora] In-flight map size ${inFlightRequests.size} exceeds ${MAX_INFLIGHT_ENTRIES}`
    );
  }
};

const trackInFlight = (cacheKey: string, promise: Promise<any>): void => {
  pruneInFlight();
  if (inFlightRequests.size >= MAX_INFLIGHT_ENTRIES) {
    console.warn(
      `[Esplora] Skipping in-flight tracking for ${cacheKey}; map at ${inFlightRequests.size}`
    );
    return;
  }
  inFlightRequests.set(cacheKey, { promise, startedAt: Date.now() });
};
const DEFAULT_MAX_ENDPOINT_STATS = 200;

const validateEsploraUrl = (value: string, label: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }

  if (parsed.protocol !== "https:") {
    const isLocal =
      parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (!isLocal) {
      throw new Error(`${label} must use https`);
    }
  }
};

export class EsploraService {
  private static instance: EsploraService | null = null;
  private config: EsploraConfig;
  private backoffByKey = new Map<
    string,
    { backoffUntil: number; consecutiveErrors: number }
  >();
  private auth?: BlockstreamAuth;
  private metrics = new Map<string, EndpointStats>();
  private maxEndpointStats: number;
  private tipGateScripthashUtxo: boolean;
  private tipGateTxs: boolean;

  private constructor() {
    // Reset module-level in-flight state on re-instantiation (tests/HMR).
    inFlightRequests.clear();

    this.config = {
      bitcoinUrl: process.env.BITCOIN_ESPLORA_URL || "https://blockstream.info/api",
      liquidUrl: process.env.LIQUID_ESPLORA_URL || "https://blockstream.info/liquid/api",
      breezLiquidUrl: process.env.LIQUID_BREEZ_URL || "https://lq1.breez.technology/liquid/api",
      breezApiKey: process.env.BREEZ_API_KEY?.trim() || undefined,
      breezApiKeyHeader: process.env.BREEZ_API_KEY_HEADER?.trim() || "X-API-KEY",
    };
    validateEsploraUrl(this.config.bitcoinUrl, "BITCOIN_ESPLORA_URL");
    validateEsploraUrl(this.config.liquidUrl, "LIQUID_ESPLORA_URL");
    validateEsploraUrl(this.config.breezLiquidUrl, "LIQUID_BREEZ_URL");

    const clientId = process.env.BLOCKSTREAM_CLIENT_ID?.trim();
    const clientSecret = process.env.BLOCKSTREAM_CLIENT_SECRET?.trim();
    if ((clientId && !clientSecret) || (!clientId && clientSecret)) {
      console.warn(
        "[EsploraService] Blockstream OAuth credentials partially configured; auth disabled"
      );
    }
    if (clientId && clientSecret) {
      const defaultTokenUrl =
        "https://login.blockstream.com/realms/blockstream-public/protocol/openid-connect/token";
      const tokenUrl = process.env.BLOCKSTREAM_TOKEN_URL?.trim() || defaultTokenUrl;

      // Warn if using default URL - credentials will be sent to Blockstream's public endpoint
      if (!process.env.BLOCKSTREAM_TOKEN_URL?.trim()) {
        console.warn(
          "[EsploraService] BLOCKSTREAM_TOKEN_URL not set; using default Blockstream public endpoint. " +
            "Set BLOCKSTREAM_TOKEN_URL explicitly if using custom OAuth provider."
        );
      }

      validateEsploraUrl(tokenUrl, "BLOCKSTREAM_TOKEN_URL");
      const scope = process.env.BLOCKSTREAM_SCOPE?.trim() || "openid";
      this.auth = new BlockstreamAuth(tokenUrl, clientId, clientSecret, scope);
    }

    this.tipGateScripthashUtxo = process.env.ESPLORA_TIP_GATE_SCRIPTHASH_UTXO !== "false";
    this.tipGateTxs = process.env.ESPLORA_TIP_GATE_TXS !== "false";

    const maxEndpointStatsEnv = Number.parseInt(
      process.env.ESPLORA_METRICS_MAX_ENDPOINTS || "",
      10
    );
    this.maxEndpointStats =
      Number.isFinite(maxEndpointStatsEnv) && maxEndpointStatsEnv > 0
        ? maxEndpointStatsEnv
        : DEFAULT_MAX_ENDPOINT_STATS;
  }

  /**
   * Extract a normalized stat key from a cache key.
   * This strips user-controlled data (address, txid, scripthash) to prevent
   * unbounded map growth. Result is just endpoint type + network.
   *
   * Example: "esplora:utxo:liquid:bc1q...address" -> "esplora:utxo:liquid"
   *
   * This ensures metrics/backoff maps have bounded size (~20-30 entries max).
   */
  private getStatKey(cacheKey: string): string {
    const parts = cacheKey.split(":");
    if (parts.length >= 3) {
      return `${parts[0]}:${parts[1]}:${parts[2]}`;
    }
    return cacheKey;
  }

  private bumpStat(key: string, field: keyof EndpointStats): void {
    const exists = this.metrics.has(key);
    if (!exists && this.metrics.size >= this.maxEndpointStats) {
      const oldestKey = this.metrics.keys().next().value;
      if (oldestKey) {
        this.metrics.delete(oldestKey);
      }
    }

    const current = this.metrics.get(key) || {
      calls: 0,
      cacheHits: 0,
      staleHits: 0,
      deduped: 0,
      upstreamCalls: 0,
      rateLimited: 0,
      errors: 0,
      tipGatedHits: 0,
    };
    current[field] += 1;
    if (exists) {
      this.metrics.delete(key);
    }
    this.metrics.set(key, current);
  }

  private getBackoffState(key: string): { backoffUntil: number; consecutiveErrors: number } {
    const existing = this.backoffByKey.get(key);
    if (existing) return existing;

    if (this.backoffByKey.size >= this.maxEndpointStats) {
      const oldestKey = this.backoffByKey.keys().next().value;
      if (oldestKey) {
        this.backoffByKey.delete(oldestKey);
      }
    }

    const state = { backoffUntil: 0, consecutiveErrors: 0 };
    this.backoffByKey.set(key, state);
    return state;
  }

  private isConfirmedOnlyUtxos(utxos: Utxo[]): boolean {
    return utxos.every((utxo) => utxo.status?.confirmed);
  }

  private isConfirmedOnlyTxs(txs: EsploraTx[]): boolean {
    return txs.every((tx) => tx.status?.confirmed);
  }

  private async getTipGateMarker(cacheKey: string): Promise<string | null> {
    try {
      const marker = await db.get(`${cacheKey}:tip`);
      return marker ?? null;
    } catch (error) {
      console.warn(`[Esplora] Tip gate marker read error for ${cacheKey}:`, error);
      return null;
    }
  }

  private async setTipGateMarker(cacheKey: string, tipHash: string, ttlSeconds: number): Promise<void> {
    try {
      await db.setEx(`${cacheKey}:tip`, ttlSeconds, tipHash);
    } catch (error) {
      console.warn(`[Esplora] Tip gate marker write error for ${cacheKey}:`, error);
    }
  }

  private async clearTipGateMarker(cacheKey: string): Promise<void> {
    try {
      await db.del(`${cacheKey}:tip`);
    } catch (error) {
      console.warn(`[Esplora] Tip gate marker delete error for ${cacheKey}:`, error);
    }
  }

  private shouldTipGate(cacheKey: string): boolean {
    if (cacheKey.startsWith("esplora:scripthash_utxo:")) {
      return this.tipGateScripthashUtxo;
    }

    if (cacheKey.startsWith("esplora:addr_txs:")) {
      return this.tipGateTxs;
    }

    if (cacheKey.startsWith("esplora:scripthash_txs:")) {
      return this.tipGateTxs;
    }

    if (cacheKey.startsWith("esplora:addr_txs_confirmed:")) {
      return this.tipGateTxs;
    }

    if (cacheKey.startsWith("esplora:scripthash_txs_confirmed:")) {
      return this.tipGateTxs;
    }

    return false;
  }

  private async getCachedTipHash(network: Network): Promise<string | null> {
    const cacheKey = `esplora:tiphash:${network}`;
    const cached = await this.getFromCache<string>(cacheKey);
    if (cached !== null) {
      return cached;
    }
    const stale = await this.getFromStaleCache<string>(cacheKey);
    return stale ?? null;
  }

  private async tryTipGate<T>(cacheKey: string, statKey: string): Promise<T | null> {
    if (!this.shouldTipGate(cacheKey)) {
      return null;
    }

    const staleData = await this.getFromStaleCache<T>(cacheKey);
    if (staleData === null) {
      return null;
    }

    const parts = cacheKey.split(":");
    const network = parts.length >= 3 ? (parts[2] as Network) : "liquid";
    const tipHash = await this.getCachedTipHash(network);
    const marker = await this.getTipGateMarker(cacheKey);

    if (!tipHash || !marker || tipHash !== marker) {
      return null;
    }

    if (Array.isArray(staleData)) {
      if (cacheKey.startsWith("esplora:scripthash_utxo:")) {
        if (!this.isConfirmedOnlyUtxos(staleData as Utxo[])) {
          return null;
        }
      } else if (!this.isConfirmedOnlyTxs(staleData as EsploraTx[])) {
        return null;
      }
    } else {
      return null;
    }

    this.bumpStat(statKey, "tipGatedHits");
    return staleData;
  }

  private async buildHeaders(
    accept: string,
    contentType?: string,
    useAuth: boolean = true
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "Accept": accept,
      "User-Agent": "DGEN-Server/1.0",
    };

    if (contentType) {
      headers["Content-Type"] = contentType;
    }

    if (useAuth && this.auth) {
      const token = await this.auth.getAccessToken();
      headers.Authorization = `Bearer ${token}`;
    }

    return headers;
  }

  private getBreezApiHeaders(): Record<string, string> | undefined {
    const apiKey = this.config.breezApiKey;
    if (!apiKey) return undefined;
    const headerName = this.config.breezApiKeyHeader || "X-API-KEY";
    const lower = headerName.toLowerCase();
    const value =
      lower === "authorization" && !apiKey.startsWith("Bearer ")
        ? `Bearer ${apiKey}`
        : apiKey;
    return { [headerName]: value };
  }

  private getLiquidRootUrl(network: Network = "liquid"): string {
    const base = this.getBaseUrl(network);
    return base.replace(/\/api\/?$/, "");
  }

  private getBreezLiquidRootUrl(network: Network = "liquid"): string {
    if (network !== "liquid" && network !== "liquidtestnet") {
      throw new Error("Breez endpoints only supported for Liquid networks");
    }
    const base = this.config.breezLiquidUrl;
    return base.replace(/\/+$/, "");
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number = REQUEST_TIMEOUT_MS
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public static getInstance(): EsploraService {
    if (!EsploraService.instance) {
      try {
        EsploraService.instance = new EsploraService();
      } catch (error) {
        EsploraService.instance = null;
        throw error;
      }
    }
    return EsploraService.instance;
  }

  private getBaseUrl(network: Network): string {
    switch (network) {
      case "bitcoin":
        return this.config.bitcoinUrl;
      case "liquid":
        return this.config.liquidUrl;
      case "testnet":
        {
          const parsed = new URL(this.config.bitcoinUrl);
          const path = parsed.pathname.replace(/\/+$/, "");
          if (!path.endsWith("/api")) {
            throw new Error("Bitcoin Esplora URL missing /api for testnet");
          }
          parsed.pathname = path.replace(/\/api$/, "/testnet/api");
          return parsed.toString();
        }
      case "liquidtestnet":
        {
          const parsed = new URL(this.config.liquidUrl);
          const path = parsed.pathname.replace(/\/+$/, "");
          if (!path.endsWith("/liquid/api")) {
            throw new Error(
              "Liquid Esplora URL missing /liquid/api for liquidtestnet"
            );
          }
          parsed.pathname = path.replace(
            /\/liquid\/api$/,
            "/liquidtestnet/api"
          );
          return parsed.toString();
        }
      default:
        return this.config.bitcoinUrl;
    }
  }

  async fetchWaterfalls(
    queryString: string | undefined,
    network: Network = "liquid",
    accept: string = "application/json"
  ): Promise<Response> {
    const base =
      network === "liquid" || network === "liquidtestnet"
        ? this.getBreezLiquidRootUrl(network).replace(/\/+$/, "")
        : this.getBaseUrl(network).replace(/\/+$/, "");
    const query = queryString ? `?${queryString}` : "";
    const url = `${base}/waterfalls/waterfalls${query}`;
    const useAuth = !(network === "liquid" || network === "liquidtestnet");
    const headers = await this.buildHeaders(accept, undefined, useAuth);
    return this.fetchWithTimeout(url, { headers });
  }

  async fetchLiquidWaterfallsV2(
    queryString: string | undefined,
    network: Network = "liquid",
    accept: string = "application/json"
  ): Promise<Response> {
    const base = this.getBreezLiquidRootUrl(network).replace(/\/+$/, "");
    const query = queryString ? `?${queryString}` : "";
    const url = `${base}/v2/waterfalls${query}`;
    const headers = await this.buildHeaders(accept, undefined, false);
    const breezHeaders = this.getBreezApiHeaders();
    if (breezHeaders) {
      Object.assign(headers, breezHeaders);
    }
    return this.fetchWithTimeout(url, { headers });
  }

  async getLiquidServerRecipient(
    network: Network = "liquid"
  ): Promise<any> {
    const base = this.getBreezLiquidRootUrl(network).replace(/\/+$/, "");
    const url = `${base}/v1/server_recipient`;
    const cacheKey = `esplora:server_recipient:${network}`;
    const breezHeaders = this.getBreezApiHeaders();
    return this.fetchWithRetry<any>(
      url,
      cacheKey,
      CACHE_TTL.SERVER_RECIPIENT,
      1,
      false,
      breezHeaders
    );
  }

  private async fetchWithRetry<T>(
    url: string,
    cacheKey: string,
    ttl: number,
    maxRetries: number = 3,
    useAuth: boolean = true,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const statKey = this.getStatKey(cacheKey);
    const backoffState = this.getBackoffState(statKey);
    this.bumpStat(statKey, "calls");

    // Check cache first
    const cachedData = await this.getFromCache<T>(cacheKey);
    if (cachedData !== null) {
      this.bumpStat(statKey, "cacheHits");
      return cachedData;
    }

    const tipGatedData = await this.tryTipGate<T>(cacheKey, statKey);
    if (tipGatedData !== null) {
      return tipGatedData;
    }

    // Check if we're in backoff period
    if (Date.now() < backoffState.backoffUntil) {
      const staleData = await this.getFromStaleCache<T>(cacheKey);
      if (staleData !== null) {
        console.log(`[Esplora] In backoff, returning stale data for ${cacheKey}`);
        this.bumpStat(statKey, "staleHits");
        return staleData;
      }
      throw new EsploraRateLimitError(
        `Rate limited, retry after ${Math.ceil((backoffState.backoffUntil - Date.now()) / 1000)}s`
      );
    }

    // Single-flight: Check if request is already in flight
    const existingRequest = inFlightRequests.get(cacheKey);
    if (existingRequest) {
      if (Date.now() - existingRequest.startedAt > MAX_INFLIGHT_AGE_MS) {
        inFlightRequests.delete(cacheKey);
      } else {
        console.log(`[Esplora] Deduplicating request for ${cacheKey}`);
        this.bumpStat(statKey, "deduped");
        return existingRequest.promise;
      }
    }

    // Create the request promise
    const requestPromise = this.executeRequest<T>(
      url,
      cacheKey,
      ttl,
      maxRetries,
      statKey,
      useAuth,
      extraHeaders
    );
    trackInFlight(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      return result;
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  }

  private async fetchTextWithRetry(
    url: string,
    cacheKey: string,
    ttl: number,
    maxRetries: number = 3,
    useAuth: boolean = true,
    extraHeaders?: Record<string, string>
  ): Promise<string> {
    const statKey = this.getStatKey(cacheKey);
    const backoffState = this.getBackoffState(statKey);
    this.bumpStat(statKey, "calls");

    // Check cache first
    const cachedData = await this.getFromCache<string>(cacheKey);
    if (cachedData !== null) {
      this.bumpStat(statKey, "cacheHits");
      return cachedData;
    }

    // Check if we're in backoff period
    if (Date.now() < backoffState.backoffUntil) {
      const staleData = await this.getFromStaleCache<string>(cacheKey);
      if (staleData !== null) {
        console.log(`[Esplora] In backoff, returning stale data for ${cacheKey}`);
        this.bumpStat(statKey, "staleHits");
        return staleData;
      }
      throw new EsploraRateLimitError(
        `Rate limited, retry after ${Math.ceil((backoffState.backoffUntil - Date.now()) / 1000)}s`
      );
    }

    // Single-flight: Check if request is already in flight
    const existingRequest = inFlightRequests.get(cacheKey);
    if (existingRequest) {
      if (Date.now() - existingRequest.startedAt > MAX_INFLIGHT_AGE_MS) {
        inFlightRequests.delete(cacheKey);
      } else {
        console.log(`[Esplora] Deduplicating request for ${cacheKey}`);
        this.bumpStat(statKey, "deduped");
        return existingRequest.promise;
      }
    }

    // Create the request promise
    const requestPromise = this.executeTextRequest(
      url,
      cacheKey,
      ttl,
      maxRetries,
      statKey,
      useAuth,
      extraHeaders
    );
    trackInFlight(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      return result;
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  }

  private async fetchBufferWithRetry(
    url: string,
    cacheKey: string,
    ttl: number,
    maxRetries: number = 3
  ): Promise<Uint8Array> {
    const statKey = this.getStatKey(cacheKey);
    const backoffState = this.getBackoffState(statKey);
    this.bumpStat(statKey, "calls");

    // Check cache first
    const cachedData = await this.getFromCache<number[]>(cacheKey);
    if (cachedData !== null) {
      this.bumpStat(statKey, "cacheHits");
      return Uint8Array.from(cachedData);
    }

    // Check if we're in backoff period
    if (Date.now() < backoffState.backoffUntil) {
      const staleData = await this.getFromStaleCache<number[]>(cacheKey);
      if (staleData !== null) {
        console.log(`[Esplora] In backoff, returning stale data for ${cacheKey}`);
        this.bumpStat(statKey, "staleHits");
        return Uint8Array.from(staleData);
      }
      throw new EsploraRateLimitError(
        `Rate limited, retry after ${Math.ceil((backoffState.backoffUntil - Date.now()) / 1000)}s`
      );
    }

    // Single-flight: Check if request is already in flight
    const existingRequest = inFlightRequests.get(cacheKey);
    if (existingRequest) {
      if (Date.now() - existingRequest.startedAt > MAX_INFLIGHT_AGE_MS) {
        inFlightRequests.delete(cacheKey);
      } else {
        console.log(`[Esplora] Deduplicating request for ${cacheKey}`);
        this.bumpStat(statKey, "deduped");
        return existingRequest.promise;
      }
    }

    // Create the request promise
    const requestPromise = this.executeBufferRequest(url, cacheKey, ttl, maxRetries, statKey);
    trackInFlight(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      return result;
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  }

  private async executeRequest<T>(
    url: string,
    cacheKey: string,
    ttl: number,
    maxRetries: number,
    statKey: string,
    useAuth: boolean,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    let lastError: Error | null = null;
    let retryDelay = 1000; // Start with 1 second
    const backoffState = this.getBackoffState(statKey);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const headers = await this.buildHeaders("application/json", undefined, useAuth);
        if (extraHeaders) {
          Object.assign(headers, extraHeaders);
        }

        this.bumpStat(statKey, "upstreamCalls");
        const response = await this.fetchWithTimeout(url, { headers });

        if (response.status === 429) {
          // Rate limited - apply exponential backoff with jitter
          backoffState.consecutiveErrors++;
          this.bumpStat(statKey, "rateLimited");
          const backoffTime = Math.min(
            Math.pow(2, backoffState.consecutiveErrors) * 1000 + Math.random() * 1000,
            60000 // Max 60 seconds
          );
          backoffState.backoffUntil = Date.now() + backoffTime;
          console.warn(`[Esplora] Rate limited (429), backing off for ${backoffTime}ms`);

          // Try to return cached data if available
          const staleData = await this.getFromStaleCache<T>(cacheKey);
          if (staleData !== null) {
            return staleData;
          }

          lastError = new EsploraRateLimitError(`Rate limited (429)`);
          await this.sleep(retryDelay + Math.random() * 500);
          retryDelay *= 2;
          continue;
        }

        if (!response.ok) {
          throw new EsploraHttpError(response.status, response.statusText);
        }

        const data = await response.json() as T;

        // Success - reset error counter and cache the result
        backoffState.consecutiveErrors = 0;
        await this.setCache(cacheKey, data, ttl);

        return data;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.bumpStat(statKey, "errors");
        console.warn(`[Esplora] Request failed (attempt ${attempt + 1}/${maxRetries}):`, lastError.message);

        if (attempt < maxRetries - 1) {
          await this.sleep(retryDelay + Math.random() * 500);
          retryDelay *= 2;
        }
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  private async executeBufferRequest(
    url: string,
    cacheKey: string,
    ttl: number,
    maxRetries: number,
    statKey: string,
    useAuth: boolean = true,
    extraHeaders?: Record<string, string>
  ): Promise<Uint8Array> {
    let lastError: Error | null = null;
    let retryDelay = 1000; // Start with 1 second
    const backoffState = this.getBackoffState(statKey);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const headers = await this.buildHeaders(
          "application/octet-stream",
          undefined,
          useAuth
        );
        if (extraHeaders) {
          Object.assign(headers, extraHeaders);
        }

        this.bumpStat(statKey, "upstreamCalls");
        const response = await this.fetchWithTimeout(url, { headers });

        if (response.status === 429) {
          // Rate limited - apply exponential backoff with jitter
          backoffState.consecutiveErrors++;
          this.bumpStat(statKey, "rateLimited");
          const backoffTime = Math.min(
            Math.pow(2, backoffState.consecutiveErrors) * 1000 + Math.random() * 1000,
            60000 // Max 60 seconds
          );
          backoffState.backoffUntil = Date.now() + backoffTime;
          console.warn(`[Esplora] Rate limited (429), backing off for ${backoffTime}ms`);

          // Try to return cached data if available
          const staleData = await this.getFromStaleCache<number[]>(cacheKey);
          if (staleData !== null) {
            return Uint8Array.from(staleData);
          }

          lastError = new EsploraRateLimitError(`Rate limited (429)`);
          await this.sleep(retryDelay + Math.random() * 500);
          retryDelay *= 2;
          continue;
        }

        if (!response.ok) {
          throw new EsploraHttpError(response.status, response.statusText);
        }

        const buffer = new Uint8Array(await response.arrayBuffer());

        // Success - reset error counter and cache the result
        backoffState.consecutiveErrors = 0;
        await this.setCache(cacheKey, Array.from(buffer), ttl);

        return buffer;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.bumpStat(statKey, "errors");
        console.warn(`[Esplora] Request failed (attempt ${attempt + 1}/${maxRetries}):`, lastError.message);

        if (attempt < maxRetries - 1) {
          await this.sleep(retryDelay + Math.random() * 500);
          retryDelay *= 2;
        }
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  private async executeTextRequest(
    url: string,
    cacheKey: string,
    ttl: number,
    maxRetries: number,
    statKey: string,
    useAuth: boolean,
    extraHeaders?: Record<string, string>
  ): Promise<string> {
    let lastError: Error | null = null;
    let retryDelay = 1000; // Start with 1 second
    const backoffState = this.getBackoffState(statKey);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const headers = await this.buildHeaders("text/plain", undefined, useAuth);
        if (extraHeaders) {
          Object.assign(headers, extraHeaders);
        }

        this.bumpStat(statKey, "upstreamCalls");
        const response = await this.fetchWithTimeout(url, { headers });

        if (response.status === 429) {
          // Rate limited - apply exponential backoff with jitter
          backoffState.consecutiveErrors++;
          this.bumpStat(statKey, "rateLimited");
          const backoffTime = Math.min(
            Math.pow(2, backoffState.consecutiveErrors) * 1000 + Math.random() * 1000,
            60000 // Max 60 seconds
          );
          backoffState.backoffUntil = Date.now() + backoffTime;
          console.warn(`[Esplora] Rate limited (429), backing off for ${backoffTime}ms`);

          // Try to return cached data if available
          const staleData = await this.getFromStaleCache<string>(cacheKey);
          if (staleData !== null) {
            return staleData;
          }

          lastError = new EsploraRateLimitError(`Rate limited (429)`);
          await this.sleep(retryDelay + Math.random() * 500);
          retryDelay *= 2;
          continue;
        }

        if (!response.ok) {
          throw new EsploraHttpError(response.status, response.statusText);
        }

        const data = await response.text();

        // Success - reset error counter and cache the result
        backoffState.consecutiveErrors = 0;
        await this.setCache(cacheKey, data, ttl);

        return data;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.bumpStat(statKey, "errors");
        console.warn(`[Esplora] Request failed (attempt ${attempt + 1}/${maxRetries}):`, lastError.message);

        if (attempt < maxRetries - 1) {
          await this.sleep(retryDelay + Math.random() * 500);
          retryDelay *= 2;
        }
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  private async getFromCache<T>(key: string): Promise<T | null> {
    try {
      const cached = await db.get(key);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed === "object") {
          if (TEXT_CACHE_KEY in parsed) {
            return (parsed as { __dgen_text: string })[TEXT_CACHE_KEY] as T;
          }
          if ("__text" in parsed) {
            return (parsed as { __text: string }).__text as T;
          }
        }
        return parsed as T;
      }
    } catch (error) {
      console.warn(`[Esplora] Cache read error for ${key}:`, error);
    }
    return null;
  }

  private async getFromStaleCache<T>(key: string): Promise<T | null> {
    try {
      const cached = await db.get(`${key}:stale`);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed === "object") {
          if (TEXT_CACHE_KEY in parsed) {
            return (parsed as { __dgen_text: string })[TEXT_CACHE_KEY] as T;
          }
          if ("__text" in parsed) {
            return (parsed as { __text: string }).__text as T;
          }
        }
        return parsed as T;
      }
    } catch (error) {
      console.warn(`[Esplora] Stale cache read error for ${key}:`, error);
    }
    return null;
  }

  private async setCache(key: string, data: any, ttlSeconds: number): Promise<void> {
    try {
      const payload =
        typeof data === "string"
          ? JSON.stringify({ [TEXT_CACHE_KEY]: data })
          : JSON.stringify(data);
      await db.setEx(key, ttlSeconds, payload);
      await db.setEx(
        `${key}:stale`,
        ttlSeconds * STALE_TTL_MULTIPLIER,
        payload
      );
    } catch (error) {
      console.warn(`[Esplora] Cache write error for ${key}:`, error);
    }
  }

  private async deleteCache(key: string): Promise<void> {
    try {
      await db.del(key, `${key}:stale`);
    } catch (error) {
      console.warn(`[Esplora] Cache delete error for ${key}:`, error);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get transaction status by txid
   */
  async getTxStatus(txid: string, network: Network = "liquid"): Promise<TxStatus> {
    const cacheKey = `esplora:tx:${network}:${hashCacheKeyPart(txid)}`;
    const url = `${this.getBaseUrl(network)}/tx/${txid}/status`;

    // Use longer TTL for confirmed transactions
    const cachedData = await this.getFromCache<TxStatus>(cacheKey);
    const ttl = cachedData?.confirmed ? CACHE_TTL.TX_CONFIRMED : CACHE_TTL.TX_STATUS;

    return this.fetchWithRetry<TxStatus>(url, cacheKey, ttl);
  }

  /**
   * Get full transaction details
   */
  async getTx(txid: string, network: Network = "liquid"): Promise<any> {
    const cacheKey = `esplora:txfull:${network}:${hashCacheKeyPart(txid)}`;
    const url = `${this.getBaseUrl(network)}/tx/${txid}`;

    return this.fetchWithRetry<any>(url, cacheKey, CACHE_TTL.TX_STATUS);
  }

  /**
   * Get raw transaction hex
   */
  async getTxHex(txid: string, network: Network = "liquid"): Promise<string> {
    const cacheKey = `esplora:txhex:${network}:${hashCacheKeyPart(txid)}`;
    const url = `${this.getBaseUrl(network)}/tx/${txid}/hex`;

    return this.fetchTextWithRetry(url, cacheKey, CACHE_TTL.TX_STATUS);
  }

  /**
   * Get raw transaction bytes
   */
  async getTxRaw(txid: string, network: Network = "liquid"): Promise<Uint8Array> {
    const cacheKey = `esplora:txraw:${network}:${hashCacheKeyPart(txid)}`;
    const url = `${this.getBaseUrl(network)}/tx/${txid}/raw`;

    return this.fetchBufferWithRetry(url, cacheKey, CACHE_TTL.TX_STATUS);
  }

  /**
   * Get UTXOs for an address
   */
  async getAddressUtxos(address: string, network: Network = "liquid"): Promise<Utxo[]> {
    const cacheKey = `esplora:utxo:${network}:${hashCacheKeyPart(address)}`;
    const url = `${this.getBaseUrl(network)}/address/${address}/utxo`;

    return this.fetchWithRetry<Utxo[]>(url, cacheKey, CACHE_TTL.UTXO);
  }

  /**
   * Get UTXOs for a scripthash
   */
  async getScripthashUtxos(scripthash: string, network: Network = "liquid"): Promise<Utxo[]> {
    const cacheKey = `esplora:scripthash_utxo:${network}:${hashCacheKeyPart(scripthash)}`;
    const url = `${this.getBaseUrl(network)}/scripthash/${scripthash}/utxo`;

    const utxos = await this.fetchWithRetry<Utxo[]>(url, cacheKey, CACHE_TTL.UTXO);

    if (this.isConfirmedOnlyUtxos(utxos)) {
      await this.setCache(cacheKey, utxos, CACHE_TTL.UTXO_CONFIRMED);
      const tipHash = await this.getCachedTipHash(network);
      if (tipHash) {
        const tipGateTtl = Math.max(CACHE_TTL.UTXO_CONFIRMED * STALE_TTL_MULTIPLIER, CACHE_TTL.UTXO_CONFIRMED);
        await this.setTipGateMarker(cacheKey, tipHash, tipGateTtl);
      }
    } else {
      await this.clearTipGateMarker(cacheKey);
    }

    return utxos;
  }

  /**
   * Get current block tip height
   */
  async getTipHeight(network: Network = "liquid"): Promise<number> {
    const cacheKey = `esplora:tip:${network}`;
    const url = `${this.getBaseUrl(network)}/blocks/tip/height`;

    const heightText = await this.fetchTextWithRetry(url, cacheKey, CACHE_TTL.TIP_HEIGHT);
    const height = Number.parseInt(heightText, 10);
    if (!Number.isFinite(height)) {
      await this.deleteCache(cacheKey);
      throw new Error(`Invalid tip height response: ${heightText}`);
    }
    return height;
  }

  /**
   * Get current block tip hash
   */
  async getTipHash(network: Network = "liquid"): Promise<string> {
    const cacheKey = `esplora:tiphash:${network}`;
    const url = `${this.getBaseUrl(network)}/blocks/tip/hash`;

    return this.fetchTextWithRetry(url, cacheKey, CACHE_TTL.TIP_HEIGHT);
  }

  /**
   * Get block hash by height
   */
  async getBlockHashByHeight(height: number, network: Network = "liquid"): Promise<string> {
    const cacheKey = `esplora:block_height:${network}:${height}`;
    const url = `${this.getBaseUrl(network)}/block-height/${height}`;

    return this.fetchTextWithRetry(url, cacheKey, CACHE_TTL.BLOCK_HEADER);
  }

  /**
   * Get address transaction history
   */
  async getAddressTxs(
    address: string,
    network: Network = "liquid",
    lastSeenTxid?: string
  ): Promise<any[]> {
    const addressKey = hashCacheKeyPart(address);
    const lastSeenKey = lastSeenTxid ? hashCacheKeyPart(lastSeenTxid) : null;
    const cacheKey = lastSeenKey
      ? `esplora:addr_txs:${network}:${addressKey}:${lastSeenKey}`
      : `esplora:addr_txs:${network}:${addressKey}`;
    let url = `${this.getBaseUrl(network)}/address/${address}/txs`;
    if (lastSeenTxid) {
      url += `/chain/${lastSeenTxid}`;
    }

    const txs = await this.fetchWithRetry<any[]>(url, cacheKey, CACHE_TTL.TXS_LIST);

    if (this.isConfirmedOnlyTxs(txs as EsploraTx[])) {
      await this.setCache(cacheKey, txs, CACHE_TTL.TXS_LIST_CONFIRMED);
      const tipHash = await this.getCachedTipHash(network);
      if (tipHash) {
        const tipGateTtl = Math.max(CACHE_TTL.TXS_LIST_CONFIRMED * STALE_TTL_MULTIPLIER, CACHE_TTL.TXS_LIST_CONFIRMED);
        await this.setTipGateMarker(cacheKey, tipHash, tipGateTtl);
      }
    } else {
      await this.clearTipGateMarker(cacheKey);
    }

    return txs;
  }

  /**
   * Get scripthash transaction history
   */
  async getScripthashTxs(
    scripthash: string,
    network: Network = "liquid",
    lastSeenTxid?: string
  ): Promise<any[]> {
    const scripthashKey = hashCacheKeyPart(scripthash);
    const lastSeenKey = lastSeenTxid ? hashCacheKeyPart(lastSeenTxid) : null;
    const cacheKey = lastSeenKey
      ? `esplora:scripthash_txs:${network}:${scripthashKey}:${lastSeenKey}`
      : `esplora:scripthash_txs:${network}:${scripthashKey}`;
    let url = `${this.getBaseUrl(network)}/scripthash/${scripthash}/txs`;
    if (lastSeenTxid) {
      url += `/chain/${lastSeenTxid}`;
    }

    const txs = await this.fetchWithRetry<any[]>(url, cacheKey, CACHE_TTL.TXS_LIST);

    if (this.isConfirmedOnlyTxs(txs as EsploraTx[])) {
      await this.setCache(cacheKey, txs, CACHE_TTL.TXS_LIST_CONFIRMED);
      const tipHash = await this.getCachedTipHash(network);
      if (tipHash) {
        const tipGateTtl = Math.max(CACHE_TTL.TXS_LIST_CONFIRMED * STALE_TTL_MULTIPLIER, CACHE_TTL.TXS_LIST_CONFIRMED);
        await this.setTipGateMarker(cacheKey, tipHash, tipGateTtl);
      }
    } else {
      await this.clearTipGateMarker(cacheKey);
    }

    return txs;
  }

  /**
   * Get confirmed transaction history for a scripthash
   */
  async getScripthashTxsConfirmed(
    scripthash: string,
    network: Network = "liquid"
  ): Promise<any[]> {
    const cacheKey = `esplora:scripthash_txs_confirmed:${network}:${hashCacheKeyPart(scripthash)}`;
    const url = `${this.getBaseUrl(network)}/scripthash/${scripthash}/txs/chain`;

    const txs = await this.fetchWithRetry<any[]>(url, cacheKey, CACHE_TTL.TXS_LIST_CONFIRMED);
    const tipHash = await this.getCachedTipHash(network);
    if (tipHash) {
      const tipGateTtl = Math.max(CACHE_TTL.TXS_LIST_CONFIRMED * STALE_TTL_MULTIPLIER, CACHE_TTL.TXS_LIST_CONFIRMED);
      await this.setTipGateMarker(cacheKey, tipHash, tipGateTtl);
    }
    return txs;
  }

  /**
   * Get mempool transaction history for a scripthash
   */
  async getScripthashTxsMempool(
    scripthash: string,
    network: Network = "liquid"
  ): Promise<any[]> {
    const cacheKey = `esplora:scripthash_txs_mempool:${network}:${hashCacheKeyPart(scripthash)}`;
    const url = `${this.getBaseUrl(network)}/scripthash/${scripthash}/txs/mempool`;

    return this.fetchWithRetry<any[]>(url, cacheKey, CACHE_TTL.UTXO); // Short TTL for mempool
  }

  /**
   * Get confirmed transaction history for an address
   */
  async getAddressTxsConfirmed(
    address: string,
    network: Network = "liquid"
  ): Promise<any[]> {
    const cacheKey = `esplora:addr_txs_confirmed:${network}:${hashCacheKeyPart(address)}`;
    const url = `${this.getBaseUrl(network)}/address/${address}/txs/chain`;

    const txs = await this.fetchWithRetry<any[]>(url, cacheKey, CACHE_TTL.TXS_LIST_CONFIRMED);
    const tipHash = await this.getCachedTipHash(network);
    if (tipHash) {
      const tipGateTtl = Math.max(CACHE_TTL.TXS_LIST_CONFIRMED * STALE_TTL_MULTIPLIER, CACHE_TTL.TXS_LIST_CONFIRMED);
      await this.setTipGateMarker(cacheKey, tipHash, tipGateTtl);
    }
    return txs;
  }

  /**
   * Get mempool transaction history for an address
   */
  async getAddressTxsMempool(
    address: string,
    network: Network = "liquid"
  ): Promise<any[]> {
    const cacheKey = `esplora:addr_txs_mempool:${network}:${hashCacheKeyPart(address)}`;
    const url = `${this.getBaseUrl(network)}/address/${address}/txs/mempool`;

    return this.fetchWithRetry<any[]>(url, cacheKey, CACHE_TTL.UTXO); // Short TTL for mempool
  }

  /**
   * Broadcast a raw transaction
   * Note: No retry logic to avoid duplicate broadcasts
   */
  async broadcastTx(txHex: string, network: Network = "liquid"): Promise<string> {
    const statKey = `esplora:broadcast:${network}`;
    const backoffState = this.getBackoffState(statKey);
    this.bumpStat(statKey, "calls");

    // Check if we're in backoff period
    if (Date.now() < backoffState.backoffUntil) {
      this.bumpStat(statKey, "rateLimited");
      throw new EsploraRateLimitError(
        `Rate limited, retry after ${Math.ceil((backoffState.backoffUntil - Date.now()) / 1000)}s`
      );
    }

    const url = `${this.getBaseUrl(network)}/tx`;
    const headers = await this.buildHeaders("text/plain", "text/plain");

    this.bumpStat(statKey, "upstreamCalls");
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: txHex,
    });

    if (response.status === 429) {
      // Rate limited - apply exponential backoff with jitter
      backoffState.consecutiveErrors++;
      this.bumpStat(statKey, "rateLimited");
      const backoffTime = Math.min(
        Math.pow(2, backoffState.consecutiveErrors) * 1000 + Math.random() * 1000,
        60000 // Max 60 seconds
      );
      backoffState.backoffUntil = Date.now() + backoffTime;
      console.warn(`[Esplora] Broadcast rate limited (429), backing off for ${backoffTime}ms`);
      throw new EsploraRateLimitError(`Rate limited (429)`);
    }

    if (!response.ok) {
      this.bumpStat(statKey, "errors");
      await response.text();
      throw new EsploraHttpError(response.status, response.statusText);
    }

    // Success - reset error counter
    backoffState.consecutiveErrors = 0;
    const txid = (await response.text()).trim();
    if (!/^[a-fA-F0-9]{64}$/.test(txid)) {
      throw new Error("Invalid txid response from broadcast");
    }
    return txid;
  }

  /**
   * Get fee estimates
   */
  async getFeeEstimates(network: Network = "bitcoin"): Promise<Record<string, number>> {
    const cacheKey = `esplora:fees:${network}`;
    const url = `${this.getBaseUrl(network)}/fee-estimates`;

    return this.fetchWithRetry<Record<string, number>>(url, cacheKey, CACHE_TTL.TIP_HEIGHT);
  }

  /**
   * Get block header hex
   */
  async getBlockHeader(blockHash: string, network: Network = "liquid"): Promise<string> {
    const cacheKey = `esplora:block_header:${network}:${hashCacheKeyPart(blockHash)}`;
    const url = `${this.getBaseUrl(network)}/block/${blockHash}/header`;

    return this.fetchTextWithRetry(url, cacheKey, CACHE_TTL.BLOCK_HEADER);
  }

  /**
   * Check service health and return stats
   */
  getStats(): {
    backoffSecondsRemaining: number;
    consecutiveErrors: number;
    inFlightCount: number;
    endpointStats: Record<string, EndpointStats>;
    upstreams: {
      bitcoin: string;
      liquid: string;
      authEnabled: boolean;
    };
  } {
    const endpointStats: Record<string, EndpointStats> = {};
    for (const [key, value] of this.metrics.entries()) {
      endpointStats[key] = value;
    }

    let maxBackoffUntil = 0;
    let maxConsecutiveErrors = 0;
    for (const state of this.backoffByKey.values()) {
      maxBackoffUntil = Math.max(maxBackoffUntil, state.backoffUntil);
      maxConsecutiveErrors = Math.max(
        maxConsecutiveErrors,
        state.consecutiveErrors
      );
    }
    const backoffSecondsRemaining = Math.max(
      0,
      Math.ceil((maxBackoffUntil - Date.now()) / 1000)
    );

    return {
      backoffSecondsRemaining,
      consecutiveErrors: maxConsecutiveErrors,
      inFlightCount: inFlightRequests.size,
      endpointStats,
      upstreams: {
        bitcoin: this.config.bitcoinUrl,
        liquid: this.config.liquidUrl,
        authEnabled: !!this.auth,
      },
    };
  }
}

// Export singleton getter
export const getEsploraService = () => EsploraService.getInstance();
