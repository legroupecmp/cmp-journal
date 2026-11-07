// Met à jour chaque soir les prix de clôture des titres de tes portefeuilles.
// Lit les titres dans Firestore (invest/data), cherche les prix de clôture, puis écrit prices/latest.
import { pathToFileURL } from 'url';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dernier cours de clôture d'un titre (source : Yahoo Finance, sans clé).
export async function fetchClose(symbol, fetchFn = fetch, wait = sleep) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  let lastErr = 'Erreur inconnue';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) { lastErr = 'HTTP ' + res.status; await wait(2500 * attempt); continue; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const r = json.chart && json.chart.result && json.chart.result[0];
      if (!r) throw new Error((json.chart && json.chart.error && json.chart.error.description) || 'Aucune donnée pour ce symbole');
      const closes = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
      const ts = r.timestamp || [];
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] != null && ts[i] != null) {
          const date = new Date((ts[i] + (r.meta.gmtoffset || 0)) * 1000).toISOString().slice(0, 10);
          return { price: Number(closes[i]), currency: r.meta.currency || 'CAD', date };
        }
      }
      throw new Error('Aucun cours de clôture récent');
    } catch (e) {
      lastErr = e.message || String(e);
      if (attempt < 3) await wait(1500 * attempt);
    }
  }
  throw new Error(lastErr);
}

// Construit la liste des prix en dollars canadiens. Garde l'ancien prix d'un titre si la recherche échoue.
export async function buildPrices(symbols, previous = [], fetchFn = fetch, wait = sleep) {
  const prev = {};
  previous.forEach((p) => { prev[p.symbol] = p; });
  const fx = {};
  const list = [];
  const errors = [];
  for (const symbol of symbols) {
    try {
      const q = await fetchClose(symbol, fetchFn, wait);
      let price = q.price;
      if (q.currency === 'GBp') throw new Error('Devise non prise en charge (GBp)');
      if (q.currency !== 'CAD') {
        if (!fx[q.currency]) fx[q.currency] = (await fetchClose(q.currency + 'CAD=X', fetchFn, wait)).price;
        price = q.price * fx[q.currency];
      }
      list.push({ symbol, price: Math.round(price * 10000) / 10000, native: q.price, currency: q.currency, date: q.date });
    } catch (e) {
      errors.push({ symbol, message: e.message });
      if (prev[symbol]) list.push(prev[symbol]);
    }
    await wait(700);
  }
  return { list, errors };
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.error('Le secret FIREBASE_SERVICE_ACCOUNT est manquant.'); process.exit(1); }
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  initializeApp({ credential: cert(JSON.parse(raw)) });
  const db = getFirestore();

  const inv = await db.doc('invest/data').get();
  const accounts = (inv.exists && inv.data().accounts) || [];
  const symbols = [];
  accounts.forEach((a) => (a.holdings || []).forEach((h) => {
    const s = String(h.symbol || '').trim().toUpperCase();
    if (s && !symbols.includes(s)) symbols.push(s);
  }));
  if (!symbols.length) { console.log('Aucun titre à mettre à jour.'); return; }

  const prevDoc = await db.doc('prices/latest').get();
  const previous = (prevDoc.exists && prevDoc.data().list) || [];
  const { list, errors } = await buildPrices(symbols, previous);
  console.log(`${list.length} prix, ${errors.length} erreur(s).`);
  errors.forEach((e) => console.log(' -', e.symbol, ':', e.message));
  if (errors.length === symbols.length) { console.error('Aucun prix récupéré.'); process.exit(1); }

  await db.doc('prices/latest').set({ updatedAt: new Date().toISOString(), list, errors });
  console.log('prices/latest mis à jour.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
