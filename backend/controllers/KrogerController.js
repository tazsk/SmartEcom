// controllers/KrogerController.js
// NOTE: Original behavior preserved.
// Additions:
// 1) Dish-level "forever" cache (short-circuits whole pipeline on repeat searches)
// 2) Existing Redis caches for LLM #1 and LLM #2 remain unchanged.

import axios from 'axios';
import crypto from 'crypto';
import openai from '../config/openai.js';
import Kroger from '../config/kroger.js';
import User from '../models/User.js';
import { redis } from '../config/redis.js';
import {
  getWalmartHeaders,
  rawSearch as walmartRawSearch,
  normalize as normalizeWalmart,
} from '../config/walmartAffiliate.js';

/* ============================== Helpers ============================== */
function nowMs() { return Date.now(); }
function msSince(t0) { return `${Date.now() - t0}ms`; }
function logHeader(title) { console.log(`\n===== ${title} =====`); }
function logKV(label, value, maxLen = 500) {
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    console.log(label, s.length > maxLen ? `${s.slice(0, maxLen)}… (${s.length} chars)` : s);
  } catch { console.log(label, value); }
}
function safeJSONParse(text, fallback) {
  try {
    if (text && typeof text === 'object') return text; // already parsed
    const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '');
    return JSON.parse(cleaned);
  } catch { return fallback; }
}
function pickBestImage(p) {
  const prefOrder = ['xlarge', 'large', 'medium', 'small', 'thumbnail'];
  const imgs = Array.isArray(p.images) ? p.images : [];
  const front = imgs.find((i) => i.perspective === 'front') || {};
  const sizes = [...(front.sizes || []), ...imgs.filter((i) => i !== front).flatMap((i) => i.sizes || [])];
  if (!sizes.length) return '';
  sizes.sort((a, b) => prefOrder.indexOf(a.size || '') - prefOrder.indexOf(b.size || ''));
  return sizes[0]?.url || '';
}
function normalizeKroger(p, locationId) {
  const img = pickBestImage(p);
  const price = p.items?.[0]?.price?.promo ?? p.items?.[0]?.price?.regular ?? 0;
  return {
    _id: p.productId,
    title: p.description,
    imageUrl: img,
    price,
    category: p.categories?.[0] || '',
    description: p.brand,
    upc: p.upc,
    locationId,
  };
}
function normTitle(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[®™]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim();
}
function normQuery(q) {
  return String(q || '').toLowerCase().normalize('NFKD').replace(/\s+/g, ' ').trim();
}

