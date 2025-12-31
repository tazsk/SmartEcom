// config/kroger.js
import axios from 'axios';
import https from 'https';
import { redis } from './redis.js';

const BASE = process.env.KROGER_BASE_URL || 'https://api.kroger.com/v1';
const ID = process.env.KROGER_CLIENT_ID;
const SECRET = process.env.KROGER_CLIENT_SECRET;

const TIMEOUT = Number(process.env.KROGER_TIMEOUT_MS || 8000);

const http = axios.create({
  baseURL: BASE,
  timeout: TIMEOUT,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

// utils
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function slug(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Simple jittered backoff
async function withRetry(fn, { retries = 3, baseMs = 300 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      const code = e?.response?.data?.errors?.code;
      const retryable = status === 429 || (status >= 500 && status <= 599) || String(code).endsWith('-500');
      if (i < retries && retryable) {
        const delay = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 100);
        console.log('[KROGER][RETRY]', { attempt: i + 1, status, code, waitMs: delay });
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

let appToken = null;
let appTokenExp = 0;

async function getAppToken() {
  const now = Math.floor(Date.now() / 1000);
  if (appToken && now < appTokenExp - 60) return appToken;

  const body = new URLSearchParams({ grant_type: 'client_credentials', scope: 'product.compact' });
  const { data } = await withRetry(() =>
    axios.post(`${BASE}/connect/oauth2/token`, body, {
      auth: { username: ID, password: SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: TIMEOUT,
      httpsAgent: new https.Agent({ keepAlive: true }),
    })
  );

  appToken = data.access_token;
  appTokenExp = now + (data.expires_in || 1799);
  return appToken;
}

async function authGet(path, { params } = {}) {
  const token = await getAppToken();
  return withRetry(() =>
    http.get(path, {
      params,
      headers: { Authorization: `Bearer ${token}` },
    })
  );
}

/** ----------------------------- CACHED APIs ----------------------------- **/

// Resolve first nearby store by ZIP (cached 7d)
export async function getLocationIdByZip(zip) {
  const key = `kroger:locid:v1:${slug(zip)}`;
  const hit = await redis.get(key);
  if (hit) return hit;

  const { data } = await authGet('/locations', {
    params: { 'filter.zipCode.near': zip, 'filter.limit': 1 },
  });
  const id = data?.data?.[0]?.locationId || null;
  if (id) await redis.set(key, id, 'EX', 60 * 60 * 24 * 7);
  return id;
}

// Search products, with optional fallback; cached 6h per (term, locId, limit)
export async function searchProductsByTerm(term, { locationId, limit = 10, allowNoLocationFallback = true } = {}) {
  const key = `kroger:search:v1:loc=${locationId || 'none'}:limit=${limit}:q=${slug(term)}`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  const params = { 'filter.term': term, 'filter.limit': limit };
  if (locationId) params['filter.locationId'] = locationId;

  try {
    const { data } = await authGet('/products', { params });
    const list = data?.data || [];
    await redis.set(key, JSON.stringify(list), 'EX', 60 * 60 * 6);
    return list;
  } catch (e) {
    const status = e?.response?.status;
    const code = e?.response?.data?.errors?.code;
    console.log('[KROGER][ERROR]', e?.response?.data || e);
    if (allowNoLocationFallback && locationId && (status >= 500 || status === 429 || String(code).endsWith('-500'))) {
      console.log('[KROGER] Falling back to no location for term:', term);
      const { data } = await authGet('/products', {
        params: { 'filter.term': term, 'filter.limit': limit },
      });
      const list = data?.data || [];
      await redis.set(key, JSON.stringify(list), 'EX', 60 * 60 * 6);
      return list;
    }
    await redis.set(key, JSON.stringify([]), 'EX', 60 * 10); // short cache for negative results
    return [];
  }
}

export default { getLocationIdByZip, searchProductsByTerm };
