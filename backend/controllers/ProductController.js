// controllers/ProductController.js

import Product from '../models/Product.js';
import s3 from '../config/s3.js';
import User from '../models/User.js';
import openai from '../config/openai.js';
import queryLlamaIndex from './queryLlamaIndex.js';

/* ----------------------------- helpers ----------------------------- */

/**
 * Robustly parse JSON even if the model adds prose or ``` fences.
 * - Tries direct parse.
 * - Strips common code-fence wrappers.
 * - Falls back to extracting the first {...} or [...] block.
 */
function safeJSONParse(text) {
  if (!text) throw new Error('Empty model response');
  const trimmed = String(text).trim();

  // Remove leading/trailing code fences if present
  let cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();

  // Try direct parse first
  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  // Fallback: extract the first JSON-looking block
  const start = cleaned.search(/[\[{]/);
  const endObj = cleaned.lastIndexOf('}');
  const endArr = cleaned.lastIndexOf(']');
  const end = Math.max(endObj, endArr);
  if (start >= 0 && end > start) {
    const snippet = cleaned.slice(start, end + 1);
    return JSON.parse(snippet);
  }

  // Last resort: strip all backticks and try again
  cleaned = cleaned.replace(/```/g, '');
  return JSON.parse(cleaned);
}

/* ---------------------------- controllers --------------------------- */

const addProduct = async (req, res) => {
  try {
    const { title, description, price, category } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'Image upload failed' });
    }

    const imageUrl = req.file.location;
    const product = new Product({ title, description, price, category, imageUrl });
    await product.save();

    res.status(201).json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const getAllProducts = async (_req, res) => {
  try {
    const products = await Product.find();

    const updatedProducts = products.map((product) => {
      const imageKey = product.imageUrl.split('/').pop();
      const cloudFrontUrl = `${process.env.AWS_CLOUDFRONT_URL}${imageKey}`;
      return { ...product.toObject(), imageUrl: cloudFrontUrl };
    });

    res.status(200).json(updatedProducts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const editProduct = async (req, res) => {
  try {
    const { title, description, price, category } = req.body;
    const updateFields = { title, description, price, category };

    if (req.file) {
      const product = await Product.findById(req.params.id);
      if (product) {
        const oldImageKey = product.imageUrl.split('/').pop();
        await s3
          .deleteObject({
            Bucket: process.env.S3_BUCKET_NAME,
            Key: oldImageKey,
          })
          .promise();
      }
      updateFields.imageUrl = req.file.location;
    }

    const updatedProduct = await Product.findByIdAndUpdate(
      req.params.id,
      updateFields,
      { new: true }
    );

    res.status(200).json(updatedProduct);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const imageKey = product.imageUrl.split('/').pop();

    await Product.findByIdAndDelete(req.params.id);

    await s3
      .deleteObject({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: imageKey,
      })
      .promise();

    // Remove the deleted product from all users' carts
    await User.updateMany({}, { $unset: { [`cart.${req.params.id}`]: '' } });

    res.status(200).json({ message: 'Product deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * POST /products/search
 * Body: { query: string }
 *
 * Flow:
 *  1) LLM #1 -> actual_ingredients  (first element is dish name)
 *  2) Python loose match -> loosely_matched_ingredients (titles array)
 *  3) LLM #2 (with dish name context) -> final_ingredients
 *  4) Return { matchedProducts: final_ingredients }  (frontend unchanged)
 */
const searchProducts = async (req, res) => {
  const { query } = req.body;

  try {
    /* ---------------- LLM #1: Get ingredients (keep prompt as-is) --------------- */
    const messages = [
      {
        role: "system",
        content:
          "You classify a query as either (A) a prepared dish/recipe or (B) a single grocery ingredient, and return ONLY raw JSON with no code fences."
      },
      {
        role: "user",
        content:
    `Decide using this rule:

    1) If the query is a single grocery ingredient and spelled in a regional language, convert it into English and return ONLY:
    ["<ingredient>"]

    2) Otherwise, if the query is a prepared dish/recipe, return ONLY:
    ["<dish name in English>", "<ingredient 1>", "<ingredient 2>", ...]

    3) If you truly cannot identify it as either a dish or an ingredient, return ONLY: []

    Additional requirements:
    - Do NOT invent a dish name for single-ingredient queries.
    - Prefer interpreting short, single-word queries as ingredients rather than dishes.
    - No umbrella terms (e.g., list the vegetables instead of saying just "vegetables").
    - Use plain English names for all items.
    - Return ONLY RAW JSON (no prose, no code fences).

    Now process this query exactly once and return ONLY raw JSON as specified:

    Query: ${query}`
      }
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages,
      max_tokens: 300,
      temperature: 0.2,
    });

    const actual_ingredients = safeJSONParse(response.choices[0].message.content);
    // ---- Parse both cases: single ingredient OR dish + ingredients
    let dishName = null;
    let ingredients = [];
    if (Array.isArray(actual_ingredients)) {
      if (actual_ingredients.length === 1) {
        // Single-ingredient query like ["salt"]
        ingredients = [String(actual_ingredients[0]).trim()].filter(Boolean);
      } else if (actual_ingredients.length > 1) {
        [dishName, ...ingredients] = actual_ingredients.map((x) => String(x).trim());
      }
    }

    // Early exit if nothing useful came back
    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(200).json({ matchedProducts: [], message: "No matches" });
    }

    console.log("Dish Name: ", dishName)
    console.log("Ingredients from LLM response: ", ingredients)
    
    

    /* -------- Step 1: Loose match via llama_server (returns titles array) -------- */
    const loosely_matched_ingredients = await queryLlamaIndex(ingredients);
    console.log("Loosely matched ingredients:", loosely_matched_ingredients);
    
    const loose = Array.isArray(loosely_matched_ingredients)
      ? loosely_matched_ingredients.filter((t) => typeof t === 'string')
      : [];

    /* --------- LLM #2: Precise match using dish context + two arrays ------------- */
    const matchMessages = [
      { role: 'system', content: 'You are a precise grocery product matcher for groceries.' },
      {
        role: 'user',
        content:
`Task: Map each ingredient from 'actual_ingredients' to its best matching product title from 'loosely_matched_ingredients'. 

Dish context: "${dishName}"  ← Use this to resolve ambiguities and pick the culinary-appropriate item.

Requirements:
- The first element of 'actual_ingredients' is the dish name; do NOT match that. Match the remaining items only.
- Use the dish context to avoid cross-category errors (e.g., plant vs animal, spice vs sauce, fresh vs powdered).
- Prefer the ingredient’s ready-to-use form.
- If no ready-to-use form exists in 'loosely_matched_ingredients', you MAY choose a minimal-prep equivalent that can be made at home with simple processing (e.g., “mustard paste” ↔ “mustard seeds”, “ginger-garlic paste” ↔ “fresh ginger” + “fresh garlic”). Do NOT choose substitutes that change the ingredient category (e.g., “tomato sauce” ≠ “fresh tomatoes”, “garlic powder” ≠ “fresh garlic”) unless nothing else exists.
- Match on ingredient identity, not brand; brands/pack sizes in titles are acceptable.
- If multiple titles are valid for the SAME ingredient, include them all.
- If nothing is acceptable for an ingredient, omit it.

Return ONLY raw JSON (no code fences, no extra text):
{"final_ingredients": ["<exact title 1>", "<exact title 2>", "..."]}

actual_ingredients = ${JSON.stringify(actual_ingredients)}

loosely_matched_ingredients = ${JSON.stringify(loose)}`,
      },
    ];

    const matchResponse = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: matchMessages,
      max_tokens: 400,
      temperature: 0.1,
    });

    let final_ingredients = [];
    try {
      const parsed = safeJSONParse(matchResponse.choices[0].message.content);
      final_ingredients = Array.isArray(parsed.final_ingredients)
        ? parsed.final_ingredients.filter((t) => typeof t === 'string')
        : [];
    } catch (e) {
      console.error('Parse error on precise match:', e.message);
      // Soft fallback: if the second pass fails, return the loose list
      final_ingredients = loose;
    }

    console.log("Final ingredients:", final_ingredients);
    

    /* -------------------- Return under the existing frontend key -------------------- */
    return res.status(200).json({ matchedProducts: final_ingredients });
  } catch (error) {
    console.error('Error querying products:', error?.response?.data || error);
    return res
      .status(500)
      .json({ success: false, error: 'Failed to fetch search results' });
  }
};

export default {
  addProduct,
  getAllProducts,
  editProduct,
  deleteProduct,
  searchProducts,
};