/* ======================== Responses API Utils ======================== */
function buildResponsesInput(messages) {
  return messages.map(({ role, content }) => ({
    role,
    content: [{ type: 'input_text', text: String(content ?? '') }],
  }));
}
function extractResponsesText(resp) {
  if (typeof resp?.output_parsed !== 'undefined') return resp.output_parsed;
  if (typeof resp?.output_text === 'string' && resp.output_text.length) return resp.output_text;
  const source = resp?.output || resp?.data?.output || [];
  const parts = [];
  for (const item of source) {
    for (const c of item?.content || []) {
      if (typeof c?.parsed !== 'undefined') return c.parsed;
      if (typeof c?.json !== 'undefined') return c.json;
      if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
      else if (typeof c?.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('');
}
/** GPT-5 JSON helper (Responses API) */
async function callGPT5JSON(messages, { maxTokens = 4000, schema = null } = {}) {
  const input = buildResponsesInput(messages);
  const textFormat = schema
    ? { type: 'json_schema', name: schema.name, strict: true, schema: schema.schema }
    : { type: 'json_object' };
  if (!(openai && typeof openai.responses?.create === 'function')) {
    throw new Error('OpenAI SDK does not support Responses API. Please upgrade the "openai" package.');
  }
  const payload = {
    model: 'gpt-5',
    input,
    top_p: 1,
    max_output_tokens: maxTokens,
    reasoning: { effort: 'low' },
    text: { format: textFormat, verbosity: 'low' },
  };
  if (payload.text.format?.type === 'json_schema') {
    const sch = payload.text.format.schema;
    const keys = Object.keys(sch?.properties || {});
    if (!Array.isArray(sch.required) || keys.some((k) => !sch.required.includes(k))) sch.required = keys;
  }
  const t0 = nowMs();
  const resp = await openai.responses.create(payload);
  console.log(`[DEBUG] Responses.create finished in ${msSince(t0)} (max_output_tokens=${maxTokens})`);
  return extractResponsesText(resp);
}

/* ===================== Dish-level "forever" cache ===================== */
// bump to invalidate all saved dish results
const DISHCACHE_VERSION = 'v1';

/* ===================== Shared Search Pipeline (Kroger) ===================== */
async function runKrogerSearchPipeline({
  query,
  zip,
  user,
  onPhase,
  passCount = 20,
  chooseMax = 2,
}) {
  const sendPhase = (p) => { if (typeof onPhase === 'function') onPhase(p); };

  logHeader('KROGER PIPELINE START');
  logKV('[INPUT] query:', query);
  logKV('[INPUT] zip:', zip);

  // ---- FAST-PATH: dish-level forever cache (skips whole pipeline on repeat) ----
  const qNorm = normQuery(query);
  const zipKey = (zip && String(zip).trim()) || 'none';
  const fastKey = `dishcache:${DISHCACHE_VERSION}:q=${qNorm}:zip=${zipKey}:max=${Math.max(1, Math.min(2, chooseMax))}`;
  try {
    const fast = await redis.get(fastKey);
    if (fast) {
      console.log('[CACHE] DISH HIT', fastKey);
      return JSON.parse(fast);
    }
  } catch (e) {
    console.warn('[CACHE] dish fast-read failed:', e?.message || e);
  }

  /* -------- PHASE 1: Ingredient extraction (LLM #1) -------- */
  sendPhase('finding');
  console.log('[PHASE] finding ingredients…');

  const messages1 = [
    {
      role: 'system',
      content:
        'You are a grocery ingredient expander for a recipe shopping app. Return ONLY raw JSON as specified. No prose. No code fences.',
    },
    {
      role: 'user',
      content: `
Classify the user query as either (A) a prepared dish/recipe or (B) a single grocery ingredient, and respond as follows:

• If it is a single grocery ingredient (possibly in a regional language), translate to plain English and return ONLY:
  ["<ingredient>"]

• Otherwise, if it is a prepared dish/recipe, return ONLY:
  ["<dish name in English>", "<ingredient 1>", "<ingredient 2>", ...]  ← concise core ingredients required to cook the dish

If uncertain, return ONLY: []

Output rules:
- Use plain English nouns in singular form.
- Prefer base ingredient names over processed forms unless the cooking technique clearly requires the processed form.
- Exclude water, brands, measurements, and meta phrases such as "to taste".
- Avoid umbrella terms; list concrete items.
- Provide a comprehensive list of ingredients. Do not skip cooking essentials.
- Return ONLY raw JSON as: {"result": [ ... ]}.

Query: ${query}
      `.trim(),
    },
  ];

  // --- Redis cache for LLM #1 (dish -> ingredients) ---
  const keyLLM1 = `llm1:ingredients:v1:model=gpt-5:q=${normQuery(query)}`;
  let dishName;
  let ingredients;

  const cachedLLM1 = await redis.get(keyLLM1);
  if (cachedLLM1) {
    const arr = JSON.parse(cachedLLM1);
    const dishDetected = Array.isArray(arr) && arr.length > 1;
    dishName = dishDetected ? arr[0] : null;
    ingredients = Array.isArray(arr) ? (dishDetected ? arr.slice(1) : arr) : [];
    console.log('[CACHE] LLM1 HIT', keyLLM1);
  } else {
    const tFinding = nowMs();
    const llm1Raw = await callGPT5JSON(messages1, {
      maxTokens: 4000,
      schema: {
        name: 'ingredients_payload',
        schema: {
          type: 'object',
          properties: { result: { type: 'array', items: { type: 'string' } } },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    console.log(`[DEBUG] LLM1 completed in ${msSince(tFinding)}`);
    logKV('[DEBUG] LLM1 RAW:', llm1Raw);

    const parsed1 = safeJSONParse(llm1Raw, { result: [] });
    const arr = Array.isArray(parsed1) ? parsed1 : parsed1 && Array.isArray(parsed1.result) ? parsed1.result : [];
    const dishDetected = Array.isArray(arr) && arr.length > 1;
    dishName = dishDetected ? arr[0] : null;
    ingredients = Array.isArray(arr) ? (dishDetected ? arr.slice(1) : arr) : [];

    await redis.set(keyLLM1, JSON.stringify(dishDetected ? [dishName, ...ingredients] : ingredients), 'EX', 60 * 60 * 24 * 30);
  }

  console.log('[DEBUG] dishDetected:', !!dishName, '| dishName:', dishName);
  console.log('[DEBUG] ingredients:', ingredients);

  if (!ingredients.length) {
    console.log('[WARN] No ingredients parsed. Ending early.');
    const early = {
      products: [],
      warnings: ['no_ingredients'],
      dishName,
      ingredients: [],
      matchedInKroger: [],
      krogerCandidateCounts: {},
      krogerMatchedByIngredient: {},
    };
    try { await redis.set(fastKey, JSON.stringify(early)); console.log('[CACHE] DISH SET (early no_ingredients)', fastKey); } catch {}
    return early;
  }

  /* -------- PHASE 2: Fetching candidates (Kroger) -------- */
  sendPhase('fetching');
  console.log('[PHASE] fetching Kroger products…');

  const userDoc = user ? await User.findById(user._id).lean() : null;
  const locationId =
    userDoc?.kroger?.locationId || (await Kroger.getLocationIdByZip(zip || process.env.KROGER_DEFAULT_ZIP));
  console.log('[DEBUG] locationId:', locationId, '| from user:', Boolean(userDoc?.kroger?.locationId));

  const titlesByIng = {};
  const fullByIng = {};
  const warnings = [];

  for (const ing of ingredients) {
    try {
      const tIng = nowMs();
      const limit = Math.max(passCount, 20);
      console.log(`[FETCH] searching products for "${ing}" (limit=${limit})…`);
      const list = await Kroger.searchProductsByTerm(ing, {
        locationId,
        limit,
        allowNoLocationFallback: true,
      });
      console.log(`[FETCH] "${ing}" -> ${list.length} items in ${msSince(tIng)}`);

      fullByIng[ing] = list;
      titlesByIng[ing] = list.map((p) => p.description).slice(0, passCount);

      if ((titlesByIng[ing] || []).length === 0) {
        warnings.push({ ingredient: ing, error: 'no_candidates' });
      }

      console.log(`[CANDIDATES] "${ing}" (${titlesByIng[ing].length}):`, titlesByIng[ing]);
    } catch (e) {
      const payload = e?.response?.data || e?.message || String(e);
      console.log('[ERROR] PRODUCTS SEARCH FAILED:', { ingredient: ing, payload });
      warnings.push({ ingredient: ing, error: 'product_search_failed', payload });
      fullByIng[ing] = [];
      titlesByIng[ing] = [];
    }
  }

  const totalCandidates = Object.values(fullByIng).reduce((n, a) => n + (a?.length || 0), 0);
  console.log('[DEBUG] totalCandidates across all ingredients:', totalCandidates);
  if (!totalCandidates) {
    console.log('[WARN] No product candidates found across all ingredients.');
    const early = {
      products: [],
      warnings: warnings.length ? warnings : ['no_candidates'],
      dishName,
      ingredients,
      matchedInKroger: [],
      krogerCandidateCounts: {},
      krogerMatchedByIngredient: {},
    };
    try { await redis.set(fastKey, JSON.stringify(early)); console.log('[CACHE] DISH SET (early no_candidates)', fastKey); } catch {}
    return early;
  }

  /* -------- Work list: only ingredients that HAVE candidates -------- */
  const ingList = ingredients.filter((i) => (titlesByIng[i] || []).length > 0);
  if (!ingList.length) {
    console.log('[WARN] No ingredients have candidates. Ending.');
    const early = {
      products: [],
      warnings: warnings.length ? warnings : ['no_candidates'],
      dishName,
      ingredients,
      matchedInKroger: [],
      krogerCandidateCounts: {},
      krogerMatchedByIngredient: {},
    };
    try { await redis.set(fastKey, JSON.stringify(early)); console.log('[CACHE] DISH SET (early none have candidates)', fastKey); } catch {}
    return early;
  }

  /* -------- PHASE 3: LLM #2 chooses by INDEX (not by string) -------- */
  sendPhase('matching');
  console.log('[PHASE] matching products with LLM (index-based)…');

  const enumerated = {};
  for (const ing of ingList) {
    enumerated[ing] = titlesByIng[ing].map((t, idx) => `${idx}: ${t}`);
  }

  // Redis cache for LLM #2 (index picks), keyed by candidate fingerprint
  const fp = crypto.createHash('sha1').update(JSON.stringify({ ingList, enumerated, chooseMax })).digest('hex');
  const keyLLM2 = `llm2:match:v1:model=gpt-5:max=${Math.max(1, Math.min(2, chooseMax))}:fp=${fp}`;

  let entries;
  const cachedLLM2 = await redis.get(keyLLM2);
  if (cachedLLM2) {
    console.log('[CACHE] LLM2 HIT', keyLLM2);
    const parsed2 = safeJSONParse(cachedLLM2, { final_picks: [] });
    entries = Array.isArray(parsed2.final_picks) ? parsed2.final_picks : parsed2;
  } else {
    const messages2 = [
      {
        role: 'system',
        content: 'Choose precise grocery products for shopping. Return ONLY raw JSON. No prose. No code fences.',
      },
      {
        role: 'user',
        content: `
For each ingredient, choose up to ${Math.max(1, Math.min(2, chooseMax))} items by returning the **indices** of the best-matching candidates.

RULES:
- Pick only from the provided candidates for that ingredient by **index**.
- If none of the candidates are a reasonable match, return an empty list for that ingredient.
- Prefer staple cooking forms over snacks/variety packs; avoid novelty flavors.
- If multiple sizes/brands fit, prefer value/common formats.
- Output MUST be valid JSON per the schema.

Example (format only):
{"final_picks":[{"ingredient":"tomato","indices":[0,3]},{"ingredient":"basil","indices":[2]}]}

ingredients = ${JSON.stringify(ingList)}
candidates =
${JSON.stringify(enumerated, null, 2)}
        `.trim(),
      },
    ];

    const tMatch = nowMs();
    const count = ingList.length;

    const llm2Raw = await callGPT5JSON(messages2, {
      maxTokens: 4000,
      schema: {
        name: 'final_picks_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            final_picks: {
              type: 'array',
              minItems: count,
              maxItems: count,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ingredient: { type: 'string', enum: ingList },
                  indices: {
                    type: 'array',
                    items: { type: 'integer', minimum: 0 },
                    minItems: 0,
                    maxItems: Math.max(1, Math.min(2, chooseMax)),
                  },
                },
                required: ['ingredient', 'indices'],
              },
            },
          },
          required: ['final_picks'],
        },
      },
    });

    console.log(`[DEBUG] LLM2 completed in ${msSince(tMatch)}`);
    logKV('[DEBUG] LLM2 RAW:', llm2Raw);

    const parsed2 = safeJSONParse(llm2Raw, { final_picks: [] });
    entries = Array.isArray(parsed2.final_picks) ? parsed2.final_picks : [];

    await redis.set(keyLLM2, JSON.stringify({ final_picks: entries }), 'EX', 60 * 60 * 24 * 30);
  }

  const validSet = new Set(ingList);
  entries = entries.filter((e) => e && validSet.has(e.ingredient));

  console.log('[DEBUG] LLM2 ENTRIES COUNT:', entries.length);
  logKV('[DEBUG] LLM2 ENTRIES (first 2):', entries.slice(0, 2));

  /* -------- PHASE 4: Deterministic mapping (no random fallbacks) -------- */
  const out = [];
  const matchedInKrogerSet = new Set();
  const krogerMatchedByIngredient = {}; // collect per-ingredient picks

  for (const { ingredient: ing, indices } of entries) {
    const pool = fullByIng[ing] || [];
    const titles = titlesByIng[ing] || [];

    // sanitize & dedupe model output
    let idx = Array.isArray(indices) ? indices.filter((n) => Number.isInteger(n)) : [];
    idx = Array.from(new Set(idx));

    if (!idx.length) {
      console.log(`[MAP] "${ing}": LLM chose no indices — skipping`);
      warnings.push({ ingredient: ing, error: 'no_confident_title' });
      continue;
    }

    const chosenTitles = [];
    for (const i of idx) {
      if (i >= 0 && i < titles.length) chosenTitles.push(titles[i]);
    }
    if (!chosenTitles.length) {
      console.log(`[MAP] "${ing}": all indices invalid — skipping`);
      warnings.push({ ingredient: ing, error: 'no_valid_indices' });
      continue;
    }

    const matched = [];
    const byNorm = new Map(pool.map((p) => [normTitle(p.description), p]));

    for (const t of chosenTitles) {
      const n = normTitle(t);
      let hit = byNorm.get(n);
      if (!hit) hit = pool.find((p) => p.description === t);
      if (hit) matched.push(hit);
      else {
        console.log(`[MAP][miss] "${ing}" -> could not map "${t}" to a product object in pool`);
        warnings.push({ ingredient: ing, error: 'title_not_in_pool', title: t });
      }
    }

    if (!matched.length) {
      console.log(`[MAP] "${ing}": no products matched — skipping`);
      warnings.push({ ingredient: ing, error: 'no_confident_match' });
      continue;
    }

    matchedInKrogerSet.add(ing);

    const normalized = matched.map((p) => normalizeKroger(p, locationId));
    krogerMatchedByIngredient[ing] = normalized;
    for (const n of normalized) out.push(n);
  }

  console.log('[RESULT] final products count:', out.length);
  logKV('[RESULT] first 3 products:', out.slice(0, 3));

  // candidate counts per ingredient (for eligibility calc)
  const krogerCandidateCounts = Object.fromEntries(
    ingredients.map((ing) => [ing, (titlesByIng[ing] || []).length])
  );

  // ---- Save dish-level result forever (no TTL). Bump DISHCACHE_VERSION to invalidate. ----
  const resultPayload = {
    products: out,
    warnings,
    dishName,
    ingredients,
    matchedInKroger: Array.from(matchedInKrogerSet),
    krogerCandidateCounts,
    krogerMatchedByIngredient,
  };
  try {
    await redis.set(fastKey, JSON.stringify(resultPayload));
    console.log('[CACHE] DISH SET', fastKey);
  } catch (e) {
    console.warn('[CACHE] dish write failed:', e?.message || e);
  }

  return resultPayload;
}

/* ==================== Walmart: LLM index-based matching (no fallback) ==================== */
function extractUnmatchedTerms(warnings = []) {
  const UNMATCH_CODES = new Set([
    'no_candidates',
    'product_search_failed',
    'no_confident_title',
    'no_valid_indices',
    'no_confident_match',
    'title_not_in_pool',
  ]);
  const terms = [];
  for (const w of warnings) {
    const ing = w?.ingredient && String(w.ingredient).trim();
    if (!ing) continue;
    if (w?.error && UNMATCH_CODES.has(w.error)) terms.push(ing);
  }
  return Array.from(new Set(terms.map((t) => t.toLowerCase()))).slice(0, 6);
}
async function runWalmartMatchByIndex(terms = [], { passCount = 20, chooseMax = 2 } = {}) {
  const detailed = await runWalmartMatchByIndexDetailed(terms, { passCount, chooseMax });
  return detailed.products;
}
async function runWalmartMatchByIndexDetailed(terms = [], { passCount = 20, chooseMax = 2 } = {}) {
  const ingList = Array.from(new Set((terms || []).filter(Boolean)));
  if (!ingList.length) {
    return { products: [], matchedInWalmart: [], walmartCandidateCounts: {}, byIngredient: {} };
  }

  console.log('[WALMART][LLM] fetching candidates…');
  const titlesByIng = {};
  const fullByIng = {};
  for (const ing of ingList) {
    try {
      const t0 = nowMs();
      const items = await walmartRawSearch(ing);
      console.log(`[WALMART] "${ing}" -> ${items.length} items in ${msSince(t0)}`);
      fullByIng[ing] = items;
      titlesByIng[ing] = items.map((it) => it?.name || '').filter(Boolean).slice(0, passCount);
    } catch (e) {
      console.warn('[WALMART] search error:', ing, e?.response?.status || e?.message);
      fullByIng[ing] = [];
      titlesByIng[ing] = [];
    }
  }

  const enumerated = {};
  for (const ing of ingList) enumerated[ing] = (titlesByIng[ing] || []).map((t, i) => `${i}: ${t}`);

  const messages = [
    { role: 'system', content: 'Choose precise grocery products for shopping. Return ONLY raw JSON. No prose. No code fences.' },
    {
      role: 'user',
      content: `
For each ingredient, choose up to ${Math.max(1, Math.min(2, chooseMax))} items by returning the **indices** of the best-matching candidates.

RULES:
- Pick only from the provided candidates for that ingredient by **index**.
- If none of the candidates are a reasonable match, return an empty list for that ingredient.
- Prefer staple cooking forms over snacks/variety packs; avoid novelty flavors.
- If multiple sizes/brands fit, prefer value/common formats.
- Output MUST be valid JSON per the schema.

Example (format only):
{"final_picks":[{"ingredient":"tomato","indices":[0,3]},{"ingredient":"basil","indices":[2]}]}

ingredients = ${JSON.stringify(ingList)}
candidates =
${JSON.stringify(enumerated, null, 2)}
      `.trim(),
    },
  ];

  const raw = await callGPT5JSON(messages, {
    maxTokens: 4000,
    schema: {
      name: 'final_picks_schema',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          final_picks: {
            type: 'array',
            minItems: ingList.length,
            maxItems: ingList.length,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ingredient: { type: 'string', enum: ingList },
                indices: {
                  type: 'array',
                  items: { type: 'integer', minimum: 0 },
                  minItems: 0,
                  maxItems: Math.max(1, Math.min(2, chooseMax)),
                },
              },
              required: ['ingredient', 'indices'],
            },
          },
        },
        required: ['final_picks'],
      },
    },
  });

  const parsed = safeJSONParse(raw, { final_picks: [] });
  const entries = (parsed?.final_picks || []).filter((e) => e && ingList.includes(e.ingredient));

  const out = [];
  const matchedSet = new Set();
  const byIngredient = {};

  for (const { ingredient: ing, indices } of entries) {
    const pool = fullByIng[ing] || [];
    const titles = titlesByIng[ing] || [];
    const idx = Array.from(new Set((Array.isArray(indices) ? indices : []).filter(Number.isInteger)));
    if (!idx.length) continue;

    const chosen = [];
    for (const i of idx) if (i >= 0 && i < titles.length) chosen.push(titles[i]);
    if (!chosen.length) continue;

    const byNorm = new Map(pool.map((it) => [normTitle(it?.name || ''), it]));
    let matchedHere = 0;
    for (const t of chosen) {
      const n = normTitle(t);
      let hit = pool.find((it) => (it?.name || '') === t) || byNorm.get(n);
      if (hit) {
        const norm = normalizeWalmart(hit);
        out.push(norm);
        (byIngredient[ing] ||= []).push(norm);
        matchedHere++;
      }
    }
    if (matchedHere > 0) matchedSet.add(ing);
  }

  console.log('[WALMART][LLM] final picks:', out.length);
  const walmartCandidateCounts = Object.fromEntries(ingList.map((ing) => [ing, (titlesByIng[ing] || []).length]));
  return { products: out, matchedInWalmart: Array.from(matchedSet), walmartCandidateCounts, byIngredient };
}

