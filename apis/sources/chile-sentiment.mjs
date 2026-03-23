// Chile Sentiment — Keyword-based + optional LLM sentiment analysis
// Analyzes OSINT data (GDELT, Bluesky, Reddit) for Chile-related financial sentiment
// No API keys required for keyword analysis; LLM analysis requires LLM_PROVIDER in .env

import { safeFetch } from '../utils/fetch.mjs';

// Keywords to filter Chile-related content
const CHILE_KEYWORDS = [
  'chile', 'chilean', 'chileno', 'santiago',
  'copper', 'cobre', 'codelco', 'lithium', 'litio',
  'peso', 'clp', 'usd/clp',
  'banco central', 'central bank chile',
  'ipsa', 'bolsa de santiago',
  'boric', 'gobierno chile',
  'sernac', 'afp', 'isapre',
];

// Sentiment lexicon (financial context)
const POSITIVE_WORDS = [
  'growth', 'rally', 'upgrade', 'surplus', 'recovery', 'gains', 'bullish', 'strong', 'boom', 'record high',
  'alza', 'positivo', 'crecimiento', 'récord', 'superávit', 'mejora', 'fuerte',
  'investment', 'confidence', 'expansion', 'stability',
];

const NEGATIVE_WORDS = [
  'crash', 'crisis', 'downgrade', 'deficit', 'recession', 'losses', 'bearish', 'weak', 'collapse', 'plunge',
  'caída', 'negativo', 'recesión', 'déficit', 'crisis', 'colapso', 'débil',
  'tariff', 'sanctions', 'protest', 'strike', 'instability',
  'arancel', 'sanción', 'protesta', 'huelga', 'inestabilidad',
];

function matchesChileKeywords(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CHILE_KEYWORDS.some(kw => lower.includes(kw));
}

function scoreSentiment(text) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let positive = 0;
  let negative = 0;
  for (const w of POSITIVE_WORDS) {
    if (lower.includes(w)) positive++;
  }
  for (const w of NEGATIVE_WORDS) {
    if (lower.includes(w)) negative++;
  }
  const total = positive + negative;
  return total > 0 ? (positive - negative) / total : 0;
}

function getDirection(score) {
  if (score > 0.2) return 'positivo';
  if (score < -0.2) return 'negativo';
  return 'neutro';
}

async function fetchGdeltChile() {
  // GDELT API for Chile-related news
  const q = encodeURIComponent('chile OR copper OR peso chileno OR santiago');
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=ArtList&maxrecords=30&timespan=24h&format=json&sort=DateDesc`;
  const data = await safeFetch(url, { timeout: 12000 });
  return (data?.articles || []).map(a => ({
    title: a.title || '',
    url: a.url || '',
    source: a.domain || 'GDELT',
    date: a.seendate || '',
  }));
}

async function fetchBlueskyChile() {
  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent('chile copper peso')}&limit=15&sort=latest`;
  const data = await safeFetch(url, { timeout: 8000 });
  return (data?.posts || []).map(p => ({
    text: (p.record?.text || '').slice(0, 200),
    author: p.author?.handle || 'unknown',
    date: p.record?.createdAt || '',
    source: 'Bluesky',
  }));
}

export async function briefing() {
  // Fetch Chile-related content from multiple OSINT sources
  const [gdeltArticles, blueskyPosts] = await Promise.all([
    fetchGdeltChile().catch(() => []),
    fetchBlueskyChile().catch(() => []),
  ]);

  // Combine and filter for Chile relevance
  const allContent = [];

  for (const a of gdeltArticles) {
    if (matchesChileKeywords(a.title)) {
      allContent.push({ text: a.title, source: a.source, date: a.date, type: 'news', url: a.url });
    }
  }

  for (const p of blueskyPosts) {
    if (matchesChileKeywords(p.text)) {
      allContent.push({ text: p.text, source: 'Bluesky', date: p.date, type: 'social' });
    }
  }

  // Score each item
  const scored = allContent.map(item => ({
    ...item,
    score: scoreSentiment(item.text),
  }));

  // Overall score
  const totalScore = scored.length > 0
    ? scored.reduce((sum, s) => sum + s.score, 0) / scored.length
    : 0;
  const roundedScore = Math.round(totalScore * 100) / 100;
  const direction = getDirection(roundedScore);

  // Top mentions (most sentiment-loaded)
  const topMentions = scored
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 8)
    .map(s => ({
      text: s.text.slice(0, 120),
      source: s.source,
      score: s.score,
      type: s.type,
    }));

  const signals = [];

  // Extreme sentiment alert
  if (roundedScore < -0.5 && scored.length >= 3) {
    signals.push({
      type: 'sentiment_negative',
      severity: 'high',
      message: `Sentimiento Chile muy negativo (${roundedScore}) — ${scored.length} artículos analizados`,
    });
  }
  if (roundedScore > 0.5 && scored.length >= 3) {
    signals.push({
      type: 'sentiment_positive',
      severity: 'info',
      message: `Sentimiento Chile muy positivo (${roundedScore}) — ${scored.length} artículos analizados`,
    });
  }

  return {
    source: 'Chile-Sentiment',
    timestamp: new Date().toISOString(),
    keyword_score: roundedScore,
    keyword_direction: direction,
    articles_analyzed: scored.length,
    news_count: gdeltArticles.length,
    social_count: blueskyPosts.length,
    chile_mentions: topMentions,
    signals,
  };
}

if (process.argv[1]?.endsWith('chile-sentiment.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
