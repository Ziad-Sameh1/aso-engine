/**
 * Mining Service
 *
 * Fetches App Store metadata for a given app across one or more storefronts in parallel,
 * generates localized search intents via Gemini, then iteratively discovers competitor
 * apps by feeding extracted n-grams back as search queries until the neighborhood saturates.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  fetchSearchHtmlViaProxy,
  extractSearchResults,
  scrapeAppPageMetadata,
  scrapeAppNameSubtitle,
  lookupAppMetadata,
  resetProxyAgent,
} from "./appstore.js";
import { config } from "../config/index.js";

// ── Concurrency limiter ───────────────────────────────────────────────────────

export function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  }
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

// ── Batch runner with backoff retry ──────────────────────────────────────────

const RETRY_MAX_ROUNDS = 3;
const RETRY_BASE_DELAY_MS = 3000;
const RETRY_FAILURE_THRESHOLD = 0.05; // only retry if >5% of items failed

/**
 * Run a batch of async tasks concurrently (up to `concurrency`), collect
 * failures, then retry failed items with exponential backoff — but only
 * if the failure rate exceeds RETRY_FAILURE_THRESHOLD (5%).
 *
 * @param {Array<T>} items - Items to process.
 * @param {(item: T) => Promise<R>} fn - Async function to run per item.
 * @param {number} concurrency - Max parallel tasks.
 * @param {string} label - Log label for progress.
 * @returns {Promise<Map<T, { ok: boolean, value?: R, error?: Error }>>}
 */
