import { FastifyReply, FastifyRequest } from "fastify";
import { bech32, bech32m } from "bech32";
import * as blech32Lib from "blech32";
import { sha256 } from "@noble/hashes/sha256";
import { base58check } from "@scure/base";
import {
  EsploraHttpError,
  EsploraRateLimitError,
  getEsploraService,
} from "../lib/esplora/EsploraService";

type Network = "bitcoin" | "liquid" | "testnet" | "liquidtestnet";

interface NetworkParams {
  network?: Network;
}

interface TxStatusParams extends NetworkParams {
  txid: string;
}

interface BlockParams extends NetworkParams {
  hash: string;
}

interface BlockHeightParams extends NetworkParams {
  height: string;
}

interface AddressParams extends NetworkParams {
  address: string;
}

interface ScripthashParams extends NetworkParams {
  hash: string;
}

interface NetworkQuery {
  network?: Network;
}

interface TxsQuery extends NetworkQuery {
  lastSeenTxid?: string;
}

interface WaterfallsQuery extends NetworkQuery {
  descriptor?: string;
  addresses?: string;
  page?: string;
  to_index?: string;
  utxo_only?: string;
}

interface BroadcastBody {
  txHex: string;
  network?: Network;
}

const validNetworks = new Set<Network>([
  "bitcoin",
  "liquid",
  "testnet",
  "liquidtestnet",
]);

const allowedBroadcastContentTypes = new Set<string>([
  "application/json",
  "text/plain",
]);

const getContentType = (value: string | string[] | undefined): string | null => {
  if (!value) return null;
  const header = Array.isArray(value) ? value[0] : value;
  return header.split(";")[0]?.trim().toLowerCase() || null;
};

const sendError = (
  req: FastifyRequest,
  res: FastifyReply,
  status: number,
  code: string,
  message: string
) => {
  const requestId = req.id ?? "unknown";
  res.type("application/json");
  return res.code(status).send({ code, message, requestId });
};

const isValidNetwork = (value: string | undefined): value is Network => {
  return !!value && validNetworks.has(value as Network);
};

const resolveNetwork = (
  params: NetworkParams | undefined,
  query: NetworkQuery | undefined,
  fallback: Network = "liquid"
): Network | null => {
  const candidate = params?.network || query?.network;
  if (candidate && !isValidNetwork(candidate)) {
    return null;
  }
  return candidate || fallback;
};

const ensureNetwork = (
  req: FastifyRequest<{ Params?: NetworkParams; Querystring?: NetworkQuery }>,
  res: FastifyReply,
  fallback: Network = "liquid"
): Network | null => {
  const network = resolveNetwork(req.params, req.query, fallback);
  if (!network) {
    sendError(req, res, 400, "INVALID_NETWORK", "Invalid network");
    return null;
  }
  return network;
};

const isValidScripthash = (hash: string | undefined): hash is string => {
  return !!hash && /^[a-fA-F0-9]{64}$/.test(hash);
};

const isValidBlockHash = (hash: string | undefined): hash is string => {
  return !!hash && /^[a-fA-F0-9]{64}$/.test(hash);
};

const isValidTxid = (txid: string | undefined): txid is string => {
  return !!txid && /^[a-fA-F0-9]{64}$/.test(txid);
};

const isValidTxHex = (hex: string | undefined): hex is string => {
  const maxHexLength = 2 * 1024 * 1024;
  return (
    !!hex &&
    hex.length <= maxHexLength &&
    /^[a-fA-F0-9]+$/.test(hex) &&
    hex.length % 2 === 0
  );
};

const MAX_BLOCK_HEIGHT = 10000000;

const isValidHexBuffer = (buffer: Buffer): boolean => {
  const maxHexLength = 2 * 1024 * 1024;
  if (buffer.length === 0 || buffer.length > maxHexLength) return false;
  if (buffer.length % 2 !== 0) return false;
  for (const byte of buffer.values()) {
    const isDigit = byte >= 48 && byte <= 57;
    const isUpper = byte >= 65 && byte <= 70;
    const isLower = byte >= 97 && byte <= 102;
    if (!isDigit && !isUpper && !isLower) return false;
  }
  return true;
};

const MAX_ADDRESS_LENGTH = 300;
const base58Address = /^[1-9A-HJ-NP-Za-km-z]{25,90}$/;
const bech32Address = /^(bc1|tb1|bcrt1|lq1|tlq1|ex1|tex1)[0-9a-z]{6,}$/i;
const bech32Prefixes = new Set([
  "bc",
  "tb",
  "bcrt",
  "lq",
  "tlq",
  "ex",
  "tex",
  "el",
]);
const base58Check = base58check(sha256);

