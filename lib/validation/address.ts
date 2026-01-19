import { bech32, bech32m } from "bech32";
import { sha256 } from "@noble/hashes/sha256";
import { base58check } from "@scure/base";

// Server validation is authoritative; include checksum verification.
const MAX_ADDRESS_LENGTH = 120;
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

const localIsValidAddress = (address: string | undefined): address is string => {
  if (!address) return false;
  if (address.length < 14 || address.length > MAX_ADDRESS_LENGTH) return false;
  if (!/^[a-zA-Z0-9]+$/.test(address)) return false;
  return isValidBase58Address(address) || isValidBech32Address(address);
};

let isValidAddressImpl = localIsValidAddress;

const loadSharedValidator = async (): Promise<void> => {
  try {
    const shared = await import("@dgen/validation");
    if (typeof shared?.isValidAddress === "function") {
      isValidAddressImpl = shared.isValidAddress;
    }
  } catch {}
};

void loadSharedValidator();

export const isValidAddress = (address: string | undefined): address is string =>
  isValidAddressImpl(address);
