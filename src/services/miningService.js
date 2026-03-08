import { GoogleGenerativeAI } from "@google/generative-ai";
import { fetchSuggestions } from "./popularity.js";
import { config } from "../config/index.js";

const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 30000;
const RETRY_MAX_ATTEMPTS = 4;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch Apple Suggest results for a single keyword.
 */
async function fetchTerms(keyword, store, redis) {
  const token = config.appleMediaApiToken;
  if (!token) throw new Error("APPLE_MEDIA_API_TOKEN is not configured.");

  const suggestions = await fetchSuggestions(keyword, store, "iphone", token, redis);
  return suggestions.map((s) => s.term);
}

/**
 * Fetch Apple Suggest for a list of keywords with parallel execution + retry queue.
 * Returns a raw tree: Record<keyword, string[]>.
 * `globalSeen` tracks terms already used in prior levels to avoid duplicates.
 */
async function fetchLevel(keywords, store, redis, globalSeen) {
  const rawTree = {};
  const retryQueue = [];

  function collect(keyword, terms) {
    const unique = terms.filter((t) => t !== keyword && !globalSeen.has(t));
    rawTree[keyword] = unique;
    for (const t of unique) globalSeen.add(t);
  }

  // ── Parallel fetch ──────────────────────────────────────────────────────
  await Promise.all(
    keywords.map(async (keyword) => {
      try {
        const terms = await fetchTerms(keyword, store, redis);
        collect(keyword, terms);
      } catch (err) {
        if (err.name === "RateLimitError") {
          retryQueue.push(keyword);
        } else {
          console.warn(`[mining] skipping "${keyword}": ${err.message}`);
          rawTree[keyword] = [];
        }
      }
    })
  );

  // ── Sequential retry with backoff ───────────────────────────────────────
  if (retryQueue.length > 0) {
    console.warn(`[mining] retrying ${retryQueue.length} rate-limited keywords`);
    let delay = RETRY_BASE_DELAY_MS;

    for (const keyword of retryQueue) {
      let succeeded = false;

      for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
        await sleep(delay);
        delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS);

        try {
          const terms = await fetchTerms(keyword, store, redis);
          collect(keyword, terms);
          succeeded = true;
          break;
        } catch (err) {
          if (err.name === "RateLimitError") {
            console.warn(
              `[mining] "${keyword}" still rate-limited (attempt ${attempt}/${RETRY_MAX_ATTEMPTS})`
            );
          } else {
            console.warn(`[mining] "${keyword}" failed: ${err.message}`);
            break;
          }
        }
      }

      if (!succeeded) {
        console.warn(`[mining] "${keyword}" exhausted retries — skipped`);
        rawTree[keyword] = [];
      }
    }
  }

  return rawTree;
}

/**
 * Gemini enrichment: filter irrelevant terms + expand with permutations.
 * Single call for all keywords. Returns Record<keyword, { filtered, expanded }>.
 */