const isValidBase58Address = (address: string): boolean => {
  if (!base58Address.test(address)) return false;
  try {
    base58Check.decode(address);
    return true;
  } catch {
    return false;
  }
};

const isValidBech32Address = (address: string): boolean => {
  if (!bech32Address.test(address)) return false;
  const normalized = address.toLowerCase();
  const prefix = normalized.split("1")[0];
  if (!bech32Prefixes.has(prefix)) return false;
  try {
    bech32.decode(normalized, 1023);
    return true;
  } catch {}
  try {
    bech32m.decode(normalized, 1023);
    return true;
  } catch {}
  return false;
};

const getBlech32Decoders = (): Array<{ decode: (value: string, limit?: number) => any }> => {
  const lib: any = blech32Lib as any;
  const candidates: Array<{ decode?: (value: string, limit?: number) => any }> = [
    lib,
    lib?.default,
    lib?.blech32,
    lib?.blech32m,
    lib?.default?.blech32,
    lib?.default?.blech32m,
  ];
  const decoders: Array<{ decode: (value: string, limit?: number) => any }> = [];
  for (const candidate of candidates) {
    if (candidate && typeof candidate.decode === "function") {
      decoders.push(candidate as { decode: (value: string, limit?: number) => any });
    }
  }
  return decoders;
};

const isValidBlech32Address = (address: string): boolean => {
  if (!bech32Address.test(address)) return false;
  const normalized = address.toLowerCase();
  const prefix = normalized.split("1")[0];
  if (!bech32Prefixes.has(prefix)) return false;

  const decoders = getBlech32Decoders();
  for (const decoder of decoders) {
    try {
      const hasEncoding =
        "BLECH32" in (decoder as any) || "BLECH32M" in (decoder as any);
      if (hasEncoding) {
        const enc = (decoder as any).BLECH32 ?? (decoder as any).BLECH32M;
        decoder.decode(normalized, enc);
        return true;
      }
      decoder.decode(normalized, 2048);
      return true;
    } catch {
      try {
        if ("BLECH32M" in (decoder as any)) {
          decoder.decode(normalized, (decoder as any).BLECH32M);
          return true;
        }
        decoder.decode(normalized);
        return true;
      } catch {}
    }
  }
  return false;
};

const isValidAddress = (address: string | undefined): address is string => {
  if (!address) return false;
  if (address.length < 14 || address.length > MAX_ADDRESS_LENGTH) return false;
  if (!/^[a-zA-Z0-9]+$/.test(address)) return false;
  return (
    isValidBase58Address(address) ||
    isValidBech32Address(address) ||
    isValidBlech32Address(address)
  );
};

const isProbablyConfidentialAddress = (address: string): boolean => {
  const normalized = address.toLowerCase();
  return (
    normalized.startsWith("lq1") ||
    normalized.startsWith("tlq1") ||
    normalized.startsWith("ex1") ||
    normalized.startsWith("tex1")
  );
};

const sendRateLimitedList = (req: FastifyRequest, res: FastifyReply) => {
  res.header("X-Esplora-Rate-Limited", "true");
  return sendError(req, res, 503, "ESPLORA_RATE_LIMITED", "Upstream rate limited");
};

const MAX_WATERFALLS_QUERY_LENGTH = 2000;
const MAX_WATERFALLS_ADDRESSES = 200;

const validateWaterfallsQuery = (
  req: FastifyRequest<{ Querystring: WaterfallsQuery }>,
  res: FastifyReply
): boolean => {
  const { addresses, descriptor, page, to_index, utxo_only } = req.query || {};
  if (addresses && addresses.length > MAX_WATERFALLS_QUERY_LENGTH) {
    sendError(req, res, 400, "INVALID_ADDRESSES", "Addresses list too long");
    return false;
  }
  if (descriptor && descriptor.length > MAX_WATERFALLS_QUERY_LENGTH) {
    sendError(req, res, 400, "INVALID_DESCRIPTOR", "Descriptor too long");
    return false;
  }
  if (page && !/^\d+$/.test(page)) {
    sendError(req, res, 400, "INVALID_PAGE", "Invalid page parameter");
    return false;
  }
  if (to_index && !/^\d+$/.test(to_index)) {
    sendError(req, res, 400, "INVALID_TO_INDEX", "Invalid to_index parameter");
    return false;
  }
  if (utxo_only && !["1", "0", "true", "false"].includes(utxo_only)) {
    sendError(req, res, 400, "INVALID_UTXO_ONLY", "Invalid utxo_only parameter");
    return false;
  }
  if (addresses) {
    const list = addresses
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (list.length > MAX_WATERFALLS_ADDRESSES) {
      sendError(req, res, 400, "INVALID_ADDRESSES", "Too many addresses");
      return false;
    }
    for (const addr of list) {
      if (!isValidAddress(addr)) {
        sendError(req, res, 400, "INVALID_ADDRESS", "Invalid address format");
        return false;
      }
    }
  }
  return true;
};

