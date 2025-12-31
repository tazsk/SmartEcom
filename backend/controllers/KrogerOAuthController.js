// controllers/KrogerOAuthController.js
import crypto from 'crypto';
import axios from 'axios';
import mongoose from 'mongoose';
import User from '../models/User.js';

const BASE = process.env.KROGER_BASE_URL || 'https://api.kroger.com/v1';
const ID = process.env.KROGER_CLIENT_ID;
const SECRET = process.env.KROGER_CLIENT_SECRET;
const REDIRECT = process.env.KROGER_REDIRECT_URI;

// Request only the scopes you actually registered
const SCOPES = process.env.KROGER_SCOPES || 'cart.basic:write product.compact';

const APP_SECRET = process.env.JWT_SECRET || process.env.APP_SECRET || 'dev-secret';

// ---- helpers (unchanged) ----
function b64u(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64uJson(obj) { return b64u(JSON.stringify(obj)); }
function parseB64u(str) {
  return JSON.parse(Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}
function sign(stateObj) {
  const body = b64uJson(stateObj);
  const sig = crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verify(state) {
  try {
    if (!state || !state.includes('.')) return null;
    const [body, sig] = state.split('.');
    const good = crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
    if (sig !== good) return null;
    return parseB64u(body);
  } catch { return null; }
}

function isTokenValid(kroger) {
  if (!kroger?.accessToken || !kroger?.expiresAt) return false;
  return new Date(kroger.expiresAt).getTime() - Date.now() > 60_000;
}

async function refreshWithRefreshToken(user) {
  if (!user?.kroger?.refreshToken) return null;
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: user.kroger.refreshToken,
    scope: SCOPES,
  });
  const auth = Buffer.from(`${ID}:${SECRET}`).toString('base64');
  const { data } = await axios.post(`${BASE}/connect/oauth2/token`, form, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
  });

  user.kroger.accessToken = data.access_token;
  user.kroger.refreshToken = data.refresh_token || user.kroger.refreshToken;
  user.kroger.expiresAt = new Date(Date.now() + data.expires_in * 1000);
  await user.save();

  return user.kroger.accessToken;
}

async function getValidUserToken(user) {
  if (isTokenValid(user?.kroger)) return user.kroger.accessToken;
  if (user?.kroger?.refreshToken) {
    try { return await refreshWithRefreshToken(user); } catch { /* ignore */ }
  }
  return null;
}

function buildAuthorizeUrl(stateObj) {
  const state = sign(stateObj);
  const params = new URLSearchParams({
    scope: SCOPES,
    response_type: 'code',
    client_id: ID,
    redirect_uri: REDIRECT,
    state,
  });
  return `${BASE}/connect/oauth2/authorize?${params.toString()}`;
}

/* ------------------------- OAuth: Login & Callback ------------------------- */

// GET /kroger/oauth/login   (UNPROTECTED)
export function krogerLogin(req, res) {
  // allow calling this while authenticated OR by passing ?uid=
  const uid = req.query.uid || (req.user && String(req.user._id));
  const returnTo = req.query.returnTo || '/';

  if (!uid) {
    return res.status(400).json({ error: 'Missing uid: provide ?uid=... or call while authenticated' });
  }

  let customState = {};
  if (req.query.state) {
    try {
      customState = verify(req.query.state) || JSON.parse(req.query.state);
    } catch { /* ignore */ }
  }

  const stateObj = { userId: uid, returnTo, t: Date.now(), ...customState };
  return res.redirect(buildAuthorizeUrl(stateObj));
}