async function enrichWithGemini(rawTree, appMeta) {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is not configured.");

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const appBlock = `App Name: ${appMeta.name ?? ""}
Subtitle: ${appMeta.subtitle ?? ""}
Category: ${appMeta.category ?? ""}
Description: ${appMeta.description ?? ""}`;

  const keywordsBlock = Object.entries(rawTree)
    .map(([kw, suggestions]) =>
      `Keyword: "${kw}"\nSuggestions: ${suggestions.length > 0 ? suggestions.join(", ") : "(none)"}`
    )
    .join("\n\n---\n\n");

  const prompt = `You are an App Store Optimization expert. You are given an app's metadata and a list of seed keywords, each with Apple Suggest results.

App Metadata:
${appBlock}

Keywords and their Apple Suggest results:
${keywordsBlock}

For each keyword:
1. FILTER: from the suggestions list, keep only terms that are relevant to this app's purpose, features, or target audience. Remove anything clearly unrelated.
2. EXPAND: from the FILTERED suggestions, extract meaningful sub-phrases and natural combinations that real users would type in the App Store search bar. Example: "ai photo generator" → "ai photo", "photo generator", "ai generator". Only produce terms that make sense as standalone search queries.

Strict removal rules — REMOVE any suggestion or expansion that:
- Contains a brand, company, or competitor app name (e.g. "photoshop", "faceon", "canva", "sizematters", "conjure", "imagesearch")
- Contains a full app listing title with colons or dashes (e.g. "appname: feature description")
- Is not in the store's primary language (for US store: English only — remove Spanish, French, etc.)
- Is unrelated to what this specific app does (e.g. "instagram followers tracker" for a photo editor app — unless the app actually has that feature)
- Describes a feature this app does NOT have
- Differs from another term ONLY by a generic intent modifier: "free", "pro", "best", "app", "online", "top", "new". These are the same search intent — keep only the version WITHOUT the modifier (e.g. keep "photo editor", remove "photo editor free", "best photo editor", "photo editor app"). IMPORTANT: descriptive/feature words like "ai", "photo", "video", "image", "smart" are NOT modifiers — "ai photo editor" and "photo editor" are DIFFERENT queries with different intent. Do NOT collapse them.

Quality rules for BOTH filtered and expanded:
- Every term MUST be at least 2 words. Never output single words.
- All terms lowercase
- No duplicates within a keyword's lists
- Do not repeat the seed keyword itself as a standalone term
- filtered and expanded are separate lists
- Expanded terms must be realistic 2-3 word App Store search queries that a real user would type
- Do NOT just extract individual words from suggestions — combine them into meaningful search phrases

Return ONLY a valid JSON object — one key per keyword — nothing else:
{
  "<keyword>": {
    "filtered": [],
    "expanded": []
  }
}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  const json = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  return JSON.parse(json);
}

/**
 * Apply Gemini enrichment to a raw tree and return the cleaned terms.
 * Updates `globalSeen` with the final terms.
 * Returns Record<keyword, string[]> (filtered + expanded merged).
 */
async function applyEnrichment(rawTree, keywords, appMeta, globalSeen) {
  const enriched = await enrichWithGemini(rawTree, appMeta);
  const result = {};

  for (const keyword of keywords) {
    const entry = enriched[keyword] ?? { filtered: [], expanded: [] };
    const combined = [
      ...new Set([...(entry.filtered ?? []), ...(entry.expanded ?? [])]),
    ].filter((t) => t !== keyword && !globalSeen.has(t));

    result[keyword] = combined;
    for (const t of combined) globalSeen.add(t);
  }

  return result;
}

/**
 * Run one level of mining: fetch Apple Suggest + optionally Gemini enrich.
 * Returns Record<keyword, string[]>.
 */
async function mineLevel(keywords, store, redis, appMeta, globalSeen, levelNum) {
  console.log(`[mining] Level ${levelNum}: fetching suggestions for ${keywords.length} keywords`);
  const raw = await fetchLevel(keywords, store, redis, globalSeen);

  if (!appMeta) return raw;

  try {
    // Reset globalSeen to exclude raw fetch artifacts, keep only confirmed terms
    const confirmed = new Set(globalSeen);
    return await applyEnrichment(raw, keywords, appMeta, confirmed);
  } catch (err) {
    console.warn(`[mining] L${levelNum} Gemini enrichment failed: ${err.message}`);
    return raw;
  }
}

/**
 * Mine Apple Suggest results across three levels, building a nested tree.
 *
 * Level 1: seed keywords → Apple Suggest → Gemini filter/expand
 * Level 2: each L1 term → Apple Suggest → Gemini filter/expand
 * Level 3: each L2 term → Apple Suggest → Gemini filter/expand
 *
 * Tree: { seed: { L1: { L2: L3[] } } }
 * searchTerms: flattened by depth — all L1 first, then L2, then L3
 *
 * @param {string[]} seed
 * @param {string}   store
 * @param {object}   redis
 * @param {object}   appMeta  - { name, subtitle, description, category }
 * @returns {Promise<{ searchTerms: { L1: string[], L2: string[], L3: string[] }, tree: object }>}
 */
export async function mineSuggestions(seed, store, redis, appMeta) {
  const globalSeen = new Set(seed);

  // ── Level 1 ─────────────────────────────────────────────────────────────
  globalSeen.clear();
  for (const s of seed) globalSeen.add(s);
  const level1 = await mineLevel(seed, store, redis, appMeta, globalSeen, 1);

  // ── Level 2 ─────────────────────────────────────────────────────────────
  const allL1Terms = Object.values(level1).flat();
  const level2 = await mineLevel(allL1Terms, store, redis, appMeta, globalSeen, 2);

  // ── Level 3 ─────────────────────────────────────────────────────────────
  const allL2Terms = Object.values(level2).flat();
  const level3 = await mineLevel(allL2Terms, store, redis, appMeta, globalSeen, 3);

  // ── Build nested tree ───────────────────────────────────────────────────
  const tree = {};
  for (const seedKw of seed) {
    tree[seedKw] = {};
    for (const l1Term of (level1[seedKw] ?? [])) {
      tree[seedKw][l1Term] = {};
      for (const l2Term of (level2[l1Term] ?? [])) {
        tree[seedKw][l1Term][l2Term] = level3[l2Term] ?? [];
      }
    }
  }

  // ── Flatten searchTerms by depth ────────────────────────────────────────
  const l1Set = new Set();
  const l2Set = new Set();
  const l3Set = new Set();

  for (const l1Map of Object.values(tree)) {
    for (const [l1Term, l2Map] of Object.entries(l1Map)) {
      l1Set.add(l1Term);
      for (const [l2Term, l3Terms] of Object.entries(l2Map)) {
        l2Set.add(l2Term);
        for (const t of l3Terms) l3Set.add(t);
      }
    }
  }

  return {
    searchTerms: {
      L1: [...l1Set],
      L2: [...l2Set],
      L3: [...l3Set],
    },
    tree,
  };
}
