import { franc } from "franc";
import { scrapeAppPageMetadata } from "../services/appstore.js";
import { DEFAULT_STORES } from "../services/setupService.js";
import { config } from "../config/index.js";

// ── Store → expected ISO 639-3 language code(s) ──────────────────────────────
// franc returns ISO 639-3 codes. Some stores accept multiple languages
// (e.g. Canada: English or French, Switzerland: German/French/Italian).
const STORE_EXPECTED_LANGS = {
  us: ["eng"], gb: ["eng"], au: ["eng"], nz: ["eng"], ie: ["eng"], sg: ["eng"], in: ["eng", "hin"], za: ["eng"],
  ca: ["eng", "fra"],
  jp: ["jpn"],
  kr: ["kor"],
  cn: ["cmn", "zho"],
  tw: ["cmn", "zho"],
  hk: ["cmn", "zho", "yue"],
  th: ["tha"],
  de: ["deu"], at: ["deu"],
  ch: ["deu", "fra", "ita"],
  fr: ["fra"],
  be: ["fra", "nld"],
  es: ["spa"], mx: ["spa"], ar: ["spa"],
  it: ["ita"],
  pt: ["por"], br: ["por"],
  nl: ["nld"],
  ru: ["rus"],
  pl: ["pol"],
  tr: ["tur"],
  se: ["swe"],
  no: ["nob", "nno"],
  dk: ["dan"],
  fi: ["fin"],
  ro: ["ron"],
  hu: ["hun"],
  cz: ["ces"],
  gr: ["ell"],
  il: ["heb"],
  sa: ["arb", "ara"], ae: ["arb", "ara"], eg: ["arb", "ara"],
  id: ["ind"],
  vn: ["vie"],
};

/**
 * Detect if a text field is in the expected language for a store.
 * Returns true if franc detects the text as one of the store's expected languages,
 * OR if the store expects English (since English is the default/fallback).
 *
 * @param {string|null} text
 * @param {string[]} expectedLangs - ISO 639-3 codes
 * @returns {boolean}
 */
function isFieldLocalized(text, expectedLangs) {
  if (!text || text.trim().length === 0) return false;

  // If this store accepts English, English text counts as localized
  if (expectedLangs.includes("eng")) return true;

  const detected = franc(text);
  if (detected === "und") return false; // undetermined — text too short

  return expectedLangs.includes(detected);
}

/**
 * Detect localization status for an app in a given store.
 */
function detectLocalization(meta, store) {
  const expectedLangs = STORE_EXPECTED_LANGS[store] || ["eng"];

  // Stores that accept English: English text is localized
  if (expectedLangs.includes("eng")) {
    return { status: "yes", fields: ["title", "subtitle", "description"] };
  }

  const fields = [];
  if (isFieldLocalized(meta.name, expectedLangs)) fields.push("title");
  if (isFieldLocalized(meta.subtitle, expectedLangs)) fields.push("subtitle");
  if (isFieldLocalized(meta.description, expectedLangs)) fields.push("description");

  if (fields.length === 0) return { status: "no", fields: [] };
  if (fields.length === 3) return { status: "yes", fields };
  return { status: "partial", fields };
}

export async function localizationRoutes(fastify) {
  fastify.get(
    "/api/apps/:appleId/localization",
    {
      schema: {
        params: {
          type: "object",
          required: ["appleId"],
          properties: {
            appleId: { type: "string", minLength: 1 },
          },
        },
        querystring: {
          type: "object",
          properties: {
            stores: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { appleId } = request.params;
      const { stores: storesParam } = request.query;
      const proxyUrl = config.proxyUrl ?? null;
      const totalT0 = performance.now();

      const targetStores = storesParam
        ? storesParam.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
        : DEFAULT_STORES;

      // Scrape all stores in parallel
      const scrapeResults = await Promise.all(
        targetStores.map(async (store) => {
          const t0 = performance.now();
          const meta = await scrapeAppPageMetadata(appleId, store, proxyUrl);
          const ms = Math.round(performance.now() - t0);
          return { store, meta, ms };
        }),
      );

      const storeResults = scrapeResults.map(({ store, meta, ms }) => {
        if (!meta) {
          return {
            store,
            found: false,
            localized: { status: "no", fields: [] },
            bestKeyword: null,
            bestRank: null,
            ratingCount: null,
            ms,
          };
        }

        const localization = detectLocalization(meta, store);

        const bestKeyword = {
          keyword: "app store optimization",
          popularity: 45,
          difficulty: 32,
          opportunity: 13,
        };

        return {
          store,
          found: true,
          localized: localization,
          bestKeyword,
          bestRank: null,
          ratingCount: meta.reviewCount ?? null,
          ms,
        };
      });

      const totalMs = Math.round(performance.now() - totalT0);

      return {
        appleId,
        stores: storeResults,
        timings: {
          totalMs,
          perStore: Object.fromEntries(
            storeResults.map(({ store, ms }) => [store, ms]),
          ),
        },
      };
    },
  );
}
