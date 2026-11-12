"use strict";

const express = require("express");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const KEY = process.env.BINANCE_API_KEY;
const SECRET = process.env.BINANCE_API_SECRET;

const BASE = "https://testnet.binancefuture.com";
const ENABLE_ORDERS = process.env.ENABLE_TESTNET_ORDERS === "true";

let trading = false;
let activeSymbol = null;

async function signedRequest(method, path, params = {}) {
  if (!KEY || !SECRET) throw new Error("API credentials not configured");

  const data = {
    ...params,
    timestamp: Date.now(),
    recvWindow: 10000
  };

  const query = new URLSearchParams(data).toString();
  const signature = crypto
    .createHmac("sha256", SECRET)
    .update(query)
    .digest("hex");

  const response = await fetch(`${BASE}${path}?${query}&signature=${signature}`, {
    method,
    headers: { "X-MBX-APIKEY": KEY }
  });

  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}

async function publicRequest(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`${BASE}${path}?${query}`);
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}

app.get("/health", (req, res) => {
  res.json({
    status: "ONLINE",
    mode: "BINANCE FUTURES TESTNET",
    ordersEnabled: ENABLE_ORDERS,
    trading
  });
});

app.post("/trade/stop", async (req, res) => {
  trading = false;
  activeSymbol = null;

  try {
    res.json({ success: true, message: "New trades disabled" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/trade/execute", async (req, res) => {
  if (!ENABLE_ORDERS) {
    return res.status(403).json({
      error: "Testnet orders are disabled. Enable them in backend environment."
    });
  }

  if (trading) {
    return res.status(409).json({ error: "A trade request is already running" });
  }

  const symbol = String(req.body.symbol || "").toUpperCase();

  if (!/^[A-Z0-9]{2,30}USDT$/.test(symbol)) {
    return res.status(400).json({ error: "Invalid USDT symbol" });
  }

  trading = true;
  activeSymbol = symbol;

  try {
    const exchangeInfo = await publicRequest("/fapi/v1/exchangeInfo");
    const item = exchangeInfo.symbols.find(s =>
      s.symbol === symbol &&
      s.status === "TRADING" &&
      s.contractType === "PERPETUAL"
    );

    if (!item) throw new Error("Symbol is not an active USDT perpetual");

    const priceData = await publicRequest("/fapi/v1/ticker/price", { symbol });
    const price = Number(priceData.price);

    const candles = await publicRequest("/fapi/v1/klines", {
      symbol,
      interval: "5m",
      limit: 220
    });

    const closes = candles.slice(0, -1).map(c => Number(c[4]));
    if (closes.length < 100) throw new Error("Insufficient candle data");

    const ema = (arr, period) => {
      const k = 2 / (period + 1);
      let value = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < arr.length; i++) {
        value = arr[i] * k + value * (1 - k);
      }
      return value;
    };

    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    const change = closes.at(-1) - closes.at(-2);

    let side;
    if (ema20 > ema50 && change > 0) side = "BUY";
    else if (ema20 < ema50 && change < 0) side = "SELL";
    else throw new Error("No clear entry signal. No order placed.");

    const high = candles.slice(-15, -1).map(c => Number(c[2]));
    const low = candles.slice(-15, -1).map(c => Number(c[3]));
    const ranges = candles.slice(-15, -1).map(c =>
      Number(c[2]) - Number(c[3])
    );
    const atr = ranges.reduce((a, b) => a + b, 0) / ranges.length;

    if (!Number.isFinite(atr) || atr <= 0) throw new Error("Invalid ATR");

    const long = side === "BUY";
    const stop = long ? price - atr * 1.5 : price + atr * 1.5;
    const target = long ? price + atr * 3 : price - atr * 3;

    const lot = item.filters.find(f => f.filterType === "LOT_SIZE");
    const priceFilter = item.filters.find(f => f.filterType === "PRICE_FILTER");

    const step = Number(lot.stepSize);
    const tick = Number(priceFilter.tickSize);
    const minQty = Number(lot.minQty);

    const floorStep = (n, stepSize) =>
      Math.floor(n / stepSize) * stepSize;

    const roundTick = n =>
      (Math.round(n / tick) * tick).toFixed(
        Math.max(0, (String(tick).split(".")[1] || "").length)
      );

    const notional = 20;
    const quantity = floorStep(notional / price, step);

    if (quantity < minQty) throw new Error("Quantity below exchange minimum");

    const qtyDecimals = Math.max(0, (String(step).split(".")[1] || "").length);
    const qty = quantity.toFixed(qtyDecimals);

    await signedRequest("POST", "/fapi/v1/marginType", {
      symbol,
      marginType: "ISOLATED"
    }).catch(e => {
      if (!String(e.message).includes("-4046")) throw e;
    });

    await signedRequest("POST", "/fapi/v1/leverage", {
      symbol,
      leverage: 2
    });

    const order = await signedRequest("POST", "/fapi/v1/order", {
      symbol,
      side,
      type: "MARKET",
      quantity: qty
    });

    const exitSide = long ? "SELL" : "BUY";

    try {
      await signedRequest("POST", "/fapi/v1/order", {
        symbol,
        side: exitSide,
        type: "STOP_MARKET",
        stopPrice: roundTick(stop),
        closePosition: "true",
        workingType: "MARK_PRICE
```javascript
      });

      await signedRequest("POST", "/fapi/v1/order", {
        symbol,
        side: exitSide,
        type: "TAKE_PROFIT_MARKET",
        stopPrice: roundTick(target),
        closePosition: "true",
        workingType: "MARK_PRICE"
      });
    } catch (protectError) {
      // Protection failed: cancel open orders and attempt to close position.
      await signedRequest("DELETE", "/fapi/v1/allOpenOrders", { symbol }).catch(() => {});
      await signedRequest("POST", "/fapi/v1/order", {
        symbol,
        side: exitSide,
        type: "MARKET",
        quantity: qty,
        reduceOnly: "true"
      }).catch(() => {});
      throw new Error("Protective order failed; emergency close was attempted. " + protectError.message);
    }

    res.json({
      success: true,
      mode: "TESTNET",
      symbol,
      side,
      entryReference: price,
      quantity: qty,
      leverage: 2,
      stopLoss: roundTick(stop),
      takeProfit: roundTick(target),
      order
    });

  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  } finally {
    trading = false;
    activeSymbol = null;
  }
});

app.listen(PORT, () => {
  console.log(`SHIJU BINANCE V6 TESTNET backend running on port ${PORT}`);
});