const buildWaterfallsQuery = (query: WaterfallsQuery = {}): string => {
  const params = new URLSearchParams();
  if (query.descriptor) {
    params.set("descriptor", query.descriptor);
  }
  if (query.addresses) {
    const list = query.addresses
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (list.length > 0) {
      params.set("addresses", list.join(","));
    }
  }
  if (query.page) {
    params.set("page", query.page);
  }
  if (query.to_index) {
    params.set("to_index", query.to_index);
  }
  if (query.utxo_only) {
    params.set("utxo_only", query.utxo_only);
  }
  return params.toString();
};

export const handleEsploraError = (
  req: FastifyRequest,
  res: FastifyReply,
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
  options?: {
    notFoundCode?: string;
    notFoundMessage?: string;
    rateLimitList?: boolean;
  }
) => {
  if (error instanceof EsploraRateLimitError) {
    if (options?.rateLimitList) {
      return sendRateLimitedList(req, res);
    }
    res.header("X-Esplora-Rate-Limited", "true");
    return sendError(req, res, 503, "ESPLORA_RATE_LIMITED", "Upstream rate limited");
  }

  if (error instanceof EsploraHttpError) {
    if (error.statusCode === 404) {
      return sendError(
        req,
        res,
        404,
        options?.notFoundCode ?? "ESPLORA_NOT_FOUND",
        options?.notFoundMessage ?? "Resource not found"
      );
    }

    if (error.statusCode >= 400 && error.statusCode < 500) {
      return sendError(
        req,
        res,
        error.statusCode,
        "ESPLORA_UPSTREAM_4XX",
        "Upstream request rejected"
      );
    }

    if (error.statusCode >= 500) {
      return sendError(
        req,
        res,
        502,
        "ESPLORA_UPSTREAM_5XX",
        "Upstream service error"
      );
    }
  }

  return sendError(req, res, 500, fallbackCode, fallbackMessage);
};

// Get transaction status
export const txStatus = async (
  req: FastifyRequest<{ Params: TxStatusParams; Querystring: NetworkQuery }>,
  res: FastifyReply
) => {
  try {
    const { txid } = req.params;
    const network = ensureNetwork(req, res);
    if (!network) return;

    if (!isValidTxid(txid)) {
      return sendError(req, res, 400, "INVALID_TXID", "Invalid txid format");
    }

    const esplora = getEsploraService();
    const status = await esplora.getTxStatus(txid, network);

    return res.send(status);
  } catch (error) {
    console.error("[Esplora Route] txStatus error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_TX_STATUS_FAILED",
      "Failed to fetch transaction status",
      {
        notFoundCode: "ESPLORA_TX_NOT_FOUND",
        notFoundMessage: "Transaction not found",
      }
    );
  }
};

// Get full transaction
export const tx = async (
  req: FastifyRequest<{ Params: TxStatusParams; Querystring: NetworkQuery }>,
  res: FastifyReply
) => {
  try {
    const { txid } = req.params;
    const network = ensureNetwork(req, res);
    if (!network) return;

    if (!isValidTxid(txid)) {
      return sendError(req, res, 400, "INVALID_TXID", "Invalid txid format");
    }

    const esplora = getEsploraService();
    const txData = await esplora.getTx(txid, network);

    return res.send(txData);
  } catch (error) {
    console.error("[Esplora Route] tx error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_TX_FAILED",
      "Failed to fetch transaction",
      {
        notFoundCode: "ESPLORA_TX_NOT_FOUND",
        notFoundMessage: "Transaction not found",
      }
    );
  }
};

