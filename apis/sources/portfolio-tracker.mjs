// Portfolio Tracker — Monitors $40M CLP investment portfolio
// Reads portfolio.json, fetches live prices from Yahoo Finance
// Calculates current value, allocation drift, rebalance signals
// No API keys required

import { safeFetch } from '../utils/fetch.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTFOLIO_PATH = process.env.PORTFOLIO_PATH || resolve(__dirname, '..', '..', 'portfolio.json');
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const MINDICADORES = 'https://mindicadores.cl/api';

function loadPortfolio() {
  const raw = readFileSync(PORTFOLIO_PATH, 'utf-8');
  return JSON.parse(raw);
}

async function fetchYahooPrice(ticker) {
  const url = `${YAHOO_BASE}/${encodeURIComponent(ticker)}?range=5d&interval=1d&includePrePost=false`;
  const data = await safeFetch(url, {
    timeout: 8000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });

  const result = data?.chart?.result?.[0];
  if (!result) return null;

  const meta = result.meta || {};
  const closes = result.indicators?.quote?.[0]?.close || [];
  const price = meta.regularMarketPrice ?? closes[closes.length - 1];
  const prevClose = meta.chartPreviousClose ?? closes[closes.length - 2];

  return {
    price: price ? Math.round(price * 100) / 100 : null,
    prevClose: prevClose ? Math.round(prevClose * 100) / 100 : null,
    currency: meta.currency || 'USD',
  };
}

async function fetchUsdClp() {
  const quote = await fetchYahooPrice('USDCLP=X');
  return quote?.price || null;
}

async function fetchUfValue() {
  const data = await safeFetch(MINDICADORES, { timeout: 10000 });
  return data?.uf?.valor || null;
}

function calculateDapValue(position) {
  // DAP value = principal + accrued interest
  const principal = position.currency === 'USD' ? position.amount_usd : position.amount_clp;
  const rate = position.rate_annual_pct / 100;
  const entryDate = new Date(position.entry_date);
  const today = new Date();
  const daysElapsed = Math.max(0, (today - entryDate) / (1000 * 60 * 60 * 24));
  const accruedInterest = principal * rate * (daysElapsed / 365);
  return {
    principal,
    accrued_interest: Math.round(accruedInterest * 100) / 100,
    total: Math.round((principal + accruedInterest) * 100) / 100,
  };
}

