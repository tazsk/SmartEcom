#!/usr/bin/env node
// test.js
// Usage: node test.js --csv ./world_cuisine_test_suite.csv [--out ./dish_test_report.csv]
// Env:   API_BASE (default http://localhost:4000), ZIP (optional), ENDPOINT (/kroger/test-eval),
//        REPORT (dish_test_report.csv), THRESHOLD (e.g., 0.9)

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const args = process.argv.slice(2);
const aget = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};

const CSV_PATH = aget('--csv', './world_cuisine_test_suite.csv');
const API_BASE = process.env.API_BASE || 'http://localhost:4000';
const ZIP = process.env.ZIP || '';
const ENDPOINT = process.env.ENDPOINT || '/kroger/test-eval';
const REPORT_PATH = aget('--out', process.env.REPORT || './dish_test_report.csv');
const THRESHOLD = Number(process.env.THRESHOLD || '0.9'); // optional override

async function readCsvRows(p) {
  const raw = await fs.readFile(p, 'utf-8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const hasHeader = /^cuisine\s*,\s*dish/i.test(lines[0] || '');
  const start = hasHeader ? 1 : 0;
  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const j = line.indexOf(',');
    if (j < 0) continue;
    const cuisine = line.slice(0, j).trim().replace(/^"|"$/g, '');
    const dish = line.slice(j + 1).trim().replace(/^"|"$/g, '');
    if (cuisine && dish) rows.push({ cuisine, dish });
  }
  return rows;
}

const groupByCuisine = (rows) =>
  rows.reduce((m, r) => (m.set(r.cuisine, [...(m.get(r.cuisine) || []), r.dish]), m), new Map());