// Get raw transaction hex
export const txHex = async (
  req: FastifyRequest<{ Params: TxStatusParams; Querystring: NetworkQuery }>,
  res: FastifyReply
) => {
  try {
    const { txid } = req.params;
    const network = ensureNetwork(req, res);
    if (!network) return;

    if (!isValidTxid(txid)) {
      return sendError(req, res, 400, "INVALID_TXID", "Invalid txid format");
    }

    const esplora = getEsploraService();
    const hex = await esplora.getTxHex(txid, network);

    res.type("text/plain");
    return res.send(hex);
  } catch (error) {
    console.error("[Esplora Route] txHex error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_TX_HEX_FAILED",
      "Failed to fetch raw transaction hex",
      {
        notFoundCode: "ESPLORA_TX_NOT_FOUND",
        notFoundMessage: "Transaction not found",
      }
    );
  }
};

// Get raw transaction bytes
export const txRaw = async (
  req: FastifyRequest<{ Params: TxStatusParams; Querystring: NetworkQuery }>,
  res: FastifyReply
) => {
  try {
    const { txid } = req.params;
    const network = ensureNetwork(req, res);
    if (!network) return;

    if (!isValidTxid(txid)) {
      return sendError(req, res, 400, "INVALID_TXID", "Invalid txid format");
    }

    const esplora = getEsploraService();
    const raw = await esplora.getTxRaw(txid, network);

    res.type("application/octet-stream");
    return res.send(raw);
  } catch (error) {
    console.error("[Esplora Route] txRaw error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_TX_RAW_FAILED",
      "Failed to fetch raw transaction",
      {
        notFoundCode: "ESPLORA_TX_NOT_FOUND",
        notFoundMessage: "Transaction not found",
      }
    );
  }
};

// Get address UTXOs
export const addressUtxo = async (
  req: FastifyRequest<{ Params: AddressParams; Querystring: NetworkQuery }>,
  res: FastifyReply
) => {
  try {
    const { address } = req.params;
    const network = ensureNetwork(req, res);
    if (!network) return;

    if (!isValidAddress(address)) {
      if (isProbablyConfidentialAddress(address)) {
        return sendError(
          req,
          res,
          400,
          "INVALID_CONFIDENTIAL_ADDRESS",
          "Confidential address could not be validated. Please ensure it is correct.",
        );
      }
      return sendError(req, res, 400, "INVALID_ADDRESS", "Invalid address format");
    }

    const esplora = getEsploraService();
    const utxos = await esplora.getAddressUtxos(address, network);

    return res.send(utxos);
  } catch (error) {
    console.error("[Esplora Route] addressUtxo error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_UTXO_FAILED",
      "Failed to fetch UTXOs",
      {
        notFoundCode: "ESPLORA_ADDRESS_NOT_FOUND",
        notFoundMessage: "Address not found",
        rateLimitList: true,
      }
    );
  }
};

// Get scripthash UTXOs
export const scripthashUtxo = async (
  req: FastifyRequest<{ Params: ScripthashParams; Querystring: NetworkQuery }>,
  res: FastifyReply
) => {
  try {
    const { hash } = req.params;
    const network = ensureNetwork(req, res);
    if (!network) return;

    if (!isValidScripthash(hash)) {
      return sendError(
        req,
        res,
        400,
        "INVALID_SCRIPTHASH",
        "Invalid scripthash: must be 64-character hex"
      );
    }

    const esplora = getEsploraService();
    const utxos = await esplora.getScripthashUtxos(hash, network);

    return res.send(utxos);
  } catch (error) {
    console.error("[Esplora Route] scripthashUtxo error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_SCRIPTHASH_UTXO_FAILED",
      "Failed to fetch scripthash UTXOs",
      {
        notFoundCode: "ESPLORA_SCRIPTHASH_NOT_FOUND",
        notFoundMessage: "Scripthash not found",
        rateLimitList: true,
      }
    );
  }
};

// Get block tip height
export const tipHeight = async (
  req: FastifyRequest<{ Params: NetworkParams; Querystring: NetworkQuery }>,
  res: FastifyReply
) => {
  try {
    const network = ensureNetwork(req, res);
    if (!network) return;

    const esplora = getEsploraService();
    const height = await esplora.getTipHeight(network);

    res.type("text/plain");
    return res.send(String(height));
  } catch (error) {
    console.error("[Esplora Route] tipHeight error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_TIP_HEIGHT_FAILED",
      "Failed to fetch tip height"
    );
  }
};

