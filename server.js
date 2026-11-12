'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const BINANCE = 'https://fapi.binance.com';

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '3mb' }));

const DEFAULT_SETTINGS = Object.freeze({
  emaFast: 9,
  emaMedium: 20,
  emaSlow: 50,
  emaTrend: 200,
  rsiPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  atrPeriod: 14,
  adxPeriod: 14,
  bbPeriod: 20,
  bbMultiplier: 2,
  stochPeriod: 14,
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  minSignalScore: 60
});

let settings = { ...DEFAULT_SETTINGS };

const ALLOWED_INTERVALS = new Set([
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M'
]);

function isSymbol(value) {
  return typeof value === 'string' &&
    /^[A-Z0-9]{3,30}USDT$/.test(value);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n)
    ? Math.min(max, Math.max(min, n))
    : fallback;
}

function cleanSettings(input = {}) {
  const out = {};

  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const max = key.toLowerCase().includes('multiplier') ? 20 : 500;
    const min = key.toLowerCase().includes('multiplier') ? 0.1 : 1;

    out[key] = clampNumber(input[key], min, max, fallback);
  }

  if (out.macdFast >= out.macdSlow) {
    out.macdFast = DEFAULT_SETTINGS.macdFast;
    out.macdSlow = DEFAULT_SETTINGS.macdSlow;
  }

  return out;
}

