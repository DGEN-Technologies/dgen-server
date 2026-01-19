import { FastifyReply, FastifyRequest } from "fastify";
import {
  EsploraHttpError,
  EsploraRateLimitError,
  getEsploraService,
} from "../lib/esplora/EsploraService";
import { isValidAddress } from "../lib/validation/address";
import type { Network } from "@dgen/esplora-types";

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

const sendRateLimitedList = (req: FastifyRequest, res: FastifyReply) => {
  res.header("X-Esplora-Rate-Limited", "true");
  return sendError(req, res, 503, "ESPLORA_RATE_LIMITED", "Upstream rate limited");
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

type EsploraErrorOptions = {
  code: string;
  message: string;
  notFoundCode?: string;
  notFoundMessage?: string;
  rateLimitList?: boolean;
};

type EsploraHandlerOptions<Req extends FastifyRequest, Ctx, Result> = {
  name: string;
  prepare: (
    req: Req,
    res: FastifyReply
  ) => Ctx | null | Promise<Ctx | null>;
  call: (
    esplora: ReturnType<typeof getEsploraService>,
    ctx: Ctx
  ) => Promise<Result>;
  respond?: (res: FastifyReply, result: Result, ctx: Ctx) => FastifyReply;
  error: EsploraErrorOptions;
};

const requireNetwork = (
  req: FastifyRequest<{ Params?: NetworkParams; Querystring?: NetworkQuery }>,
  res: FastifyReply,
  fallback?: Network
): Network | null => {
  const network = ensureNetwork(req, res, fallback);
  return network ?? null;
};

const makeEsploraHandler = <Req extends FastifyRequest, Ctx, Result>(
  options: EsploraHandlerOptions<Req, Ctx, Result>
) => {
  return async (req: Req, res: FastifyReply) => {
    try {
      const ctx = await options.prepare(req, res);
      if (!ctx) return;

      const esplora = getEsploraService();
      const result = await options.call(esplora, ctx);

      if (options.respond) {
        return options.respond(res, result, ctx);
      }
      return res.send(result);
    } catch (error) {
      console.error(`[Esplora Route] ${options.name} error:`, error);
      return handleEsploraError(
        req,
        res,
        error,
        options.error.code,
        options.error.message,
        {
          notFoundCode: options.error.notFoundCode,
          notFoundMessage: options.error.notFoundMessage,
          rateLimitList: options.error.rateLimitList,
        }
      );
    }
  };
};

// Get transaction status
export const txStatus = makeEsploraHandler<
  FastifyRequest<{ Params: TxStatusParams; Querystring: NetworkQuery }>,
  { txid: string; network: Network },
  Awaited<ReturnType<ReturnType<typeof getEsploraService>["getTxStatus"]>>
>({
  name: "txStatus",
  prepare: (req, res) => {
    const { txid } = req.params;
    const network = requireNetwork(req, res);
    if (!network) return null;
    if (!isValidTxid(txid)) {
      sendError(req, res, 400, "INVALID_TXID", "Invalid txid format");
      return null;
    }
    return { txid, network };
  },
  call: (esplora, ctx) => esplora.getTxStatus(ctx.txid, ctx.network),
  error: {
    code: "ESPLORA_TX_STATUS_FAILED",
    message: "Failed to fetch transaction status",
    notFoundCode: "ESPLORA_TX_NOT_FOUND",
    notFoundMessage: "Transaction not found",
  },
});

// Get full transaction
export const tx = makeEsploraHandler<
  FastifyRequest<{ Params: TxStatusParams; Querystring: NetworkQuery }>,
  { txid: string; network: Network },
  Awaited<ReturnType<ReturnType<typeof getEsploraService>["getTx"]>>
>({
  name: "tx",
  prepare: (req, res) => {
    const { txid } = req.params;
    const network = requireNetwork(req, res);
    if (!network) return null;
    if (!isValidTxid(txid)) {
      sendError(req, res, 400, "INVALID_TXID", "Invalid txid format");
      return null;
    }
    return { txid, network };
  },
  call: (esplora, ctx) => esplora.getTx(ctx.txid, ctx.network),
  error: {
    code: "ESPLORA_TX_FAILED",
    message: "Failed to fetch transaction",
    notFoundCode: "ESPLORA_TX_NOT_FOUND",
    notFoundMessage: "Transaction not found",
  },
});

// Get raw transaction hex
export const txHex = makeEsploraHandler<
  FastifyRequest<{ Params: TxStatusParams; Querystring: NetworkQuery }>,
  { txid: string; network: Network },
  string
>({
  name: "txHex",
  prepare: (req, res) => {
    const { txid } = req.params;
    const network = requireNetwork(req, res);
    if (!network) return null;
    if (!isValidTxid(txid)) {
      sendError(req, res, 400, "INVALID_TXID", "Invalid txid format");
      return null;
    }
    return { txid, network };
  },
  call: (esplora, ctx) => esplora.getTxHex(ctx.txid, ctx.network),
  respond: (res, result) => res.type("text/plain").send(result),
  error: {
    code: "ESPLORA_TX_HEX_FAILED",
    message: "Failed to fetch raw transaction hex",
    notFoundCode: "ESPLORA_TX_NOT_FOUND",
    notFoundMessage: "Transaction not found",
  },
});

// Get raw transaction bytes
export const txRaw = makeEsploraHandler<
  FastifyRequest<{ Params: TxStatusParams; Querystring: NetworkQuery }>,
  { txid: string; network: Network },
  Uint8Array
>({
  name: "txRaw",
  prepare: (req, res) => {
    const { txid } = req.params;
    const network = requireNetwork(req, res);
    if (!network) return null;
    if (!isValidTxid(txid)) {
      sendError(req, res, 400, "INVALID_TXID", "Invalid txid format");
      return null;
    }
    return { txid, network };
  },
  call: (esplora, ctx) => esplora.getTxRaw(ctx.txid, ctx.network),
  respond: (res, result) =>
    res.type("application/octet-stream").send(result),
  error: {
    code: "ESPLORA_TX_RAW_FAILED",
    message: "Failed to fetch raw transaction",
    notFoundCode: "ESPLORA_TX_NOT_FOUND",
    notFoundMessage: "Transaction not found",
  },
});

// Get address UTXOs
export const addressUtxo = makeEsploraHandler<
  FastifyRequest<{ Params: AddressParams; Querystring: NetworkQuery }>,
  { address: string; network: Network },
  Awaited<ReturnType<ReturnType<typeof getEsploraService>["getAddressUtxos"]>>
>({
  name: "addressUtxo",
  prepare: (req, res) => {
    const { address } = req.params;
    const network = requireNetwork(req, res);
    if (!network) return null;
    if (!isValidAddress(address)) {
      sendError(req, res, 400, "INVALID_ADDRESS", "Invalid address format");
      return null;
    }
    return { address, network };
  },
  call: (esplora, ctx) => esplora.getAddressUtxos(ctx.address, ctx.network),
  error: {
    code: "ESPLORA_UTXO_FAILED",
    message: "Failed to fetch UTXOs",
    notFoundCode: "ESPLORA_ADDRESS_NOT_FOUND",
    notFoundMessage: "Address not found",
    rateLimitList: true,
  },
});

// Get scripthash UTXOs
export const scripthashUtxo = makeEsploraHandler<
  FastifyRequest<{ Params: ScripthashParams; Querystring: NetworkQuery }>,
  { hash: string; network: Network },
  Awaited<ReturnType<ReturnType<typeof getEsploraService>["getScripthashUtxos"]>>
>({
  name: "scripthashUtxo",
  prepare: (req, res) => {
    const { hash } = req.params;
    const network = requireNetwork(req, res);
    if (!network) return null;
    if (!isValidScripthash(hash)) {
      sendError(
        req,
        res,
        400,
        "INVALID_SCRIPTHASH",
        "Invalid scripthash: must be 64-character hex"
      );
      return null;
    }
    return { hash, network };
  },
  call: (esplora, ctx) => esplora.getScripthashUtxos(ctx.hash, ctx.network),
  error: {
    code: "ESPLORA_SCRIPTHASH_UTXO_FAILED",
    message: "Failed to fetch scripthash UTXOs",
    notFoundCode: "ESPLORA_SCRIPTHASH_NOT_FOUND",
    notFoundMessage: "Scripthash not found",
    rateLimitList: true,
  },
});

// Get block tip height
export const tipHeight = makeEsploraHandler<
  FastifyRequest<{ Params: NetworkParams; Querystring: NetworkQuery }>,
  { network: Network },
  number
>({
  name: "tipHeight",
  prepare: (req, res) => {
    const network = requireNetwork(req, res);
    if (!network) return null;
    return { network };
  },
  call: (esplora, ctx) => esplora.getTipHeight(ctx.network),
  respond: (res, result) => res.type("text/plain").send(String(result)),
  error: {
    code: "ESPLORA_TIP_HEIGHT_FAILED",
    message: "Failed to fetch tip height",
  },
});

// Get block tip hash
export const tipHash = makeEsploraHandler<
  FastifyRequest<{ Params: NetworkParams; Querystring: NetworkQuery }>,
  { network: Network },
  string
>({
  name: "tipHash",
  prepare: (req, res) => {
    const network = requireNetwork(req, res);
    if (!network) return null;
    return { network };
  },
  call: (esplora, ctx) => esplora.getTipHash(ctx.network),
  respond: (res, result) => res.type("text/plain").send(result),
  error: {
    code: "ESPLORA_TIP_HASH_FAILED",
    message: "Failed to fetch tip hash",
  },
});

// Get address transactions
export const addressTxs = makeEsploraHandler<
  FastifyRequest<{ Params: AddressParams; Querystring: TxsQuery }>,
  { address: string; network: Network; lastSeenTxid?: string },
  Awaited<ReturnType<ReturnType<typeof getEsploraService>["getAddressTxs"]>>
>({
  name: "addressTxs",
  prepare: (req, res) => {
    const { address } = req.params;
    const { lastSeenTxid } = req.query;
    const network = requireNetwork(req, res);
    if (!network) return null;
    if (!isValidAddress(address)) {
      sendError(req, res, 400, "INVALID_ADDRESS", "Invalid address format");
      return null;
    }
    if (lastSeenTxid && !isValidTxid(lastSeenTxid)) {
      sendError(req, res, 400, "INVALID_LAST_SEEN_TXID", "Invalid lastSeenTxid format");
      return null;
    }
    return { address, network, lastSeenTxid };
  },
  call: (esplora, ctx) =>
    esplora.getAddressTxs(ctx.address, ctx.network, ctx.lastSeenTxid),
  error: {
    code: "ESPLORA_ADDRESS_TXS_FAILED",
    message: "Failed to fetch address transactions",
    notFoundCode: "ESPLORA_ADDRESS_NOT_FOUND",
    notFoundMessage: "Address not found",
    rateLimitList: true,
  },
});

// Get address confirmed transactions
export const addressTxsConfirmed = makeEsploraHandler<
  FastifyRequest<{ Params: AddressParams; Querystring: NetworkQuery }>,
  { address: string; network: Network },
  Awaited<ReturnType<ReturnType<typeof getEsploraService>["getAddressTxsConfirmed"]>>
>({
  name: "addressTxsConfirmed",
  prepare: (req, res) => {
    const { address } = req.params;
    const network = requireNetwork(req, res);
    if (!network) return null;
    if (!isValidAddress(address)) {
      sendError(req, res, 400, "INVALID_ADDRESS", "Invalid address format");
      return null;
    }
    return { address, network };
  },
  call: (esplora, ctx) =>
    esplora.getAddressTxsConfirmed(ctx.address, ctx.network),
  error: {
    code: "ESPLORA_ADDRESS_TXS_CONFIRMED_FAILED",
    message: "Failed to fetch confirmed transactions",
    notFoundCode: "ESPLORA_ADDRESS_NOT_FOUND",
    notFoundMessage: "Address not found",
    rateLimitList: true,
  },
});

// Get address mempool transactions
export const addressTxsMempool = makeEsploraHandler<
  FastifyRequest<{ Params: AddressParams; Querystring: NetworkQuery }>,
  { address: string; network: Network },
  Awaited<ReturnType<ReturnType<typeof getEsploraService>["getAddressTxsMempool"]>>
>({
  name: "addressTxsMempool",
  prepare: (req, res) => {
    const { address } = req.params;
    const network = requireNetwork(req, res);
    if (!network) return null;
    if (!isValidAddress(address)) {
      sendError(req, res, 400, "INVALID_ADDRESS", "Invalid address format");
      return null;
    }
    return { address, network };
  },
  call: (esplora, ctx) =>
    esplora.getAddressTxsMempool(ctx.address, ctx.network),
  error: {
    code: "ESPLORA_ADDRESS_TXS_MEMPOOL_FAILED",
    message: "Failed to fetch mempool transactions",
    notFoundCode: "ESPLORA_ADDRESS_NOT_FOUND",
    notFoundMessage: "Address not found",
    rateLimitList: true,
  },
});

// Get scripthash transactions
export const scripthashTxs = makeEsploraHandler<
  FastifyRequest<{ Params: ScripthashParams; Querystring: TxsQuery }>,
  { hash: string; network: Network; lastSeenTxid?: string },
  Awaited<ReturnType<ReturnType<typeof getEsploraService>["getScripthashTxs"]>>
>({
  name: "scripthashTxs",
  prepare: (req, res) => {
    const { hash } = req.params;
    const { lastSeenTxid } = req.query;
    const network = requireNetwork(req, res);
    if (!network) return null;
    if (!isValidScripthash(hash)) {
      sendError(
        req,
        res,
        400,
        "INVALID_SCRIPTHASH",
        "Invalid scripthash: must be 64-character hex"
      );
      return null;
    }
    if (lastSeenTxid && !isValidTxid(lastSeenTxid)) {
      sendError(req, res, 400, "INVALID_LAST_SEEN_TXID", "Invalid lastSeenTxid format");
      return null;
    }
    return { hash, network, lastSeenTxid };
  },
  call: (esplora, ctx) =>
    esplora.getScripthashTxs(ctx.hash, ctx.network, ctx.lastSeenTxid),
  error: {
    code: "ESPLORA_SCRIPTHASH_TXS_FAILED",
    message: "Failed to fetch scripthash transactions",
    notFoundCode: "ESPLORA_SCRIPTHASH_NOT_FOUND",
    notFoundMessage: "Scripthash not found",
    rateLimitList: true,
  },
});

// Get scripthash confirmed transactions
export const scripthashTxsConfirmed = makeEsploraHandler<
  FastifyRequest<{ Params: ScripthashParams; Querystring: NetworkQuery }>,
  { hash: string; network: Network },
  Awaited<ReturnType<ReturnType<typeof getEsploraService>["getScripthashTxsConfirmed"]>>
>({
  name: "scripthashTxsConfirmed",
  prepare: (req, res) => {
    const { hash } = req.params;
    const network = requireNetwork(req, res);
    if (!network) return null;
    if (!isValidScripthash(hash)) {
      sendError(
        req,
        res,
        400,
        "INVALID_SCRIPTHASH",
        "Invalid scripthash: must be 64-character hex"
      );
      return null;
    }
    return { hash, network };
  },
  call: (esplora, ctx) =>
    esplora.getScripthashTxsConfirmed(ctx.hash, ctx.network),
  error: {
    code: "ESPLORA_SCRIPTHASH_TXS_CONFIRMED_FAILED",
    message: "Failed to fetch confirmed scripthash transactions",
    notFoundCode: "ESPLORA_SCRIPTHASH_NOT_FOUND",
    notFoundMessage: "Scripthash not found",
    rateLimitList: true,
  },
});

// Get scripthash mempool transactions
export const scripthashTxsMempool = makeEsploraHandler<
  FastifyRequest<{ Params: ScripthashParams; Querystring: NetworkQuery }>,
  { hash: string; network: Network },
  Awaited<ReturnType<ReturnType<typeof getEsploraService>["getScripthashTxsMempool"]>>
>({
  name: "scripthashTxsMempool",
  prepare: (req, res) => {
    const { hash } = req.params;
    const network = requireNetwork(req, res);
    if (!network) return null;
    if (!isValidScripthash(hash)) {
      sendError(
        req,
        res,
        400,
        "INVALID_SCRIPTHASH",
        "Invalid scripthash: must be 64-character hex"
      );
      return null;
    }
    return { hash, network };
  },
  call: (esplora, ctx) =>
    esplora.getScripthashTxsMempool(ctx.hash, ctx.network),
  error: {
    code: "ESPLORA_SCRIPTHASH_TXS_MEMPOOL_FAILED",
    message: "Failed to fetch mempool scripthash transactions",
    notFoundCode: "ESPLORA_SCRIPTHASH_NOT_FOUND",
    notFoundMessage: "Scripthash not found",
    rateLimitList: true,
  },
});

// Get block header hex
export const blockHeader = makeEsploraHandler<
  FastifyRequest<{ Params: BlockParams; Querystring: NetworkQuery }>,
  { hash: string; network: Network },
  string
>({
  name: "blockHeader",
  prepare: (req, res) => {
    const { hash } = req.params;
    const network = requireNetwork(req, res);
    if (!network) return null;
    if (!isValidBlockHash(hash)) {
      sendError(
        req,
        res,
        400,
        "INVALID_BLOCK_HASH",
        "Invalid block hash: must be 64-character hex"
      );
      return null;
    }
    return { hash, network };
  },
  call: (esplora, ctx) => esplora.getBlockHeader(ctx.hash, ctx.network),
  respond: (res, result) => res.type("text/plain").send(result),
  error: {
    code: "ESPLORA_BLOCK_HEADER_FAILED",
    message: "Failed to fetch block header",
    notFoundCode: "ESPLORA_BLOCK_NOT_FOUND",
    notFoundMessage: "Block not found",
  },
});

// Get block hash by height
export const blockHeight = makeEsploraHandler<
  FastifyRequest<{ Params: BlockHeightParams; Querystring: NetworkQuery }>,
  { heightNum: number; network: Network },
  string
>({
  name: "blockHeight",
  prepare: (req, res) => {
    const { height } = req.params;
    const network = requireNetwork(req, res);
    if (!network) return null;
    const heightStr = height.trim();
    if (!/^\d+$/.test(heightStr)) {
      sendError(req, res, 400, "INVALID_BLOCK_HEIGHT", "Invalid block height");
      return null;
    }
    const heightNum = Number(heightStr);
    if (
      !Number.isSafeInteger(heightNum) ||
      heightNum < 0 ||
      heightNum > MAX_BLOCK_HEIGHT
    ) {
      sendError(req, res, 400, "INVALID_BLOCK_HEIGHT", "Invalid block height");
      return null;
    }
    return { heightNum, network };
  },
  call: (esplora, ctx) => esplora.getBlockHashByHeight(ctx.heightNum, ctx.network),
  respond: (res, result) => res.type("text/plain").send(result),
  error: {
    code: "ESPLORA_BLOCK_HASH_FAILED",
    message: "Failed to fetch block hash",
    notFoundCode: "ESPLORA_BLOCK_NOT_FOUND",
    notFoundMessage: "Block not found",
  },
});

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

    return res.send({ txid });
  } catch (error) {
    console.error("[Esplora Route] broadcast error:", error);
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
export const feeEstimates = makeEsploraHandler<
  FastifyRequest<{ Params: NetworkParams; Querystring: NetworkQuery }>,
  { network: Network },
  Awaited<ReturnType<ReturnType<typeof getEsploraService>["getFeeEstimates"]>>
>({
  name: "feeEstimates",
  prepare: (req, res) => {
    const network = requireNetwork(req, res, "bitcoin");
    if (!network) return null;
    return { network };
  },
  call: (esplora, ctx) => esplora.getFeeEstimates(ctx.network),
  error: {
    code: "ESPLORA_FEE_ESTIMATES_FAILED",
    message: "Failed to fetch fee estimates",
  },
});

// Get service stats (for monitoring)
export const stats = makeEsploraHandler<
  FastifyRequest,
  Record<string, never>,
  ReturnType<ReturnType<typeof getEsploraService>["getStats"]>
>({
  name: "stats",
  prepare: () => ({}),
  call: (esplora) => Promise.resolve(esplora.getStats()),
  error: {
    code: "ESPLORA_STATS_FAILED",
    message: "Failed to fetch stats",
  },
});

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
};