// Get block tip hash
export const tipHash = async (
  req: FastifyRequest<{ Params: NetworkParams; Querystring: NetworkQuery }>,
  res: FastifyReply
) => {
  try {
    const network = ensureNetwork(req, res);
    if (!network) return;

    const esplora = getEsploraService();
    const hash = await esplora.getTipHash(network);

    res.type("text/plain");
    return res.send(hash);
  } catch (error) {
    console.error("[Esplora Route] tipHash error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_TIP_HASH_FAILED",
      "Failed to fetch tip hash"
    );
  }
};

// Get address transactions
export const addressTxs = async (
  req: FastifyRequest<{ Params: AddressParams; Querystring: TxsQuery }>,
  res: FastifyReply
) => {
  try {
    const { address } = req.params;
    const { lastSeenTxid } = req.query;
    const network = ensureNetwork(req, res);
    if (!network) return;

    if (!isValidAddress(address)) {
      if (isProbablyConfidentialAddress(address)) {
        return sendError(
          req,
          res,
          400,
          "INVALID_CONFIDENTIAL_ADDRESS",
          "Confidential address could not be validated. Please ensure it is correct.",
        );
      }
      return sendError(req, res, 400, "INVALID_ADDRESS", "Invalid address format");
    }

    if (lastSeenTxid && !isValidTxid(lastSeenTxid)) {
      return sendError(req, res, 400, "INVALID_LAST_SEEN_TXID", "Invalid lastSeenTxid format");
    }

    const esplora = getEsploraService();
    const txs = await esplora.getAddressTxs(address, network, lastSeenTxid);

    return res.send(txs);
  } catch (error) {
    console.error("[Esplora Route] addressTxs error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_ADDRESS_TXS_FAILED",
      "Failed to fetch address transactions",
      {
        notFoundCode: "ESPLORA_ADDRESS_NOT_FOUND",
        notFoundMessage: "Address not found",
        rateLimitList: true,
      }
    );
  }
};

// Get address confirmed transactions
export const addressTxsConfirmed = async (
  req: FastifyRequest<{ Params: AddressParams; Querystring: NetworkQuery }>,
  res: FastifyReply
) => {
  try {
    const { address } = req.params;
    const network = ensureNetwork(req, res);
    if (!network) return;

    if (!isValidAddress(address)) {
      if (isProbablyConfidentialAddress(address)) {
        return sendError(
          req,
          res,
          400,
          "INVALID_CONFIDENTIAL_ADDRESS",
          "Confidential address could not be validated. Please ensure it is correct.",
        );
      }
      return sendError(req, res, 400, "INVALID_ADDRESS", "Invalid address format");
    }

    const esplora = getEsploraService();
    const txs = await esplora.getAddressTxsConfirmed(address, network);

    return res.send(txs);
  } catch (error) {
    console.error("[Esplora Route] addressTxsConfirmed error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_ADDRESS_TXS_CONFIRMED_FAILED",
      "Failed to fetch confirmed transactions",
      {
        notFoundCode: "ESPLORA_ADDRESS_NOT_FOUND",
        notFoundMessage: "Address not found",
        rateLimitList: true,
      }
    );
  }
};

// Get address mempool transactions
export const addressTxsMempool = async (
  req: FastifyRequest<{ Params: AddressParams; Querystring: NetworkQuery }>,
  res: FastifyReply
) => {
  try {
    const { address } = req.params;
    const network = ensureNetwork(req, res);
    if (!network) return;

    if (!isValidAddress(address)) {
      if (isProbablyConfidentialAddress(address)) {
        return sendError(
          req,
          res,
          400,
          "INVALID_CONFIDENTIAL_ADDRESS",
          "Confidential address could not be validated. Please ensure it is correct.",
        );
      }
      return sendError(req, res, 400, "INVALID_ADDRESS", "Invalid address format");
    }

    const esplora = getEsploraService();
    const txs = await esplora.getAddressTxsMempool(address, network);

    return res.send(txs);
  } catch (error) {
    console.error("[Esplora Route] addressTxsMempool error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_ADDRESS_TXS_MEMPOOL_FAILED",
      "Failed to fetch mempool transactions",
      {
        notFoundCode: "ESPLORA_ADDRESS_NOT_FOUND",
        notFoundMessage: "Address not found",
        rateLimitList: true,
      }
    );
  }
};

