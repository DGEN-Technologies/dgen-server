import { describe, expect, it } from "bun:test";
import { BlockstreamAuth } from "./BlockstreamAuth";

const mockFetchResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const withMockedFetch = async <T>(
  mockFetch: typeof fetch,
  fn: () => Promise<T>
): Promise<T> => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

describe("BlockstreamAuth token validation", () => {
  it("accepts a clean access token", async () => {
    await withMockedFetch(
      async () => mockFetchResponse({ access_token: "token-123" }),
      async () => {
        const auth = new BlockstreamAuth(
          "https://example.com/token",
          "client",
          "secret",
          "openid"
        );
        await expect(auth.getAccessToken()).resolves.toBe("token-123");
      }
    );
  });

  it("rejects access tokens with control characters", async () => {
    await withMockedFetch(
      async () => mockFetchResponse({ access_token: "bad\n-token" }),
      async () => {
        const auth = new BlockstreamAuth(
          "https://example.com/token",
          "client",
          "secret",
          "openid"
        );
        await expect(auth.getAccessToken()).rejects.toThrow(
          "Blockstream token contains invalid characters"
        );
      }
    );
  });
});