async function evalDish(dish, zip) {
  const r = await fetch(`${API_BASE}${ENDPOINT}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: dish, zip, threshold: THRESHOLD }),
  });
  if (!r.ok) throw new Error(`test-eval ${r.status}`);
  return await r.json();
}

// CSV writer
const esc = (v) => {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
};
async function writeReport(rows, outPath) {
  if (!rows.length) {
    console.log(`[INFO] No rows to write at ${outPath}`);
    return;
  }
  const headers = [
    'cuisine',
    'dish_query',
    'dish_name_model',
    'ingredients_list',
    'ingredient',
    'kroger_match_titles',
    'kroger_match_upcs',
    'walmart_match_titles',
    'walmart_match_upcs',
    'pass',
    'foundCount',
    'eligibleCount',
    'percentage',
    'unmatched_ingredients',
  ];
  const body = rows.map((r) =>
    [
      r.cuisine,
      r.dishQuery,
      r.dishNameModel,
      r.ingredientsList.join(' | '),
      r.ingredient,
      (r.krogerTitles || []).join(' | '),
      (r.krogerUPCs || []).join(' | '),
      (r.walmartTitles || []).join(' | '),
      (r.walmartUPCs || []).join(' | '),
      r.pass ? 'PASS' : 'FAIL',
      r.foundCount,
      r.eligibleCount,
      (r.percentage * 100).toFixed(1) + '%',
      r.unmatchedIngredients.join(' | '),
    ]
      .map(esc)
      .join(',')
  );
  const csv = [headers.map(esc).join(','), ...body].join('\n');
  await fs.writeFile(outPath, csv, 'utf-8');
  console.log(`\n[REPORT] wrote ${rows.length} rows to ${path.resolve(outPath)}`);
}

(async function main() {
  // Always start fresh (per your last change): no resume file
  // (we don't create a progress file anymore)

  const rows = await readCsvRows(CSV_PATH);
  if (!rows.length) {
    console.error(`[ERROR] No rows from ${CSV_PATH}`);
    process.exit(1);
  }

  const byCuisine = groupByCuisine(rows);
  const cuisines = Array.from(byCuisine.keys());
  const startIdx = 0;

  console.log(`\n== Dish Tester ==`);
  console.log(`API_BASE: ${API_BASE}`);
  console.log(`ENDPOINT: ${ENDPOINT}`);
  console.log(`CSV: ${path.resolve(CSV_PATH)}`);
  console.log(`ZIP: ${ZIP || '(none)'}`);
  console.log(`Threshold: ${THRESHOLD}`);
  console.log(`Starting cuisine index: ${startIdx}/${cuisines.length - 1}\n`);

  const rl = readline.createInterface({ input, output });

  let totalPass = 0,
    totalProcessed = 0;

  const reportRows = []; // accumulate per-ingredient rows

  for (let ci = startIdx; ci < cuisines.length; ci++) {
    const cuisine = cuisines[ci];
    const dishes = byCuisine.get(cuisine) || [];
    console.log(`\n--- ${cuisine} (${dishes.length} dishes) ---`);

    for (const dish of dishes) {
      try {
        const res = await evalDish(dish, ZIP);
        totalProcessed += 1;
        const tag = res.pass ? 'PASS' : 'FAIL';
        if (res.pass) totalPass += 1;

        const foundCount = res.foundCount ?? res.counts?.found ?? 0;
        const eligibleCount = res.eligibleCount ?? res.counts?.eligible ?? 0;
        const pct = res.percentage ?? 0;

        console.log(`[${tag}] ${dish}  (${foundCount}/${eligibleCount})  ${(pct * 100).toFixed(1)}%`);

        // Build CSV detail rows (one row PER INGREDIENT for this dish)
        const ingredients = Array.isArray(res.ingredients) ? res.ingredients : [];
        const ingListStr = ingredients; // already array
        const krogerMap = res.krogerByIngredient || {};
        const walmartMap = res.walmartByIngredient || {};
        const modelDishName = res.dishName || '';

        const unmatched = Array.isArray(res.unmatchedIngredients) ? res.unmatchedIngredients : [];

        for (const ing of ingredients) {
          const kArr = Array.isArray(krogerMap[ing]) ? krogerMap[ing] : [];
          const wArr = Array.isArray(walmartMap[ing]) ? walmartMap[ing] : [];

          reportRows.push({
            cuisine,
            dishQuery: dish,
            dishNameModel: modelDishName,
            ingredientsList: ingListStr,
            ingredient: ing,
            krogerTitles: kArr.map((p) => p.title || ''),
            krogerUPCs: kArr.map((p) => p.upc || ''),
            walmartTitles: wArr.map((p) => p.title || ''),
            walmartUPCs: wArr.map((p) => p.upc || ''),
            pass: !!res.pass,
            foundCount,
            eligibleCount,
            percentage: pct,
            unmatchedIngredients: unmatched,
          });
        }
      } catch (e) {
        totalProcessed += 1;
        console.log(`[ERROR] ${dish}: ${e.message}`);

        // Still record an error row so the CSV keeps traceability
        reportRows.push({
          cuisine,
          dishQuery: dish,
          dishNameModel: '',
          ingredientsList: [],
          ingredient: '',
          krogerTitles: [],
          krogerUPCs: [],
          walmartTitles: [],
          walmartUPCs: [],
          pass: false,
          foundCount: 0,
          eligibleCount: 0,
          percentage: 0,
          unmatchedIngredients: [],
        });
      }
    }

    const ans = await rl.question(`\nFinished "${cuisine}". Continue to next cuisine? (y/N): `);
    if (!String(ans || '').trim().toLowerCase().startsWith('y')) {
      console.log('\nStopping by user choice.');
      break;
    }
  }

  console.log(`\n== Summary ==`);
  console.log(`Total dishes processed: ${totalProcessed}`);
  console.log(`Total PASS: ${totalPass}`);
  console.log(`Total FAIL: ${totalProcessed - totalPass}\n`);

  // Write the CSV report
  await writeReport(reportRows, REPORT_PATH);

  process.exit(0);
})().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