// Get scripthash transactions
export const scripthashTxs = async (
  req: FastifyRequest<{ Params: ScripthashParams; Querystring: TxsQuery }>,
  res: FastifyReply
) => {
  try {
    const { hash } = req.params;
    const { lastSeenTxid } = req.query;
    const network = ensureNetwork(req, res);
    if (!network) return;

    if (!isValidScripthash(hash)) {
      return sendError(
        req,
        res,
        400,
        "INVALID_SCRIPTHASH",
        "Invalid scripthash: must be 64-character hex"
      );
    }

    if (lastSeenTxid && !isValidTxid(lastSeenTxid)) {
      return sendError(req, res, 400, "INVALID_LAST_SEEN_TXID", "Invalid lastSeenTxid format");
    }

    const esplora = getEsploraService();
    const txs = await esplora.getScripthashTxs(hash, network, lastSeenTxid);

    return res.send(txs);
  } catch (error) {
    console.error("[Esplora Route] scripthashTxs error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_SCRIPTHASH_TXS_FAILED",
      "Failed to fetch scripthash transactions",
      {
        notFoundCode: "ESPLORA_SCRIPTHASH_NOT_FOUND",
        notFoundMessage: "Scripthash not found",
        rateLimitList: true,
      }
    );
  }
};

// Get scripthash confirmed transactions
export const scripthashTxsConfirmed = async (
  req: FastifyRequest<{ Params: ScripthashParams; Querystring: NetworkQuery }>,
  res: FastifyReply
) => {
  try {
    const { hash } = req.params;
    const network = ensureNetwork(req, res);
    if (!network) return;

    if (!isValidScripthash(hash)) {
      return sendError(
        req,
        res,
        400,
        "INVALID_SCRIPTHASH",
        "Invalid scripthash: must be 64-character hex"
      );
    }

    const esplora = getEsploraService();
    const txs = await esplora.getScripthashTxsConfirmed(hash, network);

    return res.send(txs);
  } catch (error) {
    console.error("[Esplora Route] scripthashTxsConfirmed error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_SCRIPTHASH_TXS_CONFIRMED_FAILED",
      "Failed to fetch confirmed scripthash transactions",
      {
        notFoundCode: "ESPLORA_SCRIPTHASH_NOT_FOUND",
        notFoundMessage: "Scripthash not found",
        rateLimitList: true,
      }
    );
  }
};

// Get scripthash mempool transactions
export const scripthashTxsMempool = async (
  req: FastifyRequest<{ Params: ScripthashParams; Querystring: NetworkQuery }>,
  res: FastifyReply
) => {
  try {
    const { hash } = req.params;
    const network = ensureNetwork(req, res);
    if (!network) return;

    if (!isValidScripthash(hash)) {
      return sendError(
        req,
        res,
        400,
        "INVALID_SCRIPTHASH",
        "Invalid scripthash: must be 64-character hex"
      );
    }

    const esplora = getEsploraService();
    const txs = await esplora.getScripthashTxsMempool(hash, network);

    return res.send(txs);
  } catch (error) {
    console.error("[Esplora Route] scripthashTxsMempool error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_SCRIPTHASH_TXS_MEMPOOL_FAILED",
      "Failed to fetch mempool scripthash transactions",
      {
        notFoundCode: "ESPLORA_SCRIPTHASH_NOT_FOUND",
        notFoundMessage: "Scripthash not found",
        rateLimitList: true,
      }
    );
  }
};

// Get block header hex
export const blockHeader = async (
  req: FastifyRequest<{ Params: BlockParams; Querystring: NetworkQuery }>,
  res: FastifyReply
) => {
  try {
    const { hash } = req.params;
    const network = ensureNetwork(req, res);
    if (!network) return;

    if (!isValidBlockHash(hash)) {
      return sendError(
        req,
        res,
        400,
        "INVALID_BLOCK_HASH",
        "Invalid block hash: must be 64-character hex"
      );
    }

    const esplora = getEsploraService();
    const header = await esplora.getBlockHeader(hash, network);

    res.type("text/plain");
    return res.send(header);
  } catch (error) {
    console.error("[Esplora Route] blockHeader error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_BLOCK_HEADER_FAILED",
      "Failed to fetch block header",
      {
        notFoundCode: "ESPLORA_BLOCK_NOT_FOUND",
        notFoundMessage: "Block not found",
      }
    );
  }
};

