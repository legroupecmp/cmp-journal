// Met à jour les cotes du bandeau du terminal (indices, Bitcoin, Brent) et les écrit dans Firestore : prices/quotes.
// Source : Yahoo Finance (sans clé). Les indices boursiers ont environ 15 minutes de délai.
import { pathToFileURL } from 'url';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SYMBOLS = [
  { key: 'sp500', name: 'S&P 500', symbol: '^GSPC' },
  { key: 'nasdaq', name: 'Nasdaq', symbol: '^IXIC' },
  { key: 'dow', name: 'Dow Jones', symbol: '^DJI' },
  { key: 'tsx', name: 'TSX', symbol: '^GSPTSE' },
  { key: 'btc', name: 'Bitcoin', symbol: 'BTC-USD' },
  { key: 'brent', name: 'Brent', symbol: 'BZ=F' },
];

export async function fetchQuote(symbol, fetchFn = fetch, wait = sleep) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
  let lastErr = 'Erreur inconnue';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) { lastErr = 'HTTP ' + res.status; await wait(2000 * attempt); continue; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const r = json.chart && json.chart.result && json.chart.result[0];
      if (!r || !r.meta) throw new Error((json.chart && json.chart.error && json.chart.error.description) || 'Aucune donnée');
      const m = r.meta;
      const price = Number(m.regularMarketPrice);
      const prev = Number(m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose);
      if (!isFinite(price) || price <= 0) throw new Error('Prix invalide');
      return { price, prev: isFinite(prev) && prev > 0 ? prev : null, time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null, state: m.marketState || null };
    } catch (e) {
      lastErr = e.message || String(e);
      if (attempt < 3) await wait(1000 * attempt);
    }
  }
  throw new Error(lastErr);
}

export async function buildQuotes(previous = [], fetchFn = fetch, wait = sleep, symbols = SYMBOLS) {
  const prev = {};
  previous.forEach((p) => { prev[p.key] = p; });
  const items = [], errors = [];
  for (const s of symbols) {
    try {
      const q = await fetchQuote(s.symbol, fetchFn, wait);
      const pct = q.prev ? Math.round(((q.price - q.prev) / q.prev) * 10000) / 100 : null;
      items.push({ key: s.key, name: s.name, symbol: s.symbol, price: q.price, prev: q.prev, pct, time: q.time });
    } catch (e) {
      errors.push({ symbol: s.symbol, message: e.message });
      if (prev[s.key]) items.push(prev[s.key]);
    }
    await wait(250);
  }
  return { items, errors };
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.error('Le secret FIREBASE_SERVICE_ACCOUNT est manquant.'); process.exit(1); }
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  initializeApp({ credential: cert(JSON.parse(raw)) });
  const db = getFirestore();
  const old = await db.doc('prices/quotes').get();
  const { items, errors } = await buildQuotes((old.exists && old.data().items) || []);
  console.log(`${items.length} cote(s), ${errors.length} erreur(s).`);
  errors.forEach((e) => console.log(' -', e.symbol, ':', e.message));
  if (errors.length === SYMBOLS.length) { console.error('Aucune cote récupérée.'); process.exit(1); }
  await db.doc('prices/quotes').set({ updatedAt: new Date().toISOString(), items, errors });
  console.log('prices/quotes mis à jour.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
