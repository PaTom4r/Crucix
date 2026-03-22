// Chile Copper — Detailed copper futures tracking
// Sources: Yahoo Finance (HG=F copper futures), correlation with USD/CLP
// No API keys required

import { safeFetch } from '../utils/fetch.mjs';

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

async function fetchCopperFutures() {
  const url = `${YAHOO_BASE}/HG%3DF?range=1mo&interval=1d&includePrePost=false`;
  const data = await safeFetch(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });

  const result = data?.chart?.result?.[0];
  if (!result) return { error: 'No copper futures data from Yahoo Finance' };

  const meta = result.meta || {};
  const quotes = result.indicators?.quote?.[0] || {};
  const closes = quotes.close || [];
  const timestamps = result.timestamp || [];

  const current = meta.regularMarketPrice ?? closes[closes.length - 1];
  const prevClose = meta.chartPreviousClose ?? closes[closes.length - 2];
  const changePct1d = prevClose ? ((current - prevClose) / prevClose) * 100 : 0;

  // 7-day change
  const weekAgoIdx = Math.max(0, closes.length - 6);
  const weekAgoClose = closes[weekAgoIdx];
  const changePct7d = weekAgoClose ? ((current - weekAgoClose) / weekAgoClose) * 100 : 0;

  const history = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] != null) {
      history.push({
        date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
        close: Math.round(closes[i] * 10000) / 10000,
      });
    }
  }

  return {
    price_usd_lb: current ? Math.round(current * 10000) / 10000 : null,
    prevClose: prevClose ? Math.round(prevClose * 10000) / 10000 : null,
    change_1d_pct: Math.round(changePct1d * 100) / 100,
    change_7d_pct: Math.round(changePct7d * 100) / 100,
    history_30d: history,
  };
}

async function fetchUsdClpHistory() {
  const url = `${YAHOO_BASE}/USDCLP%3DX?range=1mo&interval=1d&includePrePost=false`;
  const data = await safeFetch(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });

  const result = data?.chart?.result?.[0];
  if (!result) return [];

  const closes = result.indicators?.quote?.[0]?.close || [];
  const timestamps = result.timestamp || [];

  return timestamps.map((t, i) => ({
    date: new Date(t * 1000).toISOString().split('T')[0],
    close: closes[i],
  })).filter(p => p.close != null);
}

function calculateCorrelation(seriesA, seriesB) {
  // Simple Pearson correlation on daily returns over last 7 trading days
  const n = Math.min(seriesA.length, seriesB.length, 8);
  if (n < 3) return null;

  const returnsA = [];
  const returnsB = [];
  for (let i = 1; i < n; i++) {
    const idxA = seriesA.length - n + i;
    const idxB = seriesB.length - n + i;
    if (seriesA[idxA - 1]?.close && seriesB[idxB - 1]?.close) {
      returnsA.push((seriesA[idxA].close - seriesA[idxA - 1].close) / seriesA[idxA - 1].close);
      returnsB.push((seriesB[idxB].close - seriesB[idxB - 1].close) / seriesB[idxB - 1].close);
    }
  }

  if (returnsA.length < 2) return null;

  const meanA = returnsA.reduce((a, b) => a + b, 0) / returnsA.length;
  const meanB = returnsB.reduce((a, b) => a + b, 0) / returnsB.length;

  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < returnsA.length; i++) {
    const dA = returnsA[i] - meanA;
    const dB = returnsB[i] - meanB;
    cov += dA * dB;
    varA += dA * dA;
    varB += dB * dB;
  }

  const denom = Math.sqrt(varA * varB);
  return denom > 0 ? Math.round((cov / denom) * 100) / 100 : null;
}

export async function briefing() {
  const [copper, clpHistory] = await Promise.all([
    fetchCopperFutures(),
    fetchUsdClpHistory(),
  ]);

  const signals = [];

  // Weekly drop alert
  if (copper.change_7d_pct && copper.change_7d_pct < -5) {
    signals.push({
      type: 'copper_drop',
      severity: 'high',
      message: `Copper futures down ${copper.change_7d_pct}% in 7 days`,
    });
  }

  // Correlation analysis
  const correlation = calculateCorrelation(copper.history_30d || [], clpHistory);

  // Normally copper up = CLP strengthens (USD/CLP down), so correlation should be negative
  // If both move same direction, that's a divergence signal
  if (correlation !== null && correlation > 0.3) {
    signals.push({
      type: 'copper_clp_divergence',
      severity: 'medium',
      message: `Copper and USD/CLP moving together (correlation ${correlation}) — unusual divergence`,
    });
  }

  return {
    source: 'Chile-Copper',
    timestamp: new Date().toISOString(),
    copper,
    correlation: {
      copper_vs_usdclp_7d: correlation,
      note: 'Negative = normal (copper up, peso strengthens). Positive = divergence.',
    },
    signals,
  };
}

if (process.argv[1]?.endsWith('chile-copper.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
