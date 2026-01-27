import { describe, expect, it } from "bun:test";
import { EsploraHttpError } from "../lib/esplora/EsploraService";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.PORT = process.env.PORT || "3119";

const { broadcast, blockHeight, addressUtxo, handleEsploraError } = await import("./esplora");

type MockReply = {
  statusCode: number;
  payload: unknown;
  code: (statusCode: number) => MockReply;
  send: (payload: unknown) => unknown;
  header: (name: string, value: string) => MockReply;
  type: (value: string) => MockReply;
};

const createReply = (): MockReply => {
  const reply = {
    statusCode: 200,
    payload: undefined,
    code(statusCode: number) {
      this.statusCode = statusCode;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      return payload;
    },
    header() {
      return this;
    },
    type() {
      return this;
    },
  } satisfies MockReply;
  return reply;
};

const createRequest = (body: unknown, contentType?: string) => ({
  body,
  headers: contentType ? { "content-type": contentType } : {},
  params: {},
  query: {},
});

describe("esplora broadcast validation", () => {
  it("rejects unsupported content-type", async () => {
    const req = createRequest("00", "application/octet-stream");
    const res = createReply();

    await broadcast(req as any, res as any);

    expect(res.statusCode).toBe(415);
  });

  it("rejects non-string txHex in JSON", async () => {
    const req = createRequest({ txHex: 123 }, "application/json");
    const res = createReply();

    await broadcast(req as any, res as any);

    expect(res.statusCode).toBe(400);
  });

  it("rejects invalid network in JSON body", async () => {
    const req = createRequest({ txHex: "00", network: "invalid" }, "application/json");
    const res = createReply();

    await broadcast(req as any, res as any);

    expect(res.statusCode).toBe(400);
  });

  it("rejects invalid hex in text/plain buffers", async () => {
    const req = createRequest(Buffer.from("abc", "ascii"), "text/plain");
    const res = createReply();

    await broadcast(req as any, res as any);

    expect(res.statusCode).toBe(400);
  });
});

describe("esplora block height validation", () => {
  it("rejects non-numeric height", async () => {
    const req = createRequest(undefined);
    req.params = { height: "123abc" };
    const res = createReply();

    await blockHeight(req as any, res as any);

    expect(res.statusCode).toBe(400);
  });

  it("rejects heights above max", async () => {
    const req = createRequest(undefined);
    req.params = { height: "10000001" };
    const res = createReply();

    await blockHeight(req as any, res as any);

    expect(res.statusCode).toBe(400);
  });
});

describe("esplora address validation", () => {
  it("rejects invalid bech32 checksum", async () => {
    const req = createRequest(undefined);
    req.params = {
      address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt081",
    };
    const res = createReply();

    await addressUtxo(req as any, res as any);

    expect(res.statusCode).toBe(400);
  });

  it("rejects invalid base58check checksum", async () => {
    const req = createRequest(undefined);
    req.params = {
      address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb",
    };
    const res = createReply();

    await addressUtxo(req as any, res as any);

    expect(res.statusCode).toBe(400);
  });
});

describe("esplora error mapping", () => {
  it("maps upstream 404 to a 404 response", () => {
    const req = { id: "test" };
    const res = createReply();

    handleEsploraError(
      req as any,
      res as any,
      new EsploraHttpError(404, "Not Found"),
      "ESPLORA_TX_STATUS_FAILED",
      "Failed to fetch transaction status",
      {
        notFoundCode: "ESPLORA_TX_NOT_FOUND",
        notFoundMessage: "Transaction not found",
      }
    );

    expect(res.statusCode).toBe(404);
    expect(res.payload).toEqual({
      code: "ESPLORA_TX_NOT_FOUND",
      message: "Transaction not found",
      requestId: "test",
    });
  });

  it("passes through upstream 4xx status codes", () => {
    const req = { id: "test" };
    const res = createReply();

    handleEsploraError(
      req as any,
      res as any,
      new EsploraHttpError(400, "Bad Request"),
      "ESPLORA_TX_STATUS_FAILED",
      "Failed to fetch transaction status"
    );

    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual({
      code: "ESPLORA_UPSTREAM_4XX",
      message: "Upstream request rejected",
      requestId: "test",
    });
  });

  it("maps upstream 5xx to 502", () => {
    const req = { id: "test" };
    const res = createReply();

    handleEsploraError(
      req as any,
      res as any,
      new EsploraHttpError(503, "Service Unavailable"),
      "ESPLORA_TX_STATUS_FAILED",
      "Failed to fetch transaction status"
    );

    expect(res.statusCode).toBe(502);
    expect(res.payload).toEqual({
      code: "ESPLORA_UPSTREAM_5XX",
      message: "Upstream service error",
      requestId: "test",
    });
  });
});
