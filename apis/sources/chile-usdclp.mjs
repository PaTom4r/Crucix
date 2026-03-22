// Chile USD/CLP & Macro Indicators
// Sources: Yahoo Finance (USDCLP=X), mindicadores.cl (UF, TPM, IPC, UTM, cobre)
// No API keys required — all public endpoints

import { safeFetch, daysAgo } from '../utils/fetch.mjs';

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const MINDICADORES = 'https://mindicadores.cl/api';

async function fetchUsdClp() {
  const url = `${YAHOO_BASE}/USDCLP%3DX?range=1mo&interval=1d&includePrePost=false`;
  const data = await safeFetch(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });

  const result = data?.chart?.result?.[0];
  if (!result) return { error: 'No USDCLP data from Yahoo Finance' };

  const meta = result.meta || {};
  const quotes = result.indicators?.quote?.[0] || {};
  const closes = quotes.close || [];
  const timestamps = result.timestamp || [];

  const current = meta.regularMarketPrice ?? closes[closes.length - 1];
  const prevClose = meta.chartPreviousClose ?? closes[closes.length - 2];
  const open = quotes.open?.[quotes.open.length - 1];
  const high = quotes.high?.[quotes.high.length - 1];
  const low = quotes.low?.[quotes.low.length - 1];
  const changePct = prevClose ? ((current - prevClose) / prevClose) * 100 : 0;

  const history = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] != null) {
      history.push({
        date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
        close: Math.round(closes[i] * 100) / 100,
      });
    }
  }

  return {
    current: Math.round(current * 100) / 100,
    prevClose: Math.round((prevClose || 0) * 100) / 100,
    open: open ? Math.round(open * 100) / 100 : null,
    high: high ? Math.round(high * 100) / 100 : null,
    low: low ? Math.round(low * 100) / 100 : null,
    change_pct: Math.round(changePct * 100) / 100,
    history_30d: history,
  };
}

async function fetchMindicadores() {
  const data = await safeFetch(MINDICADORES, { timeout: 10000 });
  if (data?.error) return { error: data.error };

  const pick = (key) => {
    const item = data?.[key];
    return item ? { value: item.valor, unit: item.unidad_medida, date: item.fecha } : null;
  };

  return {
    uf: pick('uf'),
    tpm: pick('tpm'),
    ipc: pick('ipc'),
    utm: pick('utm'),
    euro: pick('euro'),
    dolar: pick('dolar'),
    copper_clp: pick('cobre'),
  };
}

export async function briefing() {
  const [usdclp, indicators] = await Promise.all([
    fetchUsdClp(),
    fetchMindicadores(),
  ]);

  const signals = [];

  // USD/CLP level alerts
  if (usdclp.current && usdclp.current > 1000) {
    signals.push({ type: 'usdclp_high', severity: 'high', message: `USD/CLP at ${usdclp.current} — above $1,000 threshold` });
  }
  if (usdclp.current && usdclp.current < 850) {
    signals.push({ type: 'usdclp_low', severity: 'medium', message: `USD/CLP at ${usdclp.current} — below $850 threshold` });
  }

  // Daily spike alert
  if (Math.abs(usdclp.change_pct) > 2) {
    signals.push({ type: 'usdclp_spike', severity: 'high', message: `USD/CLP moved ${usdclp.change_pct > 0 ? '+' : ''}${usdclp.change_pct}% today` });
  }

  // TPM change detection (store last known in signal for dashboard to compare)
  if (indicators.tpm?.value != null) {
    signals.push({ type: 'tpm_current', severity: 'info', message: `TPM at ${indicators.tpm.value}%` });
  }

  return {
    source: 'Chile-USDCLP',
    timestamp: new Date().toISOString(),
    usdclp,
    indicators,
    signals,
  };
}

if (process.argv[1]?.endsWith('chile-usdclp.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
