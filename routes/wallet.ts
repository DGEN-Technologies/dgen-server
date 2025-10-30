import db from "../lib/db";
import { ServiceInjector } from "../lib/services/ServiceInjector";

export default {
  // Get wallet info - only used to check if user has a wallet initialized
  async info(req, res) {
    try {
      const { user } = req;
      if (!user) {
        return res.code(401).send({ error: "Unauthorized" });
      }
      
      // Handle POST to mark wallet as created
      if (req.method === 'POST' || req.body) {
        const { action, createdAt } = req.body;
        if (action === 'mark_created') {
          await db.hSet(`wallet:${user.id}`, {
            initialized: "true",
            createdAt: createdAt || new Date().toISOString()
          });
          return res.send({ success: true });
        }
      }
      
      // Check if user has a wallet initialized (watch-only, no seed stored)
      const walletData = await db.hGetAll(`wallet:${user.id}`) || {};
      const hasWallet = walletData.initialized === "true" || walletData.pubkey;
      
      return res.send({
        initialized: hasWallet,
        hasSeed: false, // NEVER store seeds on server
        message: hasWallet ? "Wallet ready" : "No wallet found",
        createdAt: walletData.createdAt
      });
    } catch (error) {
      console.error("[wallet/info] Error:", error);
      return res.code(500).send({ error: "Failed to get wallet info" });
    }
  },
  
  // Create watch-only wallet (NO seed storage)
  async create(req, res) {
    try {
      const { user } = req;
      if (!user) {
        return res.code(401).send({ error: "Unauthorized" });
      }
      
      const { pubkey, fingerprint, type } = req.body;
      
      // IMPORTANT: We do NOT accept or store seeds/mnemonics
      if (req.body.seed || req.body.mnemonic) {
        return res.code(400).send({ 
          error: "Seeds cannot be stored on server for security", 
          message: "Please use your local wallet to manage seeds"
        });
      }
      
      if (!pubkey || !fingerprint) {
        return res.code(400).send({ error: "Public key and fingerprint required" });
      }
      
      console.log(`[wallet/create] Creating watch-only wallet for user ${user.id}`);
      
      // Store only public information for watch-only functionality
      await db.hSet(`wallet:${user.id}`, {
        initialized: "true",
        pubkey,
        fingerprint,
        type: type || "liquid",
        createdAt: new Date().toISOString()
      });
      
      console.log(`[wallet/create] Watch-only wallet created for user ${user.id}`);
      res.send({ 
        success: true, 
        message: "Watch-only wallet created successfully",
        watchOnly: true 
      });
    } catch (error) {
      console.error("[wallet/create] Error:", error);
      return res.code(500).send({ error: "Failed to create wallet" });
    }
  },

  // DEPRECATED: Mnemonic storage disabled for security
  // Seeds should NEVER be stored on server, only in user's physical backup
  async getMnemonic(req, res) {
    return res.code(403).send({ 
      error: "Seed retrieval disabled for security",
      message: "Please use your written backup from wallet setup. Seeds are never stored on the server."
    });
  },

  // DEPRECATED: Mnemonic storage disabled for security
  // Seeds should NEVER be stored on server, only in user's physical backup
  async storeMnemonic(req, res) {
    return res.code(403).send({ 
      error: "Seed storage disabled for security",
      message: "Seeds must only be stored in your physical backup. The server uses watch-only wallets."
    });
  }
};
