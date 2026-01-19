import { describe, expect, it } from "bun:test";
import { bech32m } from "bech32";
import { isValidAddress } from "./address";

describe("address validation", () => {
  it("accepts valid base58 addresses", () => {
    expect(isValidAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe(true);
  });

  it("accepts valid bech32 addresses", () => {
    expect(isValidAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBe(true);
  });

  it("accepts valid bech32m addresses", () => {
    const data = new Uint8Array(32);
    const words = bech32m.toWords(data);
    const address = bech32m.encode("bc", words);
    expect(isValidAddress(address)).toBe(true);
  });

  it("rejects invalid base58 checksums", () => {
    expect(isValidAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb")).toBe(false);
  });

  it("rejects invalid bech32 checksums", () => {
    expect(isValidAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt081")).toBe(false);
  });

  it("rejects non-alphanumeric input", () => {
    expect(isValidAddress("bc1q$badaddress")).toBe(false);
  });
});