export async function briefing() {
  let portfolio;
  try {
    portfolio = loadPortfolio();
  } catch (e) {
    return {
      source: 'Portfolio-Tracker',
      error: `Cannot load portfolio: ${e.message}`,
      hint: 'Ensure portfolio.json exists in project root',
    };
  }

  // Fetch USD/CLP and UF in parallel with all stock tickers
  const tickers = new Set();
  for (const alloc of portfolio.allocations) {
    for (const pos of alloc.positions) {
      if (pos.ticker) tickers.add(pos.ticker);
    }
  }

  const [usdclp, ufValue, ...tickerQuotes] = await Promise.all([
    fetchUsdClp(),
    fetchUfValue(),
    ...[...tickers].map(async (t) => ({ ticker: t, quote: await fetchYahooPrice(t) })),
  ]);

  const prices = Object.fromEntries(
    tickerQuotes.map(({ ticker, quote }) => [ticker, quote])
  );

  const rebalanceBand = portfolio.meta?.rebalance_band_pct || 5;
  let totalValueClp = 0;
  const classValues = {};
  const positions = [];

  for (const alloc of portfolio.allocations) {
    let classValueClp = 0;

    for (const pos of alloc.positions) {
      let valueCLP = 0;
      let gainLossPct = null;
      let currentPrice = null;
      let details = {};

      if (pos.type === 'dap') {
        const dapVal = calculateDapValue(pos);
        if (pos.currency === 'USD') {
          valueCLP = usdclp ? dapVal.total * usdclp : dapVal.total * (pos.entry_usdclp || 950);
        } else {
          valueCLP = dapVal.total;
        }
        details = { principal: dapVal.principal, accrued_interest: dapVal.accrued_interest };
        gainLossPct = dapVal.principal > 0 ? (dapVal.accrued_interest / dapVal.principal) * 100 : 0;

      } else if (pos.type === 'fund') {
        // Renta fija UF: value adjusts with UF
        if (ufValue && pos.amount_clp) {
          // Approximate: original investment was in CLP, tracks UF
          // For simplicity, assume fund holds value + some UF appreciation
          valueCLP = pos.amount_clp; // Base value, no live price available
          details = { note: 'No live ticker — using nominal value', uf_current: ufValue };
        } else {
          valueCLP = pos.amount_clp || 0;
        }

      } else if (pos.ticker && prices[pos.ticker]) {
        currentPrice = prices[pos.ticker].price;
        if (currentPrice && pos.quantity) {
          const rawValue = currentPrice * pos.quantity;
          if (pos.currency === 'USD' || prices[pos.ticker].currency === 'USD') {
            valueCLP = usdclp ? rawValue * usdclp : rawValue * (pos.entry_usdclp || 950);
          } else {
            valueCLP = rawValue;
          }

          const entryPrice = pos.entry_price_usd || pos.entry_price_clp;
          if (entryPrice) {
            gainLossPct = ((currentPrice - entryPrice) / entryPrice) * 100;
          }
        }
        details = { current_price: currentPrice, quantity: pos.quantity };

      } else if (pos.type === 'cash') {
        valueCLP = pos.amount_clp || 0;
      }

      valueCLP = Math.round(valueCLP);
      classValueClp += valueCLP;

      positions.push({
        name: pos.name,
        asset_class: alloc.asset_class,
        type: pos.type,
        ticker: pos.ticker || null,
        value_clp: valueCLP,
        gain_loss_pct: gainLossPct != null ? Math.round(gainLossPct * 100) / 100 : null,
        ...details,
      });
    }

    classValues[alloc.asset_class] = classValueClp;
    totalValueClp += classValueClp;
  }

  // Calculate allocation and deviations
  const allocation = {};
  const deviations = [];
  const signals = [];

  for (const alloc of portfolio.allocations) {
    const currentPct = totalValueClp > 0
      ? (classValues[alloc.asset_class] / totalValueClp) * 100
      : 0;
    const delta = currentPct - alloc.target_pct;

    allocation[alloc.asset_class] = {
      name: alloc.name,
      target_pct: alloc.target_pct,
      current_pct: Math.round(currentPct * 100) / 100,
      value_clp: classValues[alloc.asset_class],
      delta: Math.round(delta * 100) / 100,
    };

    if (Math.abs(delta) > rebalanceBand) {
      deviations.push({
        asset_class: alloc.asset_class,
        name: alloc.name,
        target: alloc.target_pct,
        current: Math.round(currentPct * 100) / 100,
        delta: Math.round(delta * 100) / 100,
      });
    }
  }

  const rebalanceNeeded = deviations.length > 0;

  if (rebalanceNeeded) {
    signals.push({
      type: 'rebalance_needed',
      severity: 'high',
      message: `${deviations.length} clase(s) fuera de banda ±${rebalanceBand}%: ${deviations.map(d => `${d.name} (${d.delta > 0 ? '+' : ''}${d.delta}%)`).join(', ')}`,
    });
  }

  // Total portfolio value change
  const originalTotal = portfolio.meta?.total_clp || 40000000;
  const totalChangePct = ((totalValueClp - originalTotal) / originalTotal) * 100;

  return {
    source: 'Portfolio-Tracker',
    timestamp: new Date().toISOString(),
    total_value_clp: totalValueClp,
    original_value_clp: originalTotal,
    total_change_pct: Math.round(totalChangePct * 100) / 100,
    fx: {
      usdclp: usdclp,
      uf: ufValue,
    },
    allocation,
    positions,
    rebalance_needed: rebalanceNeeded,
    rebalance_band_pct: rebalanceBand,
    deviations,
    signals,
  };
}

if (process.argv[1]?.endsWith('portfolio-tracker.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
