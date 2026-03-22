// Chile DAP — Deposit rates from CMF (Comisión para el Mercado Financiero)
// Sources: CMF public API (system average rates), mindicadores.cl fallback
// Reads portfolio.json to track DAP maturity dates
// No API keys required

import { safeFetch } from '../utils/fetch.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTFOLIO_PATH = process.env.PORTFOLIO_PATH || resolve(__dirname, '..', '..', 'portfolio.json');

const CMF_BASE = 'https://api.cmfchile.cl/api-sbifv3/recursos_api';
const MINDICADORES = 'https://mindicadores.cl/api';

// CMF API uses format=json and requires apikey param but works with empty key for public endpoints
async function fetchCmfRates() {
  // Try to get capture rates (tasas de captación) from CMF
  // These are system-average deposit rates published by SBIF/CMF
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');

  const endpoints = [
    { term: '30d', path: `/tasa_deposito_plazo/30/periodo/${year}/${month}` },
    { term: '90d', path: `/tasa_deposito_plazo/90/periodo/${year}/${month}` },
    { term: '180d', path: `/tasa_deposito_plazo/180/periodo/${year}/${month}` },
    { term: '360d', path: `/tasa_deposito_plazo/360/periodo/${year}/${month}` },
  ];

  const results = {};

  for (const { term, path } of endpoints) {
    const url = `${CMF_BASE}${path}?apikey=&formato=json`;
    const data = await safeFetch(url, { timeout: 10000 });

    if (data?.error) {
      results[term] = null;
      continue;
    }

    // CMF returns array of daily rates, take the most recent
    const rates = data?.TasaDepositos?.TasaDeposito || data?.Tasas || [];
    const latest = Array.isArray(rates) ? rates[rates.length - 1] : rates;
    results[term] = latest?.Valor != null ? parseFloat(latest.Valor) : null;
  }

  return results;
}

async function fetchMindicadoresFallback() {
  // Mindicadores doesn't have DAP rates specifically, but has TPM which correlates
  const data = await safeFetch(MINDICADORES, { timeout: 10000 });
  if (data?.error) return null;
  return {
    tpm: data?.tpm?.valor || null,
    note: 'DAP rates from CMF unavailable, showing TPM as reference',
  };
}

function loadPortfolioDaps() {
  try {
    const raw = readFileSync(PORTFOLIO_PATH, 'utf-8');
    const portfolio = JSON.parse(raw);

    const daps = [];
    for (const alloc of portfolio.allocations || []) {
      for (const pos of alloc.positions || []) {
        if (pos.type === 'dap' && pos.maturity_date) {
          const maturity = new Date(pos.maturity_date);
          const today = new Date();
          const daysRemaining = Math.ceil((maturity - today) / (1000 * 60 * 60 * 24));

          daps.push({
            name: pos.name,
            currency: pos.currency,
            amount: pos.currency === 'USD' ? pos.amount_usd : pos.amount_clp,
            rate_annual_pct: pos.rate_annual_pct,
            maturity_date: pos.maturity_date,
            days_remaining: daysRemaining,
            status: daysRemaining < 0 ? 'matured' : daysRemaining <= 7 ? 'maturing_soon' : 'active',
          });
        }
      }
    }
    return daps;
  } catch (e) {
    return [{ error: `Could not load portfolio: ${e.message}` }];
  }
}

function determineTrend(rates) {
  // Simple trend based on available rates (ascending maturity = higher rate = normal)
  const vals = Object.values(rates).filter(v => v != null);
  if (vals.length < 2) return 'unknown';

  // Compare short vs long term rates
  const short = rates['30d'];
  const long = rates['180d'] || rates['360d'];
  if (short == null || long == null) return 'unknown';
  if (long > short + 0.3) return 'normal';
  if (short > long + 0.3) return 'inverted';
  return 'flat';
}

export async function briefing() {
  let rates = await fetchCmfRates();

  // If all CMF rates are null, try fallback
  const allNull = Object.values(rates).every(v => v == null);
  let fallback = null;
  if (allNull) {
    fallback = await fetchMindicadoresFallback();
  }

  const portfolioDaps = loadPortfolioDaps();
  const trend = determineTrend(rates);

  const signals = [];

  // DAP maturity alerts
  for (const dap of portfolioDaps) {
    if (dap.status === 'maturing_soon') {
      signals.push({
        type: 'dap_renewal_alert',
        severity: 'high',
        message: `${dap.name} matures in ${dap.days_remaining} days (${dap.maturity_date})`,
      });
    }
    if (dap.status === 'matured') {
      signals.push({
        type: 'dap_matured',
        severity: 'high',
        message: `${dap.name} has matured — renew or reallocate`,
      });
    }
  }

  // Inverted curve warning
  if (trend === 'inverted') {
    signals.push({
      type: 'dap_curve_inverted',
      severity: 'medium',
      message: 'Short-term DAP rates exceed long-term — inverted yield curve',
    });
  }

  return {
    source: 'Chile-DAP',
    timestamp: new Date().toISOString(),
    rates,
    trend,
    curve_note: trend === 'normal' ? 'Higher rates for longer terms (normal)' :
                trend === 'inverted' ? 'Short-term rates higher than long-term (unusual)' :
                trend === 'flat' ? 'Similar rates across all terms' : 'Insufficient data',
    portfolio_daps: portfolioDaps,
    fallback,
    signals,
  };
}

if (process.argv[1]?.endsWith('chile-dap.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
