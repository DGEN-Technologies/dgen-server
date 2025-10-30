import { getConfig } from "./config-loader";
import { g, s } from "./db";
import { err } from "./logging";
import { sleep } from "./utils";
import got from "got";
import WebSocket from "ws";
import { getWithRetry, tryMultipleProviders } from "./utils/httpRetry";

export let rate;
let last;
let ws;
let reconnectAttempts = 0;
let reconnectTimer = null;
let httpPollingInterval = null;
let useHttpFallback = false;
let currentWebSocketProvider = 0;
let lastWebSocketAttempt = 0;
let webSocketFailureCount = 0;
const WS_RETRY_DELAY = 5 * 60 * 1000; // 5 minutes between WebSocket retry attempts

// WebSocket providers to try in order
const webSocketProviders = [
  {
    name: "Kraken",
    url: "wss://ws.kraken.com/",
    subscribe: JSON.stringify({
      event: "subscribe",
      pair: ["XBT/USD"],
      subscription: { name: "ticker" }
    }),
    parseMessage: (data) => {
      try {
        const msg = JSON.parse(data);
        // Kraken sends array format for ticker updates
        if (Array.isArray(msg) && msg[2] === "ticker") {
          const tickerData = msg[1];
          // c = last trade closed array [price, lot volume]
          return parseFloat(tickerData.c[0]);
        }
      } catch (e) {}
      return null;
    }
  },
  {
    name: "Coinbase",
    url: "wss://ws-feed.exchange.coinbase.com",
    subscribe: JSON.stringify({
      type: "subscribe",
      product_ids: ["BTC-USD"],
      channels: ["ticker"]
    }),
    parseMessage: (data) => {
      const msg = JSON.parse(data);
      if (msg.type === "ticker" && msg.product_id === "BTC-USD") {
        return parseFloat(msg.price);
      }
      return null;
    }
  }
];

const connect = async () => {
  // Don't try WebSocket if using HTTP fallback
  if (useHttpFallback) return;
  
  // Check if already connected and recent
  if (ws && ws.readyState === WebSocket.OPEN && Date.now() - last < 5000) return;
  
  // Clean up existing connection
  if (ws) {
    try {
      ws.terminate();
    } catch (e) {}
    await sleep(Math.round(Math.random() * 1000));
  }

  // Try current WebSocket provider
  const provider = webSocketProviders[currentWebSocketProvider];
  if (!provider) {
    // All WebSocket providers failed, switch to HTTP polling
    console.log("All WebSocket providers failed, switching to HTTP polling");
    useHttpFallback = true;
    startHttpPolling();
    return;
  }

  console.log(`Trying WebSocket provider: ${provider.name}`);

  try {
    ws = new WebSocket(provider.url);

    ws.onmessage = async (event) => {
      try {
        const btcPrice = provider.parseMessage(event.data);
        
        if (btcPrice && btcPrice > 0) {
          const rates = (await g("rates")) || {};
          const { fx } = (await g("fx")) || {};
          if (!fx) return;

          Object.keys(fx).map((symbol) => {
            rates[symbol] = btcPrice * fx[symbol];
          });

          // Skip IRT rate if not needed (geo-blocked in most regions)
          // Uncomment only if Iranian Rial rates are needed
          // try {
          //   const irtResponse = await getWithRetry(
          //     "https://api.nobitex.ir/v2/orderbook/BTCIRT",
          //     { maxRetries: 1, timeout: 3000, throwOnAllFailed: false }
          //   );
          //   if (irtResponse?.lastTradePrice) {
          //     rates.IRT = irtResponse.lastTradePrice;
          //   }
          // } catch (e) {
          //   // Ignore IRT rate errors silently
          // }

          rate = btcPrice;
          s("rate", rate);
          s("rates", rates);
          last = Date.now();
        }
      } catch (e) {
        // Ignore parse errors for non-price messages (like heartbeats)
        if (event.data && !event.data.includes("heartbeat") && !event.data.includes("subscribed")) {
          console.log(`${provider.name} message error:`, e.message);
        }
      }
    };

    ws.onerror = async (error) => {
      // Only log first failure to prevent log spam
      if (webSocketFailureCount === 0) {
        console.log(`${provider.name} WebSocket error:`, error.message || "Connection failed");
      }
      webSocketFailureCount++;
      
      // Try next provider
      currentWebSocketProvider++;
      if (currentWebSocketProvider >= webSocketProviders.length) {
        if (webSocketFailureCount === webSocketProviders.length) {
          console.log("All WebSocket providers failed, switching to HTTP polling");
        }
        useHttpFallback = true;
        lastWebSocketAttempt = Date.now();
        startHttpPolling();
      } else {
        // Try next provider after a short delay
        setTimeout(() => connect(), 1000);
      }
    };

    ws.onclose = async (event) => {
      // Only log if this is a new failure, not a retry
      if (!useHttpFallback) {
        // Only log once per provider to avoid spam
        if (webSocketFailureCount <= webSocketProviders.length) {
          console.log(`${provider.name} WebSocket closed:`, event.code, event.reason);
        }
        
        currentWebSocketProvider++;
        if (currentWebSocketProvider >= webSocketProviders.length) {
          if (webSocketFailureCount === webSocketProviders.length) {
            console.log("All WebSocket providers exhausted, switching to HTTP polling");
          }
          useHttpFallback = true;
          lastWebSocketAttempt = Date.now();
          startHttpPolling();
        } else {
          // Try next provider after a short delay
          setTimeout(() => connect(), 1000);
        }
      }
    };

    ws.onopen = async () => {
      console.log(`${provider.name} WebSocket connected successfully`);
      reconnectAttempts = 0;
      webSocketFailureCount = 0; // Reset failure count on success
      stopHttpPolling(); // Stop HTTP polling if running
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      
      // Send subscription message if needed
      if (provider.subscribe) {
        ws.send(provider.subscribe);
        console.log(`Subscribed to ${provider.name} ticker`);
      }
    };

  } catch (error) {
    console.log(`Failed to create ${provider.name} WebSocket:`, error.message);
    currentWebSocketProvider++;
    if (currentWebSocketProvider >= webSocketProviders.length) {
      console.log("All WebSocket providers failed during creation, switching to HTTP polling");
      useHttpFallback = true;
      startHttpPolling();
    } else {
      setTimeout(() => connect(), 1000);
    }
  }
  
  return ws;
}

