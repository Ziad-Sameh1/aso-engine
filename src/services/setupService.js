import { GoogleGenerativeAI } from "@google/generative-ai";
import { scrapeAppPageMetadata } from "./appstore.js";
import { config } from "../config/index.js";

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "for", "nor", "so", "yet",
  "at", "by", "in", "of", "on", "to", "up", "as", "is", "it",
  "its", "be", "do", "if", "my", "no", "we", "he", "she", "they",
  "you", "me", "us", "him", "her", "with", "from", "into", "onto",
  "than", "that", "this", "your", "our", "their", "was", "are",
  "has", "had", "have", "not", "can", "all", "any", "also",
]);

/**
 * Deterministically extract all single-word tokens from a text string.
 * Splits on whitespace/punctuation, lowercases, filters stop words.
 */
function extractTokens(text) {
  if (!text) return [];
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[\s\-–—\/\|&,.:;!?()[\]{}'"]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && !STOP_WORDS.has(t))
    ),
  ];
}

/**
 * Single Gemini call for all stores at once — only for description tokens.
 * Title and subtitle tokens are extracted deterministically by extractTokens().
 *
 * storeMetaList: Array<{ store: string, meta: object, titleTokens: string[], subtitleTokens: string[] }>
 * Returns: Array<{ store: string, descriptionTokens: string[] }>
 */
async function extractDescriptionTokensForAllStores(storeMetaList) {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is not configured.");

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const storesBlock = storeMetaList
    .map(({ store, meta, titleTokens, subtitleTokens }) =>
      `Store: ${store}\nAlready indexed tokens (exclude these): ${[...titleTokens, ...subtitleTokens].join(", ")}\nDescription: ${meta.description ?? ""}`
    )
    .join("\n\n---\n\n");

  const prompt = `You are an App Store Optimization expert. Extract description keyword tokens for each store.

${storesBlock}

Rules (apply to every store):
- Extract the 10 most search-relevant SINGLE-WORD tokens from the description.
- Rank by: (1) frequency — words appearing multiple times rank higher, (2) prominence — words in feature names or benefit headers rank higher, (3) search intent — words a user would actually type to find this app.
- Single words only — no phrases, no hyphenated compounds. Skip stop words.
- IMPORTANT: do NOT include any word already listed in "Already indexed tokens".
- All tokens lowercase, no duplicates.

Return ONLY a valid JSON array — one object per store in the same order — nothing else:
[
  {
    "store": "<store_code>",
    "descriptionTokens": []
  }
]`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  const json = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  return JSON.parse(json);
}

/**
 * Sets up an app by Apple ID: scrapes all stores in parallel, then calls
 * Gemini once for all stores to extract keyword tokens.
 *
 * Returns a list of objects, one per store:
 *   { store, meta, tokens: { titleTokens, subtitleTokens, descriptionTokens } }
 *
 * Returns null if the app is not found in any store.
 */
export async function setupApp(_pg, { appleId, stores = [] }) {
  const targetStores = stores.length > 0 ? stores : ["us"];

  // Scrape all stores in parallel
  const scraped = await Promise.all(
    targetStores.map(async (store) => ({
      store,
      meta: await scrapeAppPageMetadata(appleId, store),
    }))
  );

  const found = scraped.filter((r) => r.meta !== null);
  if (found.length === 0) return null;

  // Deterministically extract title + subtitle tokens per store
  const foundWithTokens = found.map(({ store, meta }) => ({
    store,
    meta,
    titleTokens: extractTokens(meta.name),
    subtitleTokens: extractTokens(meta.subtitle),
  }));

  // Single Gemini call for description tokens only
  const descResults = await extractDescriptionTokensForAllStores(foundWithTokens);
  const descMap = Object.fromEntries(descResults.map((r) => [r.store, r.descriptionTokens]));

  // Build a lookup for the enriched found stores
  const foundMap = Object.fromEntries(foundWithTokens.map((r) => [r.store, r]));

  let callsCount = 0;

  const storeResults = scraped.map(({ store, meta }) => {
    const f = foundMap[store];
    const tokens = f
      ? { titleTokens: f.titleTokens, subtitleTokens: f.subtitleTokens, descriptionTokens: descMap[store] ?? [] }
      : null;

    const searchTerms = tokens ? buildSearchTerms(tokens) : [];
    callsCount += searchTerms.length;

    return { store, meta, tokens, searchTerms };
  });

  return { stores: storeResults, callsCount };
}

/**
 * Build all 2-token cross-product permutations across title, subtitle, description.
 * Pairs are "tokenA tokenB" (space-joined). No within-list pairs.
 */
function buildSearchTerms({ titleTokens = [], subtitleTokens = [], descriptionTokens = [] }) {
  const all = [...new Set([...titleTokens, ...subtitleTokens, ...descriptionTokens])];
  const seen = new Set();
  const terms = [];

  for (const a of all) {
    for (const b of all) {
      if (a === b) continue;
      const term = `${a} ${b}`;
      if (!seen.has(term)) {
        seen.add(term);
        terms.push(term);
      }
    }
  }

  return terms;
}