async function runWithRetry(items, fn, concurrency, label = "") {
  const results = new Map();
  let pending = [...items];
  const totalItems = items.length;

  for (let attempt = 0; attempt <= RETRY_MAX_ROUNDS; attempt++) {
    if (pending.length === 0) break;

    // Skip retry if failure rate is below threshold (not worth the backoff wait)
    if (attempt > 0 && pending.length / totalItems <= RETRY_FAILURE_THRESHOLD) {
      console.log(
        `[mining] ${label}: ${pending.length}/${totalItems} failed (${Math.round((pending.length / totalItems) * 100)}%) — below ${RETRY_FAILURE_THRESHOLD * 100}% threshold, skipping retries`,
      );
      for (const item of pending) {
        results.set(item, { ok: false, error: new Error("skipped retry — below failure threshold") });
      }
      break;
    }

    if (attempt > 0) {
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(
        `[mining] ${label}: retry ${attempt}/${RETRY_MAX_ROUNDS} — ${pending.length}/${totalItems} items (${Math.round((pending.length / totalItems) * 100)}%), backoff ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }

    const failed = [];
    const limit = createLimiter(concurrency);
    await Promise.all(
      pending.map((item) =>
        limit(async () => {
          try {
            const value = await fn(item);
            results.set(item, { ok: true, value });
          } catch (error) {
            failed.push(item);
            if (attempt === RETRY_MAX_ROUNDS) {
              results.set(item, { ok: false, error });
            }
          }
        }),
      ),
    );

    pending = failed;
  }

  return results;
}

// ── Gemini: localized intents ─────────────────────────────────────────────────

async function generateLocalizedIntents({ meta, storeCodes }) {
  if (!config.geminiApiKey)
    throw new Error("GEMINI_API_KEY is not configured.");

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `You are an App Store Optimization expert. Use the following App Store metadata to deeply understand this app's purpose, core features, and target audience.

App name: ${meta.name ?? ""}
Subtitle: ${meta.subtitle ?? ""}
Description:
${meta.description ?? ""}

For each of the store codes below, generate 5–8 short search phrases (1–3 words) that real users in THAT market type into the App Store search when looking for this kind of app.

Rules:
- Ground every intent in the actual features and use cases described above — do not guess generically.
- Start with the most direct, high-volume terms (e.g. if the app is a calorie tracker, "calorie tracker" must come first for English stores).
- Then add close variants that reflect regional vocabulary and language (e.g. "calorie counter" in GB, "maths tutor" vs "math tutor").
- Non-English storefronts: use the local language naturally, not just a translation.
- Prioritize what users search for, not how the developer describes the app.
- Lowercase, no duplicates, no brand names.

Stores: ${storeCodes.join(", ")}

Return ONLY a valid JSON array — nothing else:
[
  { "store": "<store_code>", "localizedIntents": ["...", "..."] }
]`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  const json = text
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  return JSON.parse(json);
}

/**
 * Like generateLocalizedIntents but generates exactly 25 intents per store
 * with stronger localization requirements (used by mine/v2).
 *
 * @param {{ name: string, subtitle: string|null, description: string|null }} meta
 * @param {string[]} storeCodes
 * @returns {Promise<Array<{ store: string, intents: string[] }>>}
 */
export async function generateLocalizedIntentsV2({ meta, storeCodes }) {
  if (!config.geminiApiKey)
    throw new Error("GEMINI_API_KEY is not configured.");

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `You are an App Store Optimization expert. Use the following App Store metadata to deeply understand this app's purpose, core features, and target audience.

App name: ${meta.name ?? ""}
Subtitle: ${meta.subtitle ?? ""}
Description:
${meta.description ?? ""}

For each store code below, generate exactly 25 short search phrases (1–3 words) that real users in THAT locale would type into the App Store when looking for this kind of app.

Rules:
- CATEGORY ANCHORING: First, determine the app's primary App Store category (e.g., Finance, Productivity). EVERY intent must unambiguously belong to this category. Do not use generic terms that might return Games or unrelated Utilities.
- AVOID AMBIGUITY: Do not use words that have double meanings in the target language if the alternate meaning belongs to a different category (e.g., in Italian, avoid words for "budget/balance" that also mean "physical weight scale").
- Ground every intent in the actual features and use cases described above — do not guess generically.
- Start with the most direct, high-volume terms first.
- Non-English storefronts: use the local language naturally — think like a native speaker, not a translator.
  Examples: Arabic stores (ar, sa, ae, eg) → Arabic script. Spanish stores (es, mx, cl, co) → Spanish. Italian (it) → Italian. German (de) → German. French (fr) → French.
- Prioritize what users search for, not how the developer describes the app.
- Lowercase, no duplicates, no brand names.
- Exactly 25 intents per store — no more, no less.

Stores: ${storeCodes.join(", ")}

Return ONLY a valid JSON array — nothing else:
[
  { "store": "<store_code>", "intents": ["...", "..."] }
]`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  const json = text
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  return JSON.parse(json);
}

const SEARCH_TERMS_BATCH_SIZE = 20;

/**
 * For a list of competitors (id, name, subtitle), generate all possible search
 * phrases a user might type to find each app. Batches into groups of 50 and
 * runs all batches in parallel.
 *
 * @param {Array<{ id: string, name: string, subtitle: string|null }>} competitors
 * @returns {Promise<Map<string, string[]>>}  id → searchTerms[]
 */
export async function generateCompetitorSearchTerms(competitors) {
  if (!config.geminiApiKey)
    throw new Error("GEMINI_API_KEY is not configured.");

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  // Split into batches of 50
  const batches = [];
  for (let i = 0; i < competitors.length; i += SEARCH_TERMS_BATCH_SIZE) {
    batches.push(competitors.slice(i, i + SEARCH_TERMS_BATCH_SIZE));
  }

  const batchResults = await Promise.all(
    batches.map(async (batch) => {
      const appList = batch
        .map((c) => `- id: ${c.id} | name: ${c.name}${c.subtitle ? ` | subtitle: ${c.subtitle}` : ""}`)
        .join("\n");

      const prompt = `You are an App Store keyword expert. For each app below, generate ALL possible search phrases (1–3 words) that a real user might type into the App Store search bar to find that specific app. Include every variation, synonym, and combination that makes sense.

Apps:
${appList}

Rules:
- Extract terms directly from the name and subtitle — every meaningful word, pair, and triplet
- Include synonyms and close variants (e.g. "bill tracker" → also "invoice tracker", "payment tracker")
- Lowercase, no brand names, no duplicates within an app
- Aim for completeness — it's better to have too many than too few

Return ONLY a valid JSON array — nothing else:
[
  { "id": "<id>", "searchTerms": ["...", "..."] }
]`;

      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();
      const json = text
        .replace(/^```(?:json)?\n?/, "")
        .replace(/\n?```$/, "")
        .trim();
      try {
        return JSON.parse(json);
      } catch {
        console.warn(`[mine-v2] search terms batch parse failed (truncated?), returning empty for ${batch.length} apps`);
        return batch.map((c) => ({ id: c.id, searchTerms: [] }));
      }
    })
  );

  // Flatten all batches into a single id → terms map
  const termsMap = new Map();
  for (const batch of batchResults) {
    for (const { id, searchTerms } of batch) {
      termsMap.set(String(id), searchTerms ?? []);
    }
  }
  return termsMap;
}

// ── Keyword extraction pipeline ───────────────────────────────────────────────

const STOPWORDS = new Set([
  "the",
  "of",
  "your",
  "a",
  "an",
  "and",
  "for",
  "with",
  "to",
  "in",
  "on",
  "by",
  "my",
  "no",
  "get",
  "is",
]);

/**
 * Step 1 — Normalize a name or subtitle string.
 * Strip brand-like prefixes (before : or -), remove ™®, #1, parenthesized
 * marketing content, numeric-only tokens like "20M+DN". Lowercase.
 */
function normalize(text) {
  if (!text) return "";

  let s = text;

  // Strip brand-like prefix: "BrandName: rest" or "BrandName - rest"
  // Heuristic: prefix is a single capitalized word (possibly with digits)
  s = s.replace(/^[A-Z][A-Za-z0-9]*\s*[:\-–—]\s*/, "");

  // Remove ™ ® © symbols
  s = s.replace(/[™®©]/g, "");

  // Remove "#1", "20M+DN" style marketing tokens
  s = s.replace(/#\d+/g, "");
  s = s.replace(/\b\d+[A-Z+]+\w*\b/g, "");

  // Remove parenthesized content: (Remove Ads), (Free), etc.
  s = s.replace(/\([^)]*\)/g, "");

  // Strip trailing punctuation from each word
  s = s.replace(/[.:,]+(?=\s|$)/g, "");

  // Collapse whitespace and lowercase
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Step 2 — Conjunction expansion.
 * Detects shared-head or shared-tail patterns across segments split on , / & / and.
 * "track income, bills & spending" → ["track income", "track bills", "track spending"]
 * "spending, investing, net worth" → ["spending", "investing", "net worth"]
 */
function expandConjunctions(phrase) {
  // Split on ,  & and  (with surrounding whitespace)
  const segments = phrase
    .split(/\s*(?:,\s*|\s+&\s+|\s+and\s+)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length <= 1) return segments;

  const wordCounts = segments.map((s) => s.split(/\s+/).length);
  const firstCount = wordCounts[0];
  const lastCount = wordCounts[wordCounts.length - 1];

  // Median of non-first/non-last segment word counts (or all-but-first for head detection)
  const restCounts = wordCounts.slice(1);
  const restMedian =
    restCounts.length > 0
      ? restCounts.slice().sort((a, b) => a - b)[
          Math.floor(restCounts.length / 2)
        ]
      : firstCount;

  // Shared head: first segment has more words than the rest
  if (firstCount > restMedian && firstCount > 1) {
    const headWordCount = firstCount - restMedian;
    const firstWords = segments[0].split(/\s+/);
    const head = firstWords.slice(0, headWordCount).join(" ");
    const firstTail = firstWords.slice(headWordCount).join(" ");
    return [
      `${head} ${firstTail}`,
      ...segments.slice(1).map((s) => `${head} ${s}`),
    ];
  }

  // Shared tail: last segment has more words than the rest
  const frontCounts = wordCounts.slice(0, -1);
  const frontMedian =
    frontCounts.length > 0
      ? frontCounts.slice().sort((a, b) => a - b)[
          Math.floor(frontCounts.length / 2)
        ]
      : lastCount;

  if (lastCount > frontMedian && lastCount > 1) {
    const lastWords = segments[segments.length - 1].split(/\s+/);
    const tailWordCount = lastCount - frontMedian;
    const tail = lastWords.slice(-tailWordCount).join(" ");
    const lastHead = lastWords.slice(0, -tailWordCount).join(" ");
    return [
      ...segments.slice(0, -1).map((s) => `${s} ${tail}`),
      `${lastHead} ${tail}`,
    ];
  }

  // No shared context — return individual segments, joined phrase, and original with conjunctions
  return [...segments, segments.join(" "), phrase];
}

/**
 * Step 3 — Split bare lists. Any remaining comma/semicolon-separated items.
 */
function splitBareList(phrase) {
  return phrase
    .split(/\s*[,;]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Step 4 — Generate n-grams from a phrase.
 * - Contiguous n-grams for n = 1..4
 * - Skip-bigrams: all ordered pairs (not just adjacent), so
 *   "personal expense tracker" also produces "personal tracker"
 * - The full phrase itself is always included regardless of length.
 */
function generateNgrams(phrase) {
  const words = phrase.split(/\s+/).filter(Boolean);
  const ngrams = new Set();

  // Always keep the full phrase
  if (words.length > 0) ngrams.add(words.join(" "));

  // Contiguous n-grams (n = 1..4)
  for (let n = 1; n <= Math.min(4, words.length); n++) {
    for (let i = 0; i <= words.length - n; i++) {
      ngrams.add(words.slice(i, i + n).join(" "));
    }
  }

  return [...ngrams];
}

const JUNK_EDGE_TOKENS = new Set(["&", "-", "—", ":", "|", "+"]);

/**
 * Step 5 — Filtering.
 * - Drop n-grams where first or last token is a symbol (sliced mid-phrase).
 * - Drop n-grams where EVERY word is a stopword.
 * - Drop single-char tokens and pure numeric tokens.
 */
function filterNgram(ngram) {
  const words = ngram.split(/\s+/);
  // Drop if edge token is a symbol
  if (
    JUNK_EDGE_TOKENS.has(words[0]) ||
    JUNK_EDGE_TOKENS.has(words[words.length - 1])
  )
    return false;
  // Drop single-char or pure numeric
  if (words.length === 1 && (words[0].length <= 1 || /^\d+$/.test(words[0])))
    return false;
  // Drop if every word is a stopword
  if (words.every((w) => STOPWORDS.has(w))) return false;
  return true;
}

/**
 * Run the normalization → expansion → n-gram pipeline on a single app.
 * Returns a Set of unique keyword strings for that app.
 */
function extractAppNgrams({ name, subtitle }) {
  const ngrams = new Set();
  const texts = [normalize(name), normalize(subtitle)].filter(Boolean);

  for (const text of texts) {
    const expanded = expandConjunctions(text);
    const phrases = expanded.flatMap(splitBareList);
    const generated = phrases.flatMap(generateNgrams);
    for (const ng of generated) {
      if (filterNgram(ng)) ngrams.add(ng);
    }
  }

  return ngrams;
}

/**
 * Full pipeline: takes corpus apps + own app, returns deduplicated keyword
 * strings sorted by frequency descending.
 *
 * Corpus n-grams require freq >= 2 to cut noise. Freq-1 keywords are kept
 * only if they also appear in the own app's name/subtitle.
 *
 * @param {Array<{ name: string, subtitle: string|null }>} apps - corpus (search results)
 * @param {{ name: string, subtitle: string|null }} ownApp - the app being mined
 * @returns {Array<{ keyword: string, frequency: number }>}
 */
export function extractKeywords(apps, ownApp) {
  // Build own-app keyword set
  const ownKeywords = ownApp ? extractAppNgrams(ownApp) : new Set();

  // Count corpus frequencies
  const freq = new Map();
  for (const app of apps) {
    const appNgrams = extractAppNgrams(app);
    for (const ng of appNgrams) {
      freq.set(ng, (freq.get(ng) ?? 0) + 1);
    }
  }

  // Filter: freq >= 2, or freq 1 if it's from the own app
  return [...freq.entries()]
    .filter(
      ([keyword, frequency]) => frequency >= 2 || ownKeywords.has(keyword),
    )
    .sort((a, b) => b[1] - a[1])
    .map(([keyword, frequency]) => ({ keyword, frequency }));
}

/**
 * Extract all bigrams and 3-grams from a list of competitor apps.
 *
 * Bigrams (2-word): all ordered pairs (order varies, i.e. skip-bigrams),
 *   so "personal expense tracker" → "personal expense", "personal tracker", "expense tracker"
 * 3-grams (3-word): contiguous only (order fixed),
 *   so "personal expense tracker" → "personal expense tracker"
 *
 * Each ngram goes through the normalize → expand → split pipeline first.
 * Returns frequency-sorted lists with counts.
 *
 * @param {Array<{ name: string, subtitle: string|null }>} competitors
 * @returns {{ bigrams: { ngram: string, count: number }[], trigrams: { ngram: string, count: number }[] }}
 */
export function extractAllNgrams(competitors) {
  const bigramFreq = new Map();
  const trigramFreq = new Map();

  for (const app of competitors) {
    const texts = [normalize(app.name), normalize(app.subtitle)].filter(Boolean);
    // Collect per-app unique ngrams to count each app once
    const appBigrams = new Set();
    const appTrigrams = new Set();

    for (const text of texts) {
      const expanded = expandConjunctions(text);
      const phrases = expanded.flatMap(splitBareList);

      for (const phrase of phrases) {
        const words = phrase.split(/\s+/).filter(Boolean);

        // Bigrams: all ordered pairs (skip-bigrams)
        for (let i = 0; i < words.length; i++) {
          for (let j = i + 1; j < words.length; j++) {
            const bg = `${words[i]} ${words[j]}`;
            if (filterNgram(bg)) appBigrams.add(bg);
          }
        }

        // 3-grams: contiguous only
        for (let i = 0; i <= words.length - 3; i++) {
          const tg = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
          if (filterNgram(tg)) appTrigrams.add(tg);
        }
      }
    }

    for (const bg of appBigrams) bigramFreq.set(bg, (bigramFreq.get(bg) ?? 0) + 1);
    for (const tg of appTrigrams) trigramFreq.set(tg, (trigramFreq.get(tg) ?? 0) + 1);
  }

  const bigrams = [...bigramFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([ngram, count]) => ({ ngram, count }));

  const trigrams = [...trigramFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([ngram, count]) => ({ ngram, count }));

  return {
    bigrams,
    bigramCount: bigrams.length,
    trigrams,
    trigramCount: trigrams.length,
  };
}

// ── Iterative search loop per store ─────────────────────────────────────────

const SEARCH_LIMIT = 200;
const SEARCH_CONCURRENCY = 100;
const MAX_ROUNDS = 5;
const NEW_APP_THRESHOLD = 0.05; // stop when <5% new apps

/**
 * Run searches for a list of intents concurrently via proxy with backoff retry.
 * Returns raw arrays of search results per intent (order preserved).
 */
async function searchIntentsRaw(store, intents) {
  const batch = await runWithRetry(
    intents,
    async (intent) => {
      const html = await fetchSearchHtmlViaProxy(intent, store);
      return extractSearchResults(html).slice(0, SEARCH_LIMIT);
    },
    SEARCH_CONCURRENCY,
    `${store}:search`,
  );

  // Preserve order, return empty array for failed intents
  return intents.map((intent) => {
    const r = batch.get(intent);
    if (r?.ok) return r.value;
    if (r && !r.ok)
      console.warn(
        `[mining] search exhausted retries for "${intent}" (${store}): ${r.error?.message}`,
      );
    return [];
  });
}

/**
 * Resolve metadata for apps that don't have it yet.
 * Mutates knownMeta in place using a hybrid strategy:
 *
 *  1. Collect names/subtitles already present in SSR results (top ~12 per search)
 *  2. iTunes Lookup API for all remaining unknown IDs (batched, fast, name-only)
 *  3. Selective HTML scrape for high-frequency apps (count >= SUBTITLE_SCRAPE_MIN)
 *     to get their subtitles — these are the real competitors whose subtitles
 *     meaningfully contribute to keyword extraction.
 */
async function resolveMetadata(store, intentResults, knownMeta, countMap) {
  // Step 1: Collect names already present in search results (top ~12 per search)
  for (const results of intentResults) {
    for (const r of results) {
      if (r.name && !knownMeta.has(r.id)) {
        knownMeta.set(r.id, { name: r.name, subtitle: r.subtitle ?? null });
      }
    }
  }

  // Collect all unknown IDs
  const unknownIds = new Set();
  for (const results of intentResults) {
    for (const r of results) {
      if (!knownMeta.has(r.id)) unknownIds.add(r.id);
    }
  }

  if (unknownIds.size === 0) return;

  // Step 2: iTunes Lookup for ALL unknown IDs (batched, ~200/req, lightweight JSON)
  const lookupIds = [...unknownIds];
  console.log(
    `[mining] ${store}: iTunes lookup for ${lookupIds.length} deferred apps`,
  );
  const lookupMeta = await lookupAppMetadata(lookupIds, store);
  let lookupHits = 0;
  for (const id of lookupIds) {
    const m = lookupMeta[id];
    if (m?.name) {
      knownMeta.set(id, { name: m.name, subtitle: null });
      lookupHits++;
    }
  }
  console.log(
    `[mining] ${store}: iTunes lookup resolved ${lookupHits}/${lookupIds.length} names`,
  );

  // Step 3: Scrape subtitles for all apps missing them, sorted by count descending
  // (highest-value competitors first).
  const needsSubtitle = [...unknownIds]
    .filter((id) => knownMeta.has(id) && knownMeta.get(id).subtitle === null)
    .sort((a, b) => (countMap.get(b) ?? 0) - (countMap.get(a) ?? 0));

  if (needsSubtitle.length > 0) {
    const SCRAPE_CONCURRENCY = 100;

    console.log(
      `[mining] ${store}: scraping subtitles for ${needsSubtitle.length} apps (concurrency ${SCRAPE_CONCURRENCY})`,
    );

    const scrapeT0 = performance.now();
    const scrapeTimes = [];

    const batch = await runWithRetry(
      needsSubtitle,
      async (id) => {
        const t0 = performance.now();
        const meta = await scrapeAppNameSubtitle(id, store, config.proxyUrl);
        scrapeTimes.push(Math.round(performance.now() - t0));
        if (!meta?.name) throw new Error("no metadata");
        return meta;
      },
      SCRAPE_CONCURRENCY,
      `${store}:subtitle`,
    );

    const scrapeMs = Math.round(performance.now() - scrapeT0);
    if (scrapeTimes.length > 0) {
      scrapeTimes.sort((a, b) => a - b);
      const p50 = scrapeTimes[Math.floor(scrapeTimes.length * 0.5)];
      const p90 = scrapeTimes[Math.floor(scrapeTimes.length * 0.9)];
      const p99 = scrapeTimes[Math.floor(scrapeTimes.length * 0.99)];
      const avg = Math.round(scrapeTimes.reduce((s, v) => s + v, 0) / scrapeTimes.length);
      console.log(
        `[mining] ${store}: subtitle scrape done — ${scrapeMs}ms wall, avg=${avg}ms p50=${p50}ms p90=${p90}ms p99=${p99}ms max=${scrapeTimes[scrapeTimes.length - 1]}ms (n=${scrapeTimes.length})`,
      );
    }

    for (const [id, r] of batch) {
      if (r.ok) {
        knownMeta.set(id, r.value);
      }
    }
  }
}

/**
 * Iterative feedback loop for a single store.
 *
 * Round 0: search using Gemini intents → discover apps → extract n-grams
 * Round 1+: feed back top 2–3 word n-grams as new intents → discover more apps
 * Each round searches 3x the previous round's intent count.
 * Stops when <5% of returned apps are new (neighborhood saturated).
 *
 * @param {string} store
 * @param {string[]} initialIntents - Gemini-generated intents for round 0
 * @param {{ name: string, subtitle: string|null }} ownApp
 * @returns {Promise<{ searchResults, keywords, roundStats }>}
 */
async function mineStoreIterative(store, initialIntents, ownApp) {
  const knownMeta = new Map(); // id → { name, subtitle }
  const countMap = new Map(); // id → total appearance count
  const seenAppIds = new Set();
  const searchedIntents = new Set();
  const roundStats = [];

  let currentIntents = initialIntents.filter(Boolean);
  let round = 0;

  while (currentIntents.length > 0 && round < MAX_ROUNDS) {
    const roundT0 = performance.now();
    console.log(
      `[mining] ${store}: round ${round} — searching ${currentIntents.length} intents`,
    );

    // Search
    const intentResults = await searchIntentsRaw(store, currentIntents);
    for (const intent of currentIntents) searchedIntents.add(intent);

    // Count unique apps this round (before resolve so counts are available for prioritization)
    const roundAppIds = new Set();
    for (const results of intentResults) {
      for (const r of results) {
        roundAppIds.add(r.id);
        countMap.set(r.id, (countMap.get(r.id) ?? 0) + 1);
      }
    }

    let newAppCount = 0;
    for (const id of roundAppIds) {
      if (!seenAppIds.has(id)) newAppCount++;
      seenAppIds.add(id);
    }

    // Resolve metadata (incremental — skips already-known IDs and single-hit apps)
    await resolveMetadata(store, intentResults, knownMeta, countMap);

    const roundMs = Math.round(performance.now() - roundT0);
    const newRatio = roundAppIds.size > 0 ? newAppCount / roundAppIds.size : 0;

    roundStats.push({
      round,
      intentsSearched: currentIntents.length,
      appsThisRound: roundAppIds.size,
      newApps: newAppCount,
      totalApps: seenAppIds.size,
      newPercent: Math.round(newRatio * 100),
      ms: roundMs,
    });

    console.log(
      `[mining] ${store}: round ${round} done — ` +
        `${newAppCount} new / ${roundAppIds.size} returned (${Math.round(newRatio * 100)}%) — ` +
        `total: ${seenAppIds.size} apps — ${roundMs}ms`,
    );

    // Termination: <5% new apps after round 0
    if (round > 0 && newRatio < NEW_APP_THRESHOLD) {
      console.log(`[mining] ${store}: saturated at round ${round}, stopping`);
      break;
    }

    // Extract keywords only from high-overlap apps (relevance gate).
    // An app that matched only 1-2 intents is likely not a real competitor —
    // its n-grams shouldn't steer the next round's search.
    const minCount = 2 + round; // round 0 → 2, round 1 → 3, round 2 → 4, ...
    const relevantApps = [];
    for (const [id, count] of countMap) {
      if (count >= minCount) {
        const meta = knownMeta.get(id);
        if (meta) relevantApps.push(meta);
      }
    }
    const keywords = extractKeywords(relevantApps, ownApp);

    // Pick new 2–3 word n-grams not yet searched, capped per round
    const MAX_INTENTS_PER_ROUND = 30;
    currentIntents = keywords
      .filter(({ keyword }) => {
        const wordCount = keyword.split(/\s+/).length;
        return (
          wordCount >= 2 && wordCount <= 3 && !searchedIntents.has(keyword)
        );
      })
      .slice(0, MAX_INTENTS_PER_ROUND)
      .map(({ keyword }) => keyword);

    round++;
  }

  // Build final merged results sorted by appearance count
  const FINAL_MIN_COUNT = 3;
  const merged = [];
  for (const [id, count] of countMap) {
    const meta = knownMeta.get(id);
    if (!meta) continue;
    merged.push({ id, name: meta.name, subtitle: meta.subtitle, count });
  }
  merged.sort((a, b) => b.count - a.count);

  // Final keywords from relevant apps only — apps with low counts are
  // off-category noise (to-do lists, scanners, etc. that Apple ranks low).
  const relevantMerged = merged.filter((app) => app.count >= FINAL_MIN_COUNT);
  console.log(
    `[mining] ${store}: final keyword extraction from ${relevantMerged.length}/${merged.length} apps (count >= ${FINAL_MIN_COUNT})`,
  );
  const keywords = extractKeywords(relevantMerged, ownApp);

  return { searchResults: merged, keywords, roundStats };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Mine app metadata + localized intents + iterative competitor discovery per store.
 *
 * @param {string} appleId
 * @param {string[]} stores
 * @returns {Promise<{ appleId: string, stores: Array, timings: object } | null>}
 */
export async function mineApp(appleId, stores = ["us"]) {
  const totalT0 = performance.now();

  // Scrape all stores in parallel
  const scraped = await Promise.all(
    stores.map(async (store) => {
      const t0 = performance.now();
      const meta = await scrapeAppPageMetadata(appleId, store, config.proxyUrl);
      const ms = Math.round(performance.now() - t0);
      return { store, meta, ms };
    }),
  );

  const found = scraped.filter((r) => r.meta !== null);
  if (found.length === 0) return null;

  // Single Gemini call using US (or first found) store metadata — full description included
  const usEntry = found.find((r) => r.store === "us") ?? found[0];
  const geminiT0 = performance.now();
  const intentsArray = await generateLocalizedIntents({
    meta: usEntry.meta,
    storeCodes: found.map((r) => r.store),
  });
  const geminiMs = Math.round(performance.now() - geminiT0);

  const intentsMap = Object.fromEntries(
    intentsArray.map((r) => [r.store, r.localizedIntents]),
  );

  // Run iterative mining for all stores in parallel
  const miningT0 = performance.now();
  const miningResultsMap = Object.fromEntries(
    await Promise.all(
      found.map(async ({ store, meta }) => {
        const intents = intentsMap[store] ?? [];
        const ownApp = { name: meta.name, subtitle: meta.subtitle };
        const result = await mineStoreIterative(store, intents, ownApp);
        return [store, result];
      }),
    ),
  );
  const miningMs = Math.round(performance.now() - miningT0);

  const storeResults = scraped.map(({ store, meta, ms }) => {
    if (!meta) return { store, found: false, ms };
    const mined = miningResultsMap[store];
    return {
      store,
      found: true,
      ms,
      name: meta.name,
      subtitle: meta.subtitle,
      localizedIntents: intentsMap[store] ?? [],
      searchResults: mined?.searchResults ?? [],
      searchResultsCount: (mined?.searchResults ?? []).length,
      keywords: mined?.keywords ?? [],
      rounds: mined?.roundStats ?? [],
    };
  });

  const totalMs = Math.round(performance.now() - totalT0);

  return {
    appleId,
    stores: storeResults,
    timings: {
      totalMs,
      geminiMs,
      miningMs,
      perStore: Object.fromEntries(scraped.map(({ store, ms }) => [store, ms])),
    },
  };
}
