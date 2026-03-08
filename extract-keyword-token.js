/**
 * ShipLift - Keyword Token Extractor (LLM-based)
 *
 * Uses Gemini to extract meaningful keyword tokens from App Store
 * title, subtitle, and description across any language.
 * Then generates all 2-word pair permutations for keyword ranking lookups.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

// ── Single-store extraction ──────────────────────────────────────────────────

/**
 * Extract keyword tokens for a single store using Gemini.
 *
 * @param {string} title
 * @param {string} subtitle
 * @param {string} description
 * @param {string} storeCode - e.g. "us", "de", "it"
 * @param {string} brandName - brand name to exclude
 * @param {string} geminiApiKey
 * @returns {Promise<{ tokens: string[], singles: string[], pairs: string[], allKeywords: string[], callCount: number }>}
 */
export async function extractKeywordTokens(
  title,
  subtitle,
  description,
  storeCode,
  brandName,
  geminiApiKey,
) {
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const descSnippet = (description ?? "").slice(0, 1500);

  const prompt = `You are an App Store Optimization expert. Extract search-relevant keyword tokens from this iOS app's metadata.

Store: ${storeCode}
Brand name (EXCLUDE this): ${brandName}
Title: ${title}
Subtitle: ${subtitle || "N/A"}
Description: ${descSnippet || "N/A"}

Rules:
- Return ONLY words/phrases that real users would type into the App Store search bar.
- Extract tokens in the SAME LANGUAGE as the metadata. Do NOT translate.
- Include: feature words, function words, subject/category words, action verbs tied to app functionality, compound terms users search for (e.g. "step-by-step").
- Exclude: the brand name "${brandName}", legal/subscription text, marketing fluff (amazing, beautiful, powerful, ultimate, best, perfect), generic stop words, single characters.
- For compound words (e.g. German "Mathematikaufgaben"), split into meaningful searchable parts.
- For CJK text, segment into meaningful search terms (2+ characters).
- All tokens lowercase.
- Return 10-30 tokens, ordered by search relevance (most likely searched first).

Return ONLY a JSON array of strings, nothing else. No markdown, no explanation.
["token1", "token2", "token3"]`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  const json = text
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  let tokens;
  try {
    tokens = JSON.parse(json);
  } catch {
    throw new Error(`Gemini returned invalid JSON for token extraction (store: ${storeCode}).`);
  }

  if (!Array.isArray(tokens)) {
    throw new Error(`Gemini response is not an array (store: ${storeCode}).`);
  }

  // Deduplicate and clean
  const seen = new Set();
  const filtered = [];
  for (const t of tokens) {
    const clean = String(t).toLowerCase().trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    filtered.push(clean);
  }

  // Generate 2-word permutations
  const pairs = [];
  for (let i = 0; i < filtered.length; i++) {
    for (let j = 0; j < filtered.length; j++) {
      if (i !== j) {
        pairs.push(`${filtered[i]} ${filtered[j]}`);
      }
    }
  }

  const singles = [...filtered];

  return {
    tokens: filtered,
    singles,
    pairs,
    allKeywords: [...singles, ...pairs],
    callCount: singles.length + pairs.length,
  };
}

// ── Multi-store batch extraction (single Gemini call) ────────────────────────

/**
 * Process an app across all its storefronts in a single Gemini call.
 *
 * @param {object} appData - { appleId, stores: [{ store, country, available, title, subtitle, description }] }
 * @param {string} brandName
 * @param {string} geminiApiKey
 * @returns {Promise<{ appleId, brandName, stores: [...], totalCalls, estimatedTimeAt50Concurrent, estimatedCost }>}
 */
export async function processAllStores(appData, brandName, geminiApiKey) {
  const availableStores = appData.stores.filter((s) => s.available);

  if (availableStores.length === 0) {
    return {
      appleId: appData.appleId,
      brandName,
      stores: [],
      totalCalls: 0,
      estimatedTimeAt50Concurrent: "0 seconds",
      estimatedCost: "$0.000",
    };
  }

  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  // Build batched prompt with all stores
  const storeBlocks = availableStores
    .map((s) => {
      const descSnippet = (s.description ?? "").slice(0, 800);
      return `--- ${s.store} (${s.country}) ---
Title: ${s.title}
Subtitle: ${s.subtitle || "N/A"}
Description: ${descSnippet || "N/A"}`;
    })
    .join("\n\n");

  const prompt = `You are an App Store Optimization expert. Extract search-relevant keyword tokens from this iOS app's metadata across multiple storefronts.

Brand name (EXCLUDE this from all stores): ${brandName}

${storeBlocks}

Rules:
- Return ONLY words/phrases that real users would type into the App Store search bar.
- Extract tokens in the SAME LANGUAGE as each store's metadata. Do NOT translate.
- Include: feature words, function words, subject/category words, action verbs tied to app functionality, compound terms users search for.
- Exclude: the brand name "${brandName}", legal/subscription text, marketing fluff (amazing, beautiful, powerful, ultimate, best, perfect), generic stop words, single characters.
- For compound words (e.g. German "Mathematikaufgaben"), split into meaningful searchable parts.
- For CJK text, segment into meaningful search terms (2+ characters).
- All tokens lowercase.
- Return 10-30 tokens per store, ordered by search relevance.

Return ONLY a JSON object mapping store codes to arrays of token strings. No markdown, no explanation.
Example: {"us": ["math", "solver", "homework"], "de": ["mathe", "rechner", "hausaufgaben"]}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  const json = text
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Gemini returned invalid JSON for batch token extraction.");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Gemini response is not an object.");
  }

  const results = [];
  let totalCalls = 0;

  for (const store of availableStores) {
    const rawTokens = parsed[store.store] ?? [];

    // Deduplicate and clean
    const seen = new Set();
    const filtered = [];
    for (const t of rawTokens) {
      const clean = String(t).toLowerCase().trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      filtered.push(clean);
    }

    // Generate 2-word permutations
    const pairs = [];
    for (let i = 0; i < filtered.length; i++) {
      for (let j = 0; j < filtered.length; j++) {
        if (i !== j) {
          pairs.push(`${filtered[i]} ${filtered[j]}`);
        }
      }
    }

    const singles = [...filtered];
    const callCount = singles.length + pairs.length;

    results.push({
      storefront: store.store,
      country: store.country,
      tokens: filtered,
      singles,
      pairs,
      callCount,
    });

    totalCalls += callCount;
  }

  return {
    appleId: appData.appleId,
    brandName,
    stores: results,
    totalCalls,
    estimatedTimeAt50Concurrent: `${Math.ceil(totalCalls / 50)} seconds`,
    estimatedCost: `$${(totalCalls * 0.00006).toFixed(3)}`,
  };
}
