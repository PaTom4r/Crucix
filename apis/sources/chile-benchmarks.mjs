// Chile Benchmarks — Compare portfolio returns vs relevant benchmarks
// Sources: Yahoo Finance for YTD returns of SPY, ^IPSA, TLT
// No API keys required

import { safeFetch } from '../utils/fetch.mjs';

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

const BENCHMARKS = [
  { ticker: 'SPY', name: 'S&P 500', description: 'Mercado global EEUU' },
  { ticker: '^IPSA', name: 'IPSA', description: 'Mercado accionario Chile' },
  { ticker: 'TLT', name: 'Bonos 20A', description: 'Renta fija USD largo plazo' },
  { ticker: 'EMB', name: 'Bonos EM', description: 'Renta fija mercados emergentes' },
];

async function fetchYtdReturn(ticker) {
  // Get YTD range
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const period1 = Math.floor(yearStart.getTime() / 1000);
  const period2 = Math.floor(now.getTime() / 1000);

  const url = `${YAHOO_BASE}/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false`;
  const data = await safeFetch(url, {
    timeout: 8000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });

  const result = data?.chart?.result?.[0];
  if (!result) return null;

  const meta = result.meta || {};
  const closes = result.indicators?.quote?.[0]?.close || [];
  const timestamps = result.timestamp || [];

  // First valid close of the year and latest
  const firstClose = closes.find(c => c != null);
  const currentPrice = meta.regularMarketPrice ?? closes[closes.length - 1];

  if (!firstClose || !currentPrice) return null;

  const ytdReturn = ((currentPrice - firstClose) / firstClose) * 100;

  // Build weekly history for mini sparkline
  const history = [];
  for (let i = 0; i < timestamps.length; i += 5) { // weekly samples
    if (closes[i] != null) {
      history.push({
        date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
        close: Math.round(closes[i] * 100) / 100,
      });
    }
  }
  // Always include the last point
  if (closes[closes.length - 1] != null) {
    history.push({
      date: new Date(timestamps[timestamps.length - 1] * 1000).toISOString().split('T')[0],
      close: Math.round(closes[closes.length - 1] * 100) / 100,
    });
  }

  return {
    ticker,
    currentPrice: Math.round(currentPrice * 100) / 100,
    yearStartPrice: Math.round(firstClose * 100) / 100,
    ytdReturn: Math.round(ytdReturn * 100) / 100,
    currency: meta.currency || 'USD',
    history,
  };
}

export async function briefing() {
  const results = await Promise.allSettled(
    BENCHMARKS.map(async (b) => {
      const data = await fetchYtdReturn(b.ticker);
      return data ? { ...b, ...data } : { ...b, error: 'No data' };
    })
  );

  const benchmarks = results.map(r =>
    r.status === 'fulfilled' ? r.value : { error: r.reason?.message }
  ).filter(b => !b.error);

  return {
    source: 'Chile-Benchmarks',
    timestamp: new Date().toISOString(),
    benchmarks,
    signals: [],
  };
}

if (process.argv[1]?.endsWith('chile-benchmarks.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
