/**
 * Shared utilities for results-based scoring (popularity, difficulty, etc.).
 * Locale mapping · Tokeniser · Relevance multiplier · Subtitle hydration.
 */

import { scrapeAppPageMetadata } from "./appstore.js";

// ── Locale mapping ────────────────────────────────────────────────────────────

const STORE_LOCALE = {
  us: "en-US",
  gb: "en-GB",
  au: "en-AU",
  ca: "en-CA",
  ie: "en-IE",
  nz: "en-NZ",
  in: "en-IN",
  sg: "en-SG",
  za: "en-ZA",
  jp: "ja-JP",
  cn: "zh-CN",
  tw: "zh-TW",
  hk: "zh-HK",
  kr: "ko-KR",
  th: "th-TH",
  de: "de-DE",
  at: "de-AT",
  ch: "de-CH",
  fr: "fr-FR",
  be: "fr-BE",
  es: "es-ES",
  mx: "es-MX",
  ar: "es-AR",
  it: "it-IT",
  pt: "pt-PT",
  br: "pt-BR",
  nl: "nl-NL",
  ru: "ru-RU",
  pl: "pl-PL",
  tr: "tr-TR",
  se: "sv-SE",
  no: "nb-NO",
  dk: "da-DK",
  fi: "fi-FI",
  ro: "ro-RO",
  hu: "hu-HU",
  cs: "cs-CZ",
  el: "el-GR",
  he: "he-IL",
  ar: "ar-SA",
  id: "id-ID",
  vi: "vi-VN",
};

export function storeToLocale(store) {
  return STORE_LOCALE[store.toLowerCase()] ?? "en-US";
}

// ── Tokeniser ─────────────────────────────────────────────────────────────────

/**
 * Segment text into an array of word tokens using Intl.Segmenter.
 * Handles CJK and space-less scripts correctly without any external libraries.
 */
function tokenize(text, locale) {
  if (!text) return [];
  const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
  const tokens = [];
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (isWordLike) tokens.push(segment);
  }
  return tokens;
}

function normalize(token) {
  return token
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[m][n];
}

function isFuzzyMatch(keywordToken, appToken) {
  if (keywordToken === appToken) return true;

  const longer = Math.max(keywordToken.length, appToken.length);

  if (longer < 4) return false;

  const distance = levenshtein(keywordToken, appToken);

  let maxDistance;
  if (longer <= 7) maxDistance = 1;
  else maxDistance = 2;

  return distance <= maxDistance;
}

function fuzzyContains(longToken, shortToken) {
  let long = longToken;
  let short = shortToken;

  if (long.length < short.length) [long, short] = [short, long];
  if (short.length < 4) return false;
  if (long.length - short.length < 3) return false;

  const window = short.length;
  for (let i = 0; i <= long.length - window; i++) {
    const slice = long.substring(i, i + window);
    if (levenshtein(slice, short) <= 1) return true;
  }

  return false;
}

function matchScore(keywordTokens, appTokens) {
  let matched = 0;

  for (const kw of keywordTokens) {
    if (appTokens.some((app) => isFuzzyMatch(kw, app))) {
      matched++;
      continue;
    }

    if (kw.length >= 4) {
      if (appTokens.some((app) => app.includes(kw) || kw.includes(app))) {
        matched++;
        continue;
      }

      if (appTokens.some((app) => fuzzyContains(app, kw))) {
        matched++;
        continue;
      }
    }
  }

  return keywordTokens.length ? matched / keywordTokens.length : 0;
}

// ── Relevance multiplier ──────────────────────────────────────────────────────

export const MATCH = { EXACT: 1.0, BROAD: 0.6, PARTIAL: 0.1, NONE: 0.01 };

/**
 * Compute the relevance multiplier for a single app against the search keyword.
 *
 * Exact   (1.0) — keyword phrase appears verbatim in name/subtitle
 * Broad   (0.6) — every keyword word appears in name/subtitle (not as a phrase)
 * Partial (0.1) — at least one keyword word appears
 * None   (0.01) — no overlap
 */
export function relevanceMultiplier(keyword, appName, appSubtitle, locale) {
  const appText = `${appName ?? ""} ${appSubtitle ?? ""}`.trim();
  const normalizedAppText = normalize(appText);
  const normalizedKeyword = normalize(keyword.trim());

  if (!normalizedKeyword) return { multiplier: MATCH.NONE, match: "none" };

  if (normalizedAppText.includes(normalizedKeyword)) {
    return { multiplier: MATCH.EXACT, match: "exact" };
  }

  const kwTokens = tokenize(keyword, locale).map(normalize);
  const appTokens = tokenize(appText, locale).map(normalize);

  if (!kwTokens.length) return { multiplier: MATCH.NONE, match: "none" };

  const score = matchScore(kwTokens, appTokens);

  if (score === 1) return { multiplier: MATCH.BROAD, match: "broad" };
  if (score > 0) return { multiplier: MATCH.PARTIAL, match: "partial" };
  return { multiplier: MATCH.NONE, match: "none" };
}

// ── Subtitle hydration ────────────────────────────────────────────────────────

const SUBTITLE_CONCURRENCY = 5;

/**
 * Scrape subtitles for apps that didn't get one from SSR (typically ranks 12+).
 * Runs in batched waves of SUBTITLE_CONCURRENCY to avoid hammering Apple.
 */
export async function hydrateSubtitles(apps, store) {
  const missing = apps.filter((a) => a.subtitle == null);
  if (!missing.length) return;

  for (let i = 0; i < missing.length; i += SUBTITLE_CONCURRENCY) {
    const wave = missing.slice(i, i + SUBTITLE_CONCURRENCY);
    await Promise.all(
      wave.map(async (app) => {
        try {
          const meta = await scrapeAppPageMetadata(app.id, store);
          if (meta?.subtitle) app.subtitle = meta.subtitle;
        } catch {
          // subtitle stays null — non-fatal
        }
      }),
    );
  }
}

// ── Shared constants ──────────────────────────────────────────────────────────

export const LOG_CEILING = 5.5; // log10(10,000,000)