// Get block hash by height
export const blockHeight = async (
  req: FastifyRequest<{ Params: BlockHeightParams; Querystring: NetworkQuery }>,
  res: FastifyReply
) => {
  try {
    const { height } = req.params;
    const network = ensureNetwork(req, res);
    if (!network) return;
    const heightStr = height.trim();
    if (!/^\d+$/.test(heightStr)) {
      return sendError(req, res, 400, "INVALID_BLOCK_HEIGHT", "Invalid block height");
    }
    const heightNum = Number(heightStr);

    if (
      !Number.isSafeInteger(heightNum) ||
      heightNum < 0 ||
      heightNum > MAX_BLOCK_HEIGHT
    ) {
      return sendError(req, res, 400, "INVALID_BLOCK_HEIGHT", "Invalid block height");
    }

    const esplora = getEsploraService();
    const hash = await esplora.getBlockHashByHeight(heightNum, network);

    res.type("text/plain");
    return res.send(hash);
  } catch (error) {
    console.error("[Esplora Route] blockHeight error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_BLOCK_HASH_FAILED",
      "Failed to fetch block hash",
      {
        notFoundCode: "ESPLORA_BLOCK_NOT_FOUND",
        notFoundMessage: "Block not found",
      }
    );
  }
};

// Broadcast transaction
export const broadcast = async (
  req: FastifyRequest<{ Params: NetworkParams; Body: BroadcastBody | string | Buffer }>,
  res: FastifyReply
) => {
  try {
    const contentType = getContentType(req.headers["content-type"]);
    if (!contentType || !allowedBroadcastContentTypes.has(contentType)) {
      return sendError(
        req,
        res,
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Content-Type must be application/json or text/plain"
      );
    }

    const body = req.body;
    let txHex: string | undefined;
    let network: Network | undefined;

    if (typeof body === "string") {
      txHex = body;
    } else if (Buffer.isBuffer(body)) {
      if (!isValidHexBuffer(body)) {
        return sendError(req, res, 400, "INVALID_TX_HEX", "txHex must be a hex string");
      }
      txHex = body.toString("utf8");
    } else if (body && typeof body === "object" && !Array.isArray(body)) {
      // Use Object.hasOwn to prevent prototype pollution
      if (Object.hasOwn(body, "txHex")) {
        txHex = (body as BroadcastBody).txHex;
      }
      if (Object.hasOwn(body, "network")) {
        network = (body as BroadcastBody).network;
      }
    }

    let resolvedNetwork: Network | null;
    if (network) {
      if (!isValidNetwork(network)) {
        return sendError(req, res, 400, "INVALID_NETWORK", "Invalid network");
      }
      resolvedNetwork = network;
    } else {
      resolvedNetwork = ensureNetwork(req, res);
    }
    if (!resolvedNetwork) return;

    if (typeof txHex !== "string") {
      return sendError(req, res, 400, "INVALID_TX_HEX", "txHex must be a hex string");
    }
    const trimmedTxHex = txHex.trim();

    if (!isValidTxHex(trimmedTxHex)) {
      return sendError(req, res, 400, "INVALID_TX_HEX", "txHex must be a hex string");
    }

    const esplora = getEsploraService();
    const txid = await esplora.broadcastTx(trimmedTxHex, resolvedNetwork);

    const accept = req.headers["accept"];
    const wantsJson =
      contentType === "application/json" ||
      (typeof accept === "string" &&
        accept.toLowerCase().includes("application/json") &&
        contentType !== "text/plain");
    if (wantsJson) {
      res.type("application/json");
      return res.send({ txid });
    }
    res.type("text/plain");
    return res.send(txid);
  } catch (error) {
    console.error("[Esplora Route] broadcast error:", error);
    const contentType = getContentType(req.headers["content-type"]);
    const accept = req.headers["accept"];
    const wantsJson =
      contentType === "application/json" ||
      (typeof accept === "string" &&
        accept.toLowerCase().includes("application/json") &&
        contentType !== "text/plain");
    if (!wantsJson) {
      if (error instanceof EsploraRateLimitError) {
        res.header("X-Esplora-Rate-Limited", "true");
        res.type("text/plain");
        return res.code(503).send("Upstream rate limited");
      }
      if (error instanceof EsploraHttpError) {
        res.type("text/plain");
        return res.code(error.statusCode).send(error.message);
      }
      res.type("text/plain");
      return res.code(500).send("Failed to broadcast transaction");
    }
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_BROADCAST_FAILED",
      "Failed to broadcast transaction"
    );
  }
};

// Get fee estimates
export const feeEstimates = async (
  req: FastifyRequest<{ Params: NetworkParams; Querystring: NetworkQuery }>,
  res: FastifyReply
) => {
  try {
    const network = ensureNetwork(req, res, "bitcoin");
    if (!network) return;

    const esplora = getEsploraService();
    const fees = await esplora.getFeeEstimates(network);

    return res.send(fees);
  } catch (error) {
    console.error("[Esplora Route] feeEstimates error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_FEE_ESTIMATES_FAILED",
      "Failed to fetch fee estimates"
    );
  }
};

