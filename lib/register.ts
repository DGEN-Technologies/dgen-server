import { getConfig } from "./config-loader";
import countries from "./countries";
import { db, s } from "./db";
import { l, warn } from "./logging";
import { fail, getUser } from "./utils";
import { InputValidator } from "./middleware/security";
import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import { got } from "got";
import { getPublicKey, nip19 } from "nostr-tools";
import { encrypt as nip49encrypt } from "nostr-tools/nip49";
import { authenticator } from "otplib";
import { v4 } from "uuid";
import { initializeUserState } from "./state/hooks";

const valid = /^[\p{L}\p{N}]{2,24}$/u;
export default async (user, ip) => {
  let { password, pubkey, username } = user;
  l("registering", username);

  const reserved = ["ecash"];
  if (!username) fail("Username required");

  const usernameValidation = InputValidator.username(username);
  if (!usernameValidation.valid) {
    fail(usernameValidation.error || "Invalid username");
  }
  username = usernameValidation.sanitized;

  if (!valid.test(username))
    fail("Usernames can only have letters and numbers");
  if (reserved.includes(username)) fail("Invalid username");

  const id = v4();
  user.id = id;

  const exists = await db.exists(`user:${username}`);
  if (exists) fail(`Username ${username} taken`);

  if (password) {
    user.password = await Bun.password.hash(password, {
      algorithm: "bcrypt",
      cost: 12,
    });
  }

  user.currency = "USD";
  if (getConfig().ipregistry) {
    try {
      const {
        location: { country: { code } },
      }: any = await got(
        `https://api.ipregistry.co/${ip}?key=${getConfig().ipregistry}&fields=location.country.code`,
      ).json();

      user.currency = countries[code];
    } catch (e) {
      warn("unable to detect country from IP", username);
    }
  }

  user.currencies = [...new Set([user.currency, "CAD", "USD"])];
  user.fiat = false;
  user.otpsecret = authenticator.generateSecret();
  user.migrated = true;
  user.locktime = 300;

  let sk;
  if (!pubkey) {
    sk = randomBytes(32);
    pubkey = getPublicKey(sk);
    user.pubkey = pubkey;
    user.nsec = nip49encrypt(sk, password);
  }

  user.npub = nip19.npubEncode(pubkey);

  const account = JSON.stringify({
    id,
    type: "ecash",
    name: "Spending",
  });

  const bytes = randomBytes(32);
  const secret = bytesToHex(bytes);
  const app = {
    uid: id,
    secret,
    pubkey: getPublicKey(bytes),
    max_amount: 1000000,
    budget_renewal: "weekly",
    name: username,
    created: Date.now(),
  };

  await s(`app:${app.pubkey}`, app);
  await db.sAdd(`${id}:apps`, app.pubkey);

  // Wallet seed generation is handled by browser SDK (dgen-ui)
  // Server does NOT generate, store, or manage wallet mnemonics

  // Store user data
  await db.multi()
    .set(`user:${id}`, JSON.stringify(user))
    .set(`user:${username}`, id)
    .set(`user:${pubkey}`, id)
    .set(`balance:${id}`, 0)
    .set(`account:${id}`, account)
    .set(`${pubkey}:follows:n`, 0)
    .set(`${pubkey}:followers:n`, 0)
    .set(`${pubkey}:pubkeys`, "[]")
    .lPush(`${id}:accounts`, id)
    .exec();

  // Wallet initialization is handled entirely by browser SDK (dgen-ui)
  // Server just tracks that wallet hasn't been initialized yet
  await db.hSet(`wallet:${id}`, {
    initialized: "false",
    createdAt: Date.now().toString()
  });

  // Initialize user state
  try {
    await initializeUserState(id);
  } catch (e) {
    warn("Failed to initialize state management for new user", e);
  }

  l("new user", username);
  if (sk) user.sk = bytesToHex(sk);

  return user;
};