/* ============================ HTTP Controllers ============================ */
// JSON (non-streaming)
export async function krogerSearch(req, res) {
  try {
    const { query, zip } = req.body || {};
    console.log('\n[KROGER] SEARCH START (JSON)', { query, zip, userId: req.user?._id?.toString?.() });

    const t0 = nowMs();
    const result = await runKrogerSearchPipeline({
      query,
      zip,
      user: req.user,
      passCount: 20,
      chooseMax: 2,
    });
    console.log(`[KROGER] SEARCH DONE in ${msSince(t0)} -> products: ${result.products.length}`);

    const krogerMatchedSet = new Set(result.matchedInKroger || []);
    const unmatchedIngredients = (result.ingredients || []).filter((ing) => !krogerMatchedSet.has(ing));
    const wm = await runWalmartMatchByIndexDetailed(unmatchedIngredients, { passCount: 20, chooseMax: 2 });
    const unmatchedTerms = extractUnmatchedTerms(result.warnings || []);

    return res.json({
      dishName: result.dishName || null,
      ingredients: result.ingredients || [],
      krogerProducts: result.products,
      walmartProducts: wm.products,
      matchedInWalmart: wm.matchedInWalmart,
      krogerByIngredient: result.krogerMatchedByIngredient,
      walmartByIngredient: wm.byIngredient,
      unmatchedIngredients,
      unmatchedTerms,
      warnings: result.warnings || [],
      took: msSince(t0),
    });
  } catch (err) {
    console.error('[KROGER] ERROR', err?.response?.data || err);
    return res.status(500).json({ error: 'Failed to search Kroger' });
  }
}