// Get service stats (for monitoring)
export const stats = async (
  req: FastifyRequest,
  res: FastifyReply
) => {
  try {
    const esplora = getEsploraService();
    const serviceStats = esplora.getStats();

    return res.send(serviceStats);
  } catch (error) {
    console.error("[Esplora Route] stats error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_STATS_FAILED",
      "Failed to fetch stats"
    );
  }
};

// Waterfalls QuickSync proxy
export const waterfalls = async (
  req: FastifyRequest<{ Params: NetworkParams; Querystring: WaterfallsQuery }>,
  res: FastifyReply
) => {
  try {
    const network = ensureNetwork(req, res);
    if (!network) return;
    if (!validateWaterfallsQuery(req, res)) return;

    const acceptHeader = req.headers["accept"];
    const accept =
      typeof acceptHeader === "string" && acceptHeader.includes("application/cbor")
        ? "application/cbor"
        : "application/json";

    const queryString = buildWaterfallsQuery(req.query || {});
    const esplora = getEsploraService();
    const upstream = await esplora.fetchWaterfalls(queryString, network, accept);

    const contentType = upstream.headers.get("content-type") || accept;
    res.header("content-type", contentType);
    const body = Buffer.from(await upstream.arrayBuffer());

    return res.code(upstream.status).send(body);
  } catch (error) {
    console.error("[Esplora Route] waterfalls error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_WATERFALLS_FAILED",
      "Failed to fetch waterfalls data"
    );
  }
};

// Breez Liquid server recipient (used by SDK)
export const liquidServerRecipient = async (
  req: FastifyRequest<{ Params: NetworkParams }>,
  res: FastifyReply
) => {
  try {
    const network = ensureNetwork(req, res);
    if (!network) return;
    if (network !== "liquid" && network !== "liquidtestnet") {
      return sendError(
        req,
        res,
        400,
        "INVALID_NETWORK",
        "Server recipient only supported for Liquid networks"
      );
    }

    const esplora = getEsploraService();
    const data = await esplora.getLiquidServerRecipient(network);
    return res.send(data);
  } catch (error) {
    console.error("[Esplora Route] liquidServerRecipient error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_SERVER_RECIPIENT_FAILED",
      "Failed to fetch server recipient"
    );
  }
};

// Breez Waterfalls v2 (Liquid only)
export const liquidWaterfallsV2 = async (
  req: FastifyRequest<{ Params: NetworkParams; Querystring: WaterfallsQuery }>,
  res: FastifyReply
) => {
  try {
    const network = ensureNetwork(req, res);
    if (!network) return;
    if (!validateWaterfallsQuery(req, res)) return;
    if (network !== "liquid" && network !== "liquidtestnet") {
      return sendError(
        req,
        res,
        400,
        "INVALID_NETWORK",
        "Waterfalls v2 only supported for Liquid networks"
      );
    }

    const acceptHeader = req.headers["accept"];
    const accept =
      typeof acceptHeader === "string" && acceptHeader.includes("application/cbor")
        ? "application/cbor"
        : "application/json";

    const queryString = buildWaterfallsQuery(req.query || {});
    const esplora = getEsploraService();
    const upstream = await esplora.fetchLiquidWaterfallsV2(
      queryString,
      network,
      accept
    );

    const contentType = upstream.headers.get("content-type") || accept;
    res.header("content-type", contentType);
    const body = Buffer.from(await upstream.arrayBuffer());

    return res.code(upstream.status).send(body);
  } catch (error) {
    console.error("[Esplora Route] liquidWaterfallsV2 error:", error);
    return handleEsploraError(
      req,
      res,
      error,
      "ESPLORA_WATERFALLS_V2_FAILED",
      "Failed to fetch waterfalls v2 data"
    );
  }
};

export default {
  txStatus,
  tx,
  txHex,
  txRaw,
  addressUtxo,
  scripthashUtxo,
  tipHeight,
  tipHash,
  addressTxs,
  addressTxsConfirmed,
  addressTxsMempool,
  scripthashTxs,
  scripthashTxsConfirmed,
  scripthashTxsMempool,
  blockHeader,
  blockHeight,
  broadcast,
  feeEstimates,
  stats,
  waterfalls,
  liquidServerRecipient,
  liquidWaterfallsV2,
};