function scheduleReconnect() {
  if (reconnectTimer || useHttpFallback) return; // Already scheduled or using HTTP
  
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000); // Exponential backoff up to 30s
  
  const provider = webSocketProviders[currentWebSocketProvider];
  console.log(`Scheduling ${provider?.name || 'WebSocket'} reconnection in ${delay}ms (attempt ${reconnectAttempts})`);
  
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // After multiple reconnect attempts, try next provider
    if (reconnectAttempts > 3) {
      currentWebSocketProvider++;
      reconnectAttempts = 0;
    }
    connect();
  }, delay);
}

// HTTP polling fallback for environments that block WebSocket (like Railway)
async function startHttpPolling() {
  if (httpPollingInterval) return; // Already polling
  
  console.log("Starting HTTP polling for Bitcoin rates (fallback mode)");
  
  // Don't retry WebSocket on Railway - it will always fail and spam logs
  // Only retry if significant time has passed (30 minutes)
  if (process.env.NODE_ENV !== 'production') {
    setTimeout(() => {
      // Check if enough time has passed to retry WebSocket
      const timeSinceLastAttempt = Date.now() - lastWebSocketAttempt;
      if (timeSinceLastAttempt >= 30 * 60 * 1000) { // 30 minutes
        console.log("Retrying WebSocket providers after extended fallback period");
        useHttpFallback = false;
        currentWebSocketProvider = 0;
        reconnectAttempts = 0;
        webSocketFailureCount = 0;
        stopHttpPolling();
        connect();
      }
    }, 30 * 60 * 1000); // 30 minutes in dev, never in prod
  }
  
  const fetchRate = async () => {
    // Use the retry wrapper with multiple providers
    const { data: btcPrice, provider } = await tryMultipleProviders([
      {
        name: "Coinbase",
        url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
        transform: (response: any) => parseFloat(response.data?.amount)
      },
      {
        name: "CoinGecko",
        url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
        transform: (response: any) => response.bitcoin?.usd
      },
      {
        name: "CryptoCompare",
        url: "https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD",
        transform: (response: any) => response.USD
      },
      {
        name: "Binance",
        url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
        transform: (response: any) => parseFloat(response.price)
      },
      {
        name: "Kraken",
        url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
        transform: (response: any) => parseFloat(response.result?.XXBTZUSD?.c?.[0])
      }
    ], {
      maxRetries: 2,
      timeout: 3000,
      initialDelay: 500
    });
    
    if (btcPrice) {
      rate = btcPrice;
      await s("rate", rate);
      
      // Update all currency rates
      const rates = (await g("rates")) || {};
      const { fx } = (await g("fx")) || {};
      if (fx) {
        Object.keys(fx).map((symbol) => {
          rates[symbol] = btcPrice * fx[symbol];
        });
        await s("rates", rates);
      }
      
      last = Date.now();
      
      // Log success only on first fetch or provider change
      if (!httpPollingInterval || provider !== lastProvider) {
        console.log(`Bitcoin rate updated: $${btcPrice.toFixed(2)} (from ${provider})`);
        lastProvider = provider;
      }
    } else {
      console.error("Failed to fetch Bitcoin rate from all providers");
    }
  };
  
  // Fetch immediately
  fetchRate();
  
  // Then poll every 10 seconds (reasonable for fallback mode)
  httpPollingInterval = setInterval(fetchRate, 10000);
}