// SSE (streaming with phases)
export async function krogerSearchStream(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const query = String(req.query.query || '');
    const zip = req.query.zip ? String(req.query.zip) : undefined;
    console.log('\n[KROGER] SEARCH START (SSE)', { query, zip, userId: req.user?._id?.toString?.() });

    const t0 = nowMs();
    const { products, warnings, ingredients, dishName, matchedInKroger, krogerMatchedByIngredient } =
      await runKrogerSearchPipeline({
        query,
        zip,
        user: req.user,
        passCount: 20,
        chooseMax: 1,
        onPhase: (phase) => { console.log(`[SSE] phase -> ${phase}`); send('phase', { phase }); },
      });

    const krogerMatchedSet = new Set(matchedInKroger || []);
    const unmatchedIngredients = (ingredients || []).filter((ing) => !krogerMatchedSet.has(ing));
    const wm = await runWalmartMatchByIndexDetailed(unmatchedIngredients || [], { passCount: 20, chooseMax: 1 });
    const unmatchedTerms = extractUnmatchedTerms(warnings || []);

    console.log(`[KROGER] SSE DONE in ${msSince(t0)} -> kroger:${products.length}, walmart:${wm.products.length}`);
    send('done', {
      dishName,
      ingredients: ingredients || [],
      krogerProducts: products,
      walmartProducts: wm.products,
      matchedInKroger,
      matchedInWalmart: wm.matchedInWalmart,
      krogerByIngredient: krogerMatchedByIngredient,
      walmartByIngredient: wm.byIngredient,
      unmatchedIngredients,
      unmatchedTerms,
      warnings,
    });
    res.end();
  } catch (err) {
    console.error('[KROGER/STREAM] ERROR', err?.response?.data || err);
    send('done', { krogerProducts: [], walmartProducts: [], unmatchedTerms: [], error: 'Failed to search Kroger' });
    res.end();
  }
}