// GET /kroger/oauth/callback   (UNPROTECTED)
export async function krogerCallback(req, res) {
  const { code, state } = req.query;
  const decoded = verify(state);

  if (!decoded?.userId) {
    return res.status(400).json({ error: 'Missing user context in OAuth state' });
  }
  if (!mongoose.Types.ObjectId.isValid(decoded.userId)) {
    return res.status(400).json({ error: 'Invalid user id in OAuth state' });
  }

  const user = await User.findById(decoded.userId);
  if (!user) return res.status(400).json({ error: 'User not found' });

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
  });
  const auth = Buffer.from(`${ID}:${SECRET}`).toString('base64');

  try {
    const { data } = await axios.post(`${BASE}/connect/oauth2/token`, form, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${auth}`,
      },
    });

    user.kroger = user.kroger || {};
    user.kroger.accessToken = data.access_token;
    user.kroger.refreshToken = data.refresh_token || user.kroger.refreshToken;
    user.kroger.expiresAt = new Date(Date.now() + data.expires_in * 1000);
    await user.save();

    // handle "add_to_cart" intent encoded in state (optional)
    if (decoded?.action === 'add_to_cart' && Array.isArray(decoded.items) && decoded.items.length) {
      try {
        await axios.put(`${BASE}/cart/add`, { items: decoded.items }, {
          headers: { Authorization: `Bearer ${user.kroger.accessToken}` },
        });

        // update local snapshot so UI can show “In Cart: X”
        user.kroger.cartSnapshot = user.kroger.cartSnapshot || new Map();
        for (const it of decoded.items) {
          const prev = Number(user.kroger.cartSnapshot.get(it.upc) || 0);
          user.kroger.cartSnapshot.set(it.upc, prev + Number(it.quantity || 1));
        }
        await user.save();

        const rt = decoded.returnTo || '/';
        return res.redirect(`${rt}${rt.includes('?') ? '&' : '?'}kroger=added`);
      } catch {
        const rt = decoded.returnTo || '/';
        return res.redirect(rt);
      }
    }

    return res.redirect(decoded?.returnTo || '/');
  } catch (e) {
    console.error('[Kroger OAuth Callback] error', e?.response?.data || e.message);
    return res.status(500).json({ error: 'OAuth exchange failed' });
  }
}

/* ----------------------------- Cart endpoints ----------------------------- */

// controllers/KrogerOAuthController.js

export async function addToKrogerCart(req, res) {
  try {
    const user = await User.findById(req.user._id);
    const { items } = req.body;

    let token = await getValidUserToken(user);
    if (!token) {
      const loginUrl = buildAuthorizeUrl({
        userId: String(user._id),
        action: 'add_to_cart',
        items,
        returnTo: req.get('referer') || req.query.returnTo || '/',
        t: Date.now(),
      });
      return res.status(401).json({ needKrogerAuth: true, loginUrl });
    }

    // Ensure snapshot exists
    user.kroger = user.kroger || {};
    user.kroger.cartSnapshot = user.kroger.cartSnapshot || new Map();

    const toRemove = [];
    const toAdd = [];

    // Partition work: positives -> add, negatives -> remove then add desired
    for (const it of items || []) {
      const upc = String(it.upc);
      const delta = Number(it.quantity ?? 1);

      const prev = Number(user.kroger.cartSnapshot.get(upc) || 0);
      const desired = Math.max(0, prev + delta);

      if (delta >= 0) {
        if (delta > 0) toAdd.push({ upc, quantity: delta });
        user.kroger.cartSnapshot.set(upc, prev + delta);
      } else {
        // Negative delta: clear then (re)add desired amount
        toRemove.push({ upc });
        if (desired > 0) toAdd.push({ upc, quantity: desired });

        if (desired > 0) user.kroger.cartSnapshot.set(upc, desired);
        else user.kroger.cartSnapshot.delete(upc);
      }
    }

    const headers = { Authorization: `Bearer ${token}` };

    // Order matters: remove first, then add
    if (toRemove.length) {
      await axios.put(`${BASE}/cart/remove`, { items: toRemove }, { headers });
    }
    let data = null;
    if (toAdd.length) {
      const resp = await axios.put(`${BASE}/cart/add`, { items: toAdd }, { headers });
      data = resp.data;
    }

    await user.save();
    return res.json({ ok: true, data });
  } catch (e) {
    console.error('[Kroger addToCart] error', e?.response?.data || e.message);
    res.status(500).json({ error: 'Failed to add to Kroger cart' });
  }
}

export async function getKrogerCartSnapshot(req, res) {
  const user = await User.findById(req.user._id);
  const m = user?.kroger?.cartSnapshot || new Map();

  const obj = {};
  if (m instanceof Map) {
    for (const [k, v] of m.entries()) obj[String(k)] = Number(v);
  } else {
    for (const [k, v] of Object.entries(m)) obj[String(k)] = Number(v);
  }
  return res.json({ items: obj });
}
