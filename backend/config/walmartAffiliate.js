// config/walmartAffiliate.js (ESM)
// Adds Redis caching to rawSearch()

import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { redis } from './redis.js';

const BASE_URL =
  process.env.WM_API_BASE_URL ||
  'https://developer.api.walmart.com/api-proxy/service/affil/product/v2';

const WM_CONSUMER_ID = process.env.WM_CONSUMER_ID || '';
const WM_KEY_VERSION = (process.env.WM_KEY_VERSION || '1').toString();
const KEY_PATH = process.env.WM_PRIVATE_KEY_PATH || '';
const PASSPHRASE = process.env.WM_PRIVATE_KEY_PASSPHRASE || undefined;

if (!WM_CONSUMER_ID) console.warn('[WALMART] WM_CONSUMER_ID is not set.');
if (!KEY_PATH) console.warn('[WALMART] WM_PRIVATE_KEY_PATH is not set.');

// Lazily parsed key
let PRIVATE_KEY_OBJ = null;
function getPrivateKey() {
  if (PRIVATE_KEY_OBJ) return PRIVATE_KEY_OBJ;
  if (!KEY_PATH) throw new Error('WM_PRIVATE_KEY_PATH not configured');

  const resolved = path.isAbsolute(KEY_PATH) ? KEY_PATH : path.resolve(process.cwd(), KEY_PATH);
  const pem = fs.readFileSync(resolved, 'utf8').replace(/\r\n/g, '\n');
  try {
    PRIVATE_KEY_OBJ = crypto.createPrivateKey({ key: pem, format: 'pem', passphrase: PASSPHRASE });
    return PRIVATE_KEY_OBJ;
  } catch (e) {
    console.error(
      `[WALMART] Failed to parse private key at ${resolved}.` +
        ' If encrypted, set WM_PRIVATE_KEY_PASSPHRASE; otherwise convert to unencrypted PKCS#8: ' +
        'openssl pkcs8 -topk8 -nocrypt -in in.pem -out out.pem'
    );
    throw e;
  }
}

// Signature base has trailing newline
function sign(tsMs) {
  const base = `${WM_CONSUMER_ID}\n${tsMs}\n${WM_KEY_VERSION}\n`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(base, 'utf8');
  signer.end();
  return signer.sign(getPrivateKey()).toString('base64');
}

export function getWalmartHeaders() {
  const ts = Date.now().toString();
  return {
    'WM_CONSUMER.ID': WM_CONSUMER_ID,
    'WM_CONSUMER.INTIMESTAMP': ts,
    'WM_SEC.KEY_VERSION': WM_KEY_VERSION,
    'WM_SEC.AUTH_SIGNATURE': sign(ts),
    Accept: 'application/json',
  };
}

/* ----------------------------- HTTP helper ----------------------------- */
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/\s+/g, ' ').trim();
}

export async function rawSearch(term) {
  if (!WM_CONSUMER_ID || !KEY_PATH) return [];
  const key = `wm:search:v1:q=${norm(term)}`;
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit);

  const url = `${BASE_URL}/search?query=${encodeURIComponent(term)}`;
  try {
    const { data } = await axios.get(url, { headers: getWalmartHeaders(), timeout: 10000 });
    const items = Array.isArray(data?.items) ? data.items : [];
    await redis.set(key, JSON.stringify(items), 'EX', 60 * 60 * 12); // 12h
    return items;
  } catch (e) {
    console.warn('[Walmart] search error:', term, e?.response?.status || e.message);
    await redis.set(key, JSON.stringify([]), 'EX', 60 * 10); // short negative cache
    return [];
  }
}

/* -------------------------- List-free ranking -------------------------- */
function normalizeStr(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[®™]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  return new Set(normalizeStr(s).split(' ').filter(Boolean));
}

function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter++;
  const uni = aSet.size + bSet.size - inter;
  return inter / uni;
}

function scoreItem(item, term) {
  const name = item?.name || '';
  const cat = item?.categoryPath || '';
  const upc = item?.upc || '';
  const price = typeof item?.salePrice === 'number' ? item.salePrice : null;

  const termT = tokens(term);
  const nameT = tokens(name);
  const catT = tokens(cat);

  const nameSim = jaccard(termT, nameT);
  const catSim = jaccard(termT, catT);

  let score = 0;
  score += Math.round(nameSim * 100);
  score += Math.round(catSim * 40);
  if (upc && /^\d{8,14}$/.test(upc)) score += 8;
  if (price !== null) score += 5;
  if (/\b(ground|whole|pure|organic|unflavored|plain)\b/.test(normalizeStr(name))) score += 2;

  return score;
}

function pickTop(items, term, limit = 2) {
  const scored = items
    .map((it) => ({ it, s: scoreItem(it, term) }))
    .sort((a, b) => b.s - a.s);

  const top = scored.slice(0, Math.max(0, Math.min(limit, 2))).map((x) => x.it);

  top.sort((a, b) => {
    const pa = typeof a?.salePrice === 'number' ? a.salePrice : Number.POSITIVE_INFINITY;
    const pb = typeof b?.salePrice === 'number' ? b.salePrice : Number.POSITIVE_INFINITY;
    return pa - pb;
  });

  return top;
}

/* ----------------------------- Normalizer ------------------------------ */
export function normalize(item) {
  return {
    _id: `wm_${item?.itemId ?? item?.upc ?? crypto.randomUUID()}`,
    title: item?.name || 'Product',
    imageUrl: item?.mediumImage || item?.largeImage || item?.thumbnailImage || '',
    price:
      typeof item?.salePrice === 'number'
        ? item.salePrice
        : typeof item?.msrp === 'number'
        ? item.msrp
        : 0,
    upc: item?.upc || '',
    retailer: 'walmart',
    url: (item?.productTrackingUrl || item?.productUrl || '').toString(),
    raw: item,
  };
}

/* ------------------------------ Public API ----------------------------- */
export async function searchByTerm(term, { perTermLimit = 2 } = {}) {
  const items = await rawSearch(term);
  return pickTop(items, term, perTermLimit).map(normalize);
}

export async function searchUnmatched(terms = [], { perTermLimit = 2 } = {}) {
  const uniq = Array.from(new Set((terms || []).filter(Boolean)));
  if (!uniq.length) return [];

  const perTerm = await Promise.all(
    uniq.map(async (t) => pickTop(await rawSearch(t), t, perTermLimit).map(normalize))
  );

  const out = [];
  const seen = new Set();
  for (const arr of perTerm) {
    for (const n of arr) {
      const key = (n.upc && `u:${n.upc}`) || `t:${normalizeStr(n.title)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(n);
    }
  }
  return out;
}

export default { getWalmartHeaders, searchByTerm, searchUnmatched, rawSearch, normalize };