/**
 * Evaluation controller for CSV-driven tests.
 * POST /kroger/test-eval
 * Body: { query: string, zip?: string, threshold?: number }
 */
export async function krogerTestEval(req, res) {
  try {
    const { query, dish, zip, threshold } = req.body || {};
    const q = (dish || query || '').trim();
    const passThreshold = typeof threshold === 'number' ? threshold : 0.9;

    console.log('\n[KROGER] EVAL START', { query: q, zip, passThreshold, userId: req.user?._id?.toString?.() });

    const k = await runKrogerSearchPipeline({ query: q, zip, user: req.user, passCount: 20, chooseMax: 2 });

    const ingredients = Array.isArray(k.ingredients) ? k.ingredients : [];

    const krogerMatchedSet = new Set(k.matchedInKroger || []);
    const unmatchedIngredients = ingredients.filter((ing) => !krogerMatchedSet.has(ing));
    const w = await runWalmartMatchByIndexDetailed(unmatchedIngredients, { passCount: 20, chooseMax: 2 });

    const krogerCandidateCounts = k.krogerCandidateCounts || {};
    const walmartCandidateCounts = w.walmartCandidateCounts || {};
    const matchedInKroger = new Set(k.matchedInKroger || []);
    const matchedInWalmart = new Set(w.matchedInWalmart || []);

    const eligible = [];
    const excludedNoCatalog = [];
    for (const ing of ingredients) {
      const kc = krogerCandidateCounts[ing] || 0;
      const wc = w.walmartCandidateCounts?.[ing] || 0;
      if (kc + wc > 0) eligible.push(ing);
      else excludedNoCatalog.push(ing);
    }

    const foundSet = new Set([...matchedInKroger, ...matchedInWalmart]);

    const found = eligible.filter((ing) => foundSet.has(ing));
    const notFoundButAvailable = eligible.filter((ing) => !foundSet.has(ing));

    const eligibleCount = eligible.length;
    const foundCount = found.length;
    const pct = eligibleCount > 0 ? foundCount / eligibleCount : 0;
    const passed = pct >= passThreshold;

    return res.json({
      query: q,
      dishName: k.dishName || null,
      threshold: passThreshold,
      pass: passed,
      percentage: pct,
      counts: { totalIngredients: ingredients.length, eligible: eligibleCount, found: foundCount, excludedNoCatalog: excludedNoCatalog.length },
      ingredients,
      eligibleIngredients: eligible,
      excludedNoCatalog,
      foundInKroger: Array.from(matchedInKroger),
      foundInWalmart: Array.from(matchedInWalmart),
      foundEither: found,
      notFoundButAvailable,
      krogerProducts: k.products,
      walmartProducts: w.products,
      krogerByIngredient: k.krogerMatchedByIngredient,
      walmartByIngredient: w.byIngredient,
      warnings: k.warnings || [],
      unmatchedTerms: extractUnmatchedTerms(k.warnings || []),
      unmatchedIngredients,
    });
  } catch (err) {
    console.error('[KROGER][EVAL][ERROR]', err?.response?.data || err);
    return res.status(500).json({ error: 'Failed to evaluate query' });
  }
}