async function binanceGet(path) {
  const response = await fetch(`${BINANCE}${path}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Shiju-Binance-V6/1.0'
    },
    signal: AbortSignal.timeout(12000)
  });

  const body = await response.text();

  if (!response.ok) {
    const error = new Error(
      `Binance Futures API returned HTTP ${response.status}`
    );

    error.status = response.status;
    error.details = body.slice(0, 500);

    throw error;
  }

  return JSON.parse(body);
}

function ema(values, period) {
  if (!values.length || values.length < period) return null;

  const k = 2 / (period + 1);

  let value = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
  }

  return value;
}

function rsi(values, period) {
  if (values.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const delta = values[i] - values[i - 1];

    if (delta > 0) gain += delta;
    else loss -= delta;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];

    avgGain =
      (avgGain * (period - 1) + Math.max(delta, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }

  return avgLoss === 0
    ? 100
    : 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(candles, period) {
  if (candles.length <= period) return null;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const high = Number(candles[i][2]);
    const low = Number(candles[i][3]);
    const previousClose = Number(candles[i - 1][4]);

    trs.push(
      Math.max(
        high - low,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose)
      )
    );
  }

  let value =
    trs.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < trs.length; i++) {
    value =
      (value * (period - 1) + trs[i]) / period;
  }

  return value;
}

function macd(values, fast, slow, signalPeriod) {
  if (values.length < slow + signalPeriod) {
    return {
      line: null,
      signal: null,
      histogram: null
    };
  }

  const kf = 2 / (fast + 1);
  const ks = 2 / (slow + 1);

  let ef = values[0];
  let es = values[0];

  const line = [];

  for (const value of values) {
    ef = value * kf + ef * (1 - kf);
    es = value * ks + es * (1 - ks);

    line.push(ef - es);
  }

  const signal = ema(line, signalPeriod);
  const last = line[line.length - 1];

  return {
    line: last,
    signal,
    histogram: signal == null ? null : last - signal
  };
}

function bollinger(values, period, multiplier) {
  if (values.length < period) return null;

  const slice = values.slice(-period);

  const middle =
    slice.reduce((a, b) => a + b, 0) / period;

  const deviation = Math.sqrt(
    slice.reduce(
      (sum, value) => sum + (value - middle) ** 2,
      0
    ) / period
  );

  return {
    upper: middle + multiplier * deviation,
    middle,
    lower: middle - multiplier * deviation
  };
}

function supertrend(candles, period, multiplier) {
  if (candles.length < period + 2) return null;

  let upper = null;
  let lower = null;
  let direction = 1;
  let result = null;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const high = Number(candles[i][2]);
    const low = Number(candles[i][3]);
    const previousClose = Number(candles[i - 1][4]);

    trs.push(
      Math.max(
        high - low,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose)
      )
    );
  }

  let currentAtr =
    trs.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < candles.length; i++) {
    if (i > period) {
      currentAtr =
        (currentAtr * (period - 1) + trs[i - 1]) / period;
    }

    const high = Number(candles[i][2]);
    const low = Number(candles[i][3]);
    const close = Number(candles[i][4]);
    const previousClose = Number(candles[i - 1][4]);

    const mid = (high + low) / 2;

    const basicUpper = mid + multiplier * currentAtr;
    const basicLower = mid - multiplier * currentAtr;

    if (upper === null) {
      upper = basicUpper;
      lower = basicLower;
    } else {
      const oldUpper = upper;
      const oldLower = lower;

      upper =
        basicUpper < oldUpper || previousClose > oldUpper
          ? basicUpper
          : oldUpper;

      lower =
        basicLower > oldLower || previousClose < oldLower
          ? basicLower
          : oldLower;
    }

    if (direction === 1 && close < lower) {
      direction = -1;
    } else if (direction === -1 && close > upper) {
      direction = 1;
    }

    result = {
      direction: direction === 1 ? 'LONG' : 'SHORT',
      value: direction === 1 ? lower : upper
    };
  }

  return result;
}

function calculate(candles, cfg) {
  if (!Array.isArray(candles) || candles.length < 210) {
    const error = new Error(
      'At least 210 Futures candles are required.'
    );

    error.status = 400;
    throw error;
  }

  const closed = candles.slice(0, -1);
  const closes = closed.map(c => Number(c[4]));

  if (closes.some(v => !Number.isFinite(v))) {
    const error = new Error('Invalid candle data.');
    error.status = 400;
    throw error;
  }

  const last = closes[closes.length - 1];

  const m = macd(
    closes,
    cfg.macdFast,
    cfg.macdSlow,
    cfg.macdSignal
  );

  const bb = bollinger(
    closes,
    cfg.bbPeriod,
    cfg.bbMultiplier
  );

  const st = supertrend(
    closed,
    cfg.supertrendPeriod,
    cfg.supertrendMultiplier
  );

  const value = {
    price: last,
    emaFast: ema(closes, cfg.emaFast),
    emaMedium: ema(closes, cfg.emaMedium),
    emaSlow: ema(closes, cfg.emaSlow),
    emaTrend: ema(closes, cfg.emaTrend),
    rsi: rsi(closes, cfg.rsiPeriod),
    macd: m.line,
    macdSignal: m.signal,
    macdHistogram: m.histogram,
    atr: atr(closed, cfg.atrPeriod),
    bollinger: bb,
    supertrend: st
  };

  let score = 0;
  const reasons = [];

  const add = (condition, name) => {
    score += condition ? 1 : -1;

    reasons.push(
      `${name}: ${condition ? 'bullish' : 'bearish'}`
    );
  };

  if (value.emaFast != null && value.emaMedium != null) {
    add(value.emaFast > value.emaMedium, 'EMA fast/medium');
  }

  if (value.emaMedium != null && value.emaSlow != null) {
    add(value.emaMedium > value.emaSlow, 'EMA medium/slow');
  }

  if (value.emaTrend != null) {
    add(last > value.emaTrend, 'Price/trend EMA');
  }

  if (value.rsi != null) {
    if (value.rsi >= 55) {
      score++;
      reasons.push('RSI: bullish');
    } else if (value.rsi <= 45) {
      score--;
      reasons.push('RSI: bearish');
    } else {
      reasons.push('RSI: neutral');
    }
  }

  if (value.macdHistogram != null) {
    add(value.macdHistogram > 0, 'MACD histogram');
  }

  if (value.supertrend) {
    add(
      value.supertrend.direction === 'LONG',
      'Supertrend'
    );
  }

  if (value.bollinger) {
    add(
      last > value.bollinger.middle,
      'Bollinger middle'
    );
  }

  const maxScore = reasons.length;

  const alignmentPct = maxScore
    ? Math.round(Math.abs(score) / maxScore * 100)
    : 0;

  let signal = 'WAIT';

  if (
    score >= 4 &&
    alignmentPct >= cfg.minSignalScore
  ) {
    signal = score >= 6 ? 'STRONG LONG' : 'LONG';
  }

  if (
    score <= -4 &&
    alignmentPct >= cfg.minSignalScore
  ) {
    signal = score <= -6 ? 'STRONG SHORT' : 'SHORT';
  }

  const plan = {
    entry: null,
    stopLoss: null,
    tp1: null,
    tp2: null,
    tp3: null
  };

  if (value.atr > 0 && signal !== 'WAIT') {
    const direction = signal.includes('LONG') ? 1 : -1;
    const risk = value.atr * 1.5;

    plan.entry = last;
    plan.stopLoss = last - direction * risk;
    plan.tp1 = last + direction * risk;
    plan.tp2 = last + direction * risk * 2;
    plan.tp3 = last + direction * risk * 3;
  }

  return {
    signal,
    score,
    maxScore,
    alignmentPct,
    reasons,
    indicators: value,
    plan,
    execution: 'DISABLED',
    note:
      'Indicator alignment is not a probability or guarantee. This endpoint does not place orders.'
  };
}

app.get('/', (_req, res) => {
  res.json({
    name: 'SHIJU BINANCE V6 API',
    market: 'BINANCE USDT-M PERPETUAL FUTURES ONLY',
    status: 'ONLINE',
    execution: 'DISABLED'
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ONLINE',
    service: 'SHIJU BINANCE V6',
    timestamp: new Date().toISOString(),
    execution: 'DISABLED'
  });
});

app.get('/config', (_req, res) => {
  res.json({
    market: 'USDT-M PERPETUAL FUTURES ONLY',
    intervals: [...ALLOWED_INTERVALS],
    settings,
    execution: 'DISABLED'
  });
});

app.get('/settings', (_req, res) => {
  res.json(settings);
});

app.post('/settings', (req, res) => {
  settings = cleanSettings(req.body || {});
  res.json({
    success: true,
    settings
  });
});

app.post('/settings/reset', (_req, res) => {
  settings = { ...DEFAULT_SETTINGS };

  res.json({
    success: true,
    settings
  });
});

// Binance public market data route.
// Hosting region restrictions may affect this endpoint.
app.get('/futures/pairs', async (_req, res) => {
  try {
    const [info, tickers] = await Promise.all([
      binanceGet('/fapi/v1/exchangeInfo'),
      binanceGet('/fapi/v1/ticker/24hr')
    ]);

    const valid = new Set(
      info.symbols
        .filter(s =>
          s.status === 'TRADING' &&
          s.contractType === 'PERPETUAL' &&
          s.quoteAsset === 'USDT'
        )
        .map(s => s.symbol)
    );

    res.json(
      tickers.filter(t => valid.has(t.symbol))
    );
  } catch (error) {
    res.status(error.status || 502).json({
      error: error.message,
      details: error.details || null,
      hint:
        'If this host cannot reach Binance, fetch public Futures market data in the browser.'
    });
  }
});

app.get('/futures/ticker/:symbol', async (req, res) => {
  const symbol = String(
    req.params.symbol || ''
  ).toUpperCase();

  if (!isSymbol(symbol)) {
    return res.status(400).json({
      error: 'Invalid USDT Futures symbol.'
    });
  }

  try {
    res.json(
      await binanceGet(
        `/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`
      )
    );
  } catch (error) {
    res.status(error.status || 502).json({
      error: error.message,
      details: error.details || null
    });
  }
});

app.get('/futures/klines/:symbol', async (req, res) => {
  const symbol = String(
    req.params.symbol || ''
  ).toUpperCase();

  const interval = String(
    req.query.interval || '5m'
  );

  const limit = Math.round(
    clampNumber(req.query.limit, 210, 1500, 500)
  );

  if (!isSymbol(symbol)) {
    return res.status(400).json({
      error: 'Invalid USDT Futures symbol.'
    });
  }

  if (!ALLOWED_INTERVALS.has(interval)) {
    return res.status(400).json({
      error: 'Unsupported Futures interval.'
    });
  }

  try {
    res.json(
      await binanceGet(
        `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
      )
    );
  } catch (error) {
    res.status(error.status || 502).json({
      error: error.message,
      details: error.details || null
    });
  }
});

// Frontend sends candles here for server-side analysis.
app.post('/futures/analyze', (req, res) => {
  try {
    const symbol = String(
      req.body?.symbol || ''
    ).toUpperCase();

    const interval = String(
      req.body?.interval || '5m'
    );

    if (!isSymbol(symbol)) {
      return res.status(400).json({
        error: 'Invalid USDT Futures symbol.'
      });
    }

    if (!ALLOWED_INTERVALS.has(interval)) {
      return res.status(400).json({
        error: 'Unsupported Futures interval.'
      });
    }

    const cfg = cleanSettings({
      ...settings,
      ...(req.body?.customSettings || {})
    });

    const result = calculate(
      req.body?.candles,
      cfg
    );

    res.json({
      symbol,
      interval,
      timestamp: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message
    });
  }
});

app.use((error, _req, res, _next) => {
  res.status(400).json({
    error: error.message || 'Bad request.'
  });
});

app.listen(PORT, () => {
  console.log(
    `SHIJU BINANCE V6 API listening on port ${PORT}`
  );
});