let lastProvider = "";

function stopHttpPolling() {
  if (httpPollingInterval) {
    clearInterval(httpPollingInterval);
    httpPollingInterval = null;
    console.log("Stopped HTTP polling for Binance rates");
  }
}

export const getFx = async () => {
  // Only attempt WebSocket connection if not already connected or using HTTP fallback
  if (!useHttpFallback && (!ws || ws.readyState !== WebSocket.OPEN)) {
    connect();
  }
  
  // Initialize BTC price on startup for immediate availability
  if (!rate) {
    let fetchSuccess = false;
    
    // Skip wallet on startup - it requires an active user session
    // The SDK will be used once users connect
    
    // Use retry wrapper for initial rate fetch
    const { data: initialRate } = await tryMultipleProviders([
      {
        name: "CoinGecko",
        url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
        transform: (response: any) => response.bitcoin?.usd
      },
      {
        name: "Coinbase",
        url: "https://api.coinbase.com/v2/exchange-rates?currency=BTC",
        transform: (response: any) => parseFloat(response.data?.rates?.USD)
      },
      {
        name: "Blockchain.info",
        url: "https://blockchain.info/ticker",
        transform: (response: any) => response.USD?.last
      }
    ], {
      maxRetries: 2,
      timeout: 5000,
      initialDelay: 1000
    });
    
    if (initialRate) {
      rate = initialRate;
      fetchSuccess = true;
    }
    
    if (fetchSuccess) {
      await s("rate", rate);
      
      // Calculate rates for all supported currencies
      const { fx: currentFx } = (await g("fx")) || {};
      if (currentFx) {
        const rates = {};
        Object.keys(currentFx).map((symbol) => {
          rates[symbol] = rate * currentFx[symbol];
        });
        await s("rates", rates);
      }
    } else {
      err("All BTC price APIs failed");
    }
  }

  let date = 0;
  let fx = await g("fx");
  if (fx) ({ date, fx } = fx);

  if (Date.now() - date > 24 * 60 * 60 * 1000) {
    date = Date.now();
    try {
      let fxData = null;
      
      if (getConfig().fixer) {
        // Try Fixer.io with retry
        const response = await getWithRetry(
          `http://data.fixer.io/api/latest?access_key=${getConfig().fixer}&base=USD`,
          { maxRetries: 2, timeout: 5000 }
        );
        if (response?.rates) {
          fx = response.rates;
        }
      } else {
        // Try alternative API with retry
        const response = await getWithRetry(
          "https://api.exchangerate-api.com/v4/latest/USD",
          { maxRetries: 2, timeout: 5000 }
        );
        if (response?.rates) {
          fx = response.rates;
        }
      }

      if (fx) {
        const USD = fx.USD;
        Object.keys(fx).map((k) => {
          fx[k] = fx[k] / USD;
        });
        await s("fx", { date, fx });
      }
    } catch (e) {
      // Don't crash on FX rate errors, just log them
      console.warn("Failed to update foreign exchange rates:", e.message);
    }
  }

  setTimeout(getFx, 30000);
};

// Cleanup function for graceful shutdown
export const cleanupRates = () => {
  if (ws) {
    try {
      ws.terminate();
    } catch (e) {}
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  stopHttpPolling();
};
