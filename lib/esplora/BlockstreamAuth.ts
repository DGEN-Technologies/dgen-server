type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
};

const TOKEN_REQUEST_TIMEOUT_MS = 5000;
const TOKEN_EXP_SKEW_MS = 60_000; // Refresh 60s early to avoid edge expiry

export class BlockstreamAuth {
  private token: string | null = null;
  private expiresAt = 0;
  private inFlight: Promise<string> | null = null;
  private lastErrorAt = 0;
  private lastError: Error | null = null;
  private errorCooldownMs = 10000;

  private recordError(error: unknown): Error {
    const err = error instanceof Error ? error : new Error(String(error));
    this.lastError = err;
    this.lastErrorAt = Date.now();
    return err;
  }

  constructor(
    private readonly tokenUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly scope: string
  ) {}

  async getAccessToken(): Promise<string> {
    // Check inFlight first to avoid race condition - if a fetch is in progress, wait for it
    if (this.inFlight) {
      return this.inFlight;
    }

    // Return cached token if still valid
    if (this.token && Date.now() < this.expiresAt) {
      return this.token;
    }

    // Back off briefly after a failed fetch to avoid retry storms
    if (this.lastError && Date.now() - this.lastErrorAt < this.errorCooldownMs) {
      const waitMs = this.errorCooldownMs - (Date.now() - this.lastErrorAt);
      if (!this.inFlight) {
        let resolveInFlight!: (value: string) => void;
        let rejectInFlight!: (error: Error) => void;
        const inFlight = new Promise<string>((resolve, reject) => {
          resolveInFlight = resolve;
          rejectInFlight = reject;
        });
        this.inFlight = inFlight;

        new Promise<void>((resolve) => setTimeout(resolve, waitMs))
          .then(() => this.fetchToken())
          .then(resolveInFlight)
          .catch((error) => {
            rejectInFlight(this.recordError(error));
          })
          .finally(() => {
            if (this.inFlight === inFlight) {
              this.inFlight = null;
            }
          });
      }
      return this.inFlight;
    }

    // Set inFlight synchronously before any async operation to prevent duplicate fetches
    const inFlight = this.fetchToken().finally(() => {
      if (this.inFlight === inFlight) {
        this.inFlight = null;
      }
    });
    this.inFlight = inFlight;

    return this.inFlight;
  }

  invalidateToken(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  private parseJwtExpiry(token: string): number | null {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    try {
      const json = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
      if (typeof json?.exp === "number") {
        return json.exp * 1000;
      }
    } catch {
      return null;
    }
    return null;
  }

  private async fetchToken(): Promise<string> {
    try {
      const body = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: "client_credentials",
        scope: this.scope,
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(this.tokenUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
          },
          body,
          signal: controller.signal,
        });
      } catch (error: any) {
        if (error?.name === "AbortError") {
          throw new Error("Blockstream token request timed out");
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const detail = await response.text();
        const snippet = detail ? detail.slice(0, 200) : "";
        throw new Error(
          `Blockstream token request failed: ${response.status}${snippet ? ` - ${snippet}` : ""}`
        );
      }

      const data = (await response.json()) as TokenResponse;
      if (!data.access_token) {
        throw new Error("Blockstream token response missing access_token");
      }

      const expiresIn = Number.isFinite(data.expires_in) ? (data.expires_in as number) : 300;
      const refreshSkew = Math.max(Math.floor(expiresIn * 0.1), 30);

      const token = data.access_token;
      // Security validation: reject tokens with whitespace/control characters.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate validation for token safety
      if (/[\s\x00-\x1F\x7F]/.test(token)) {
        throw new Error("Blockstream token contains invalid characters");
      }

      this.token = token;
      const expMs = this.parseJwtExpiry(token);
      if (expMs) {
        const adjusted = expMs - TOKEN_EXP_SKEW_MS;
        if (adjusted <= Date.now()) {
          throw new Error("Blockstream token already expired");
        }
        this.expiresAt = adjusted;
      } else {
        this.expiresAt = Date.now() + Math.max(expiresIn - refreshSkew, 30) * 1000;
      }
      this.lastError = null;
      this.lastErrorAt = 0;

      return this.token;
    } catch (error) {
      throw this.recordError(error);
    }
  }
}
