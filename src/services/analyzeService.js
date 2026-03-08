/**
 * App Store Analyze Service
 *
 * Combines two data sources for rich single-app analysis:
 *  1. iTunes Lookup API  — structured fields: screenshots, file size, languages,
 *                          ratings per version, release notes, IAP flag, etc.
 *  2. App Store HTML page — supplementary fields not in iTunes API:
 *                          subtitle, per-star rating % breakdown,
 *                          in-app-purchase list, copyright, developer website.
 *
 * Also provides storefront-availability checking across all ~175 Apple
 * App Store country storefronts using parallelised HTTP requests.
 */

// ── All known Apple App Store storefronts (ISO 3166-1 alpha-2) ───────────────
export const APPLE_STOREFRONTS = [
  "ae", "ag", "ai", "al", "am", "ao", "ar", "at", "au", "az",
  "ba", "bb", "bd", "be", "bf", "bg", "bh", "bj", "bm", "bn",
  "bo", "br", "bs", "bt", "bw", "by", "bz",
  "ca", "cg", "ch", "ci", "cl", "cm", "co", "cr", "cv", "cy", "cz",
  "de", "dj", "dk", "dm", "do", "dz",
  "ec", "ee", "eg", "er", "es", "et",
  "fi", "fj", "fm", "fr",
  "ga", "gb", "gd", "gh", "gm", "gr", "gt", "gw", "gy",
  "hk", "hn", "hr", "ht", "hu",
  "id", "ie", "il", "in", "iq", "is", "it",
  "jm", "jo", "jp",
  "ke", "kg", "kh", "kn", "kr", "kw", "ky", "kz",
  "la", "lb", "lc", "lk", "lr", "lt", "lu", "lv", "ly",
  "ma", "md", "mg", "mk", "ml", "mn", "mo", "mr", "ms", "mt",
  "mu", "mv", "mw", "mx", "my", "mz",
  "na", "ne", "ng", "ni", "nl", "no", "np", "nr", "nz",
  "om",
  "pa", "pe", "pg", "ph", "pk", "pl", "pt", "pw", "py",
  "qa",
  "ro", "ru",
  "sa", "sb", "sc", "se", "sg", "si", "sk", "sl", "sn", "sr",
  "st", "sv", "sz",
  "tc", "td", "th", "tj", "tm", "tn", "to", "tr", "tt", "tw", "tz",
  "ua", "ug", "us", "uy", "uz",
  "vc", "ve", "vg", "vn",
  "ye",
  "za", "zm", "zw",
];

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/144.0.0.0 Safari/537.36";

// ── iTunes Lookup API ────────────────────────────────────────────────────────

async function fetchItunesLookup(appleId, country) {
  const url = `https://itunes.apple.com/lookup?id=${appleId}&country=${country}&lang=en_us&entity=software`;

  let data;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) return null;
    data = await response.json();
  } catch {
    return null;
  }

  return data?.results?.[0] ?? null;
}

// ── App Store HTML fetch ──────────────────────────────────────────────────────

async function fetchAppHtml(appleId, country) {
  // Apple redirects the placeholder slug to the real URL automatically
  const url = `https://apps.apple.com/${country}/app/a/id${appleId}`;

  let response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: `geo=${country.toUpperCase()}`,
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
      redirect: "follow",
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;
  return response.text();
}

// ── HTML parsers ─────────────────────────────────────────────────────────────

/**
 * Extract the subtitle from the App Store page HTML.
 * The subtitle lives in an <h2 class="subtitle ..."> element.
 */
function parseSubtitle(html) {
  const m = html.match(/<h2\s[^>]*class="subtitle[^"]*"[^>]*>([^<]+)<\/h2>/);
  return m?.[1]?.trim() ?? null;
}

/**
 * Extract star-rating distribution percentages.
 * Apple renders rows like: aria-label="5 star, 90%"
 * Returns { 5: 90, 4: 4, 3: 2, 2: 0, 1: 3 } or null if not found.
 */
function parseStarDistribution(html) {
  const dist = {};
  const re = /aria-label="(\d) star,\s*([\d.]+)%"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    dist[parseInt(m[1], 10)] = parseFloat(m[2]);
  }
  return Object.keys(dist).length === 5 ? dist : null;
}

/**
 * Extract in-app purchase items from the information section.
 * Returns an array of { name, price } objects, or null if the section is absent.
 */
function parseInAppPurchases(html) {
  // Grab everything between the "In-App Purchases" dt and its closing </details>
  const sectionMatch = html.match(
    /<dt[^>]*>\s*In-App Purchases\s*<\/dt>([\s\S]*?)<\/details>/
  );
  if (!sectionMatch) return null;

  const section = sectionMatch[1];
  const items = [];
  const pairRe = /<span>([^<]+)<\/span>\s*<span>([^<]+)<\/span>/g;
  let p;
  while ((p = pairRe.exec(section)) !== null) {
    items.push({ name: p[1].trim(), price: p[2].trim() });
  }
  return items.length > 0 ? items : null;
}

/**
 * Extract the copyright string from the information section.
 */
function parseCopyright(html) {
  const sectionMatch = html.match(
    /<dt[^>]*>\s*Copyright\s*<\/dt>([\s\S]*?)(?=<dt|<\/ul>)/
  );
  if (!sectionMatch) return null;

  // Text lives between <!-- HTML_TAG_START --> and <!-- HTML_TAG_END -->
  const textMatch = sectionMatch[1].match(
    /<!--\s*HTML_TAG_START\s*-->([\s\S]*?)<!--\s*HTML_TAG_END\s*-->/
  );
  return textMatch?.[1]?.trim() ?? null;
}

/**
 * Extract developer website and privacy policy URLs from the links section.
 */
function parseExternalLinks(html) {
  const devWebsite =
    html.match(/href="([^"]+)"[^>]*>\s*Developer Website/)?.[1] ?? null;
  const privacyPolicy =
    html.match(/href="([^"]+)"[^>]*>\s*Privacy Policy/)?.[1] ?? null;
  return { developerWebsite: devWebsite, privacyPolicyUrl: privacyPolicy };
}

/**
 * Parse all supplementary fields from the App Store HTML page.
 */
function parseHtmlData(html) {
  return {
    subtitle: parseSubtitle(html),
    starDistribution: parseStarDistribution(html),
    inAppPurchases: parseInAppPurchases(html),
    copyright: parseCopyright(html),
    ...parseExternalLinks(html),
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Analyze a single app by Apple ID, combining iTunes Lookup API data and
 * App Store HTML scraping.
 *
 * @param {string|number} appleId
 * @param {string}        [country="us"]
 * @returns {Promise<object|null>}  null when the app is not found
 */
export async function analyzeApp(appleId, country = "us") {
  // Fire both requests concurrently
  const [lookup, html] = await Promise.all([
    fetchItunesLookup(appleId, country),
    fetchAppHtml(appleId, country),
  ]);

  if (!lookup) return null;

  const htmlData = html ? parseHtmlData(html) : {};

  // ── File size ──────────────────────────────────────────────────────────────
  const fileSizeBytes = lookup.fileSizeBytes
    ? parseInt(lookup.fileSizeBytes, 10)
    : null;
  const fileSizeMb = fileSizeBytes
    ? parseFloat((fileSizeBytes / (1024 * 1024)).toFixed(1))
    : null;

  // ── Rating breakdown (percentage + approximate count per star) ─────────────
  const ratingCount = lookup.userRatingCount ?? null;
  let ratingBreakdown = null;
  if (htmlData.starDistribution && ratingCount) {
    ratingBreakdown = {};
    for (const [stars, pct] of Object.entries(htmlData.starDistribution)) {
      ratingBreakdown[stars] = {
        percentage: pct,
        approximateCount: Math.round((ratingCount * pct) / 100),
      };
    }
  }

  return {
    // ── Identity ──────────────────────────────────────────────────────────
    appleId: String(lookup.trackId),
    bundleId: lookup.bundleId ?? null,
    appStoreUrl: lookup.trackViewUrl ?? null,

    // ── Presentation ──────────────────────────────────────────────────────
    name: lookup.trackName ?? null,
    subtitle: htmlData.subtitle ?? null,
    description: lookup.description ?? null,
    iconUrl: lookup.artworkUrl512 ?? lookup.artworkUrl100 ?? null,
    screenshots: lookup.screenshotUrls ?? [],
    ipadScreenshots: lookup.ipadScreenshotUrls ?? [],

    // ── Developer ─────────────────────────────────────────────────────────
    developer: lookup.artistName ?? null,
    developerDisplayName: lookup.sellerName ?? lookup.artistName ?? null,
    developerUrl: lookup.artistViewUrl ?? null,
    developerWebsite: htmlData.developerWebsite ?? null,
    privacyPolicyUrl: htmlData.privacyPolicyUrl ?? null,
    copyright: htmlData.copyright ?? null,

    // ── Category ──────────────────────────────────────────────────────────
    category: lookup.primaryGenreName ?? null,
    categories: lookup.genres ?? [],

    // ── Pricing ───────────────────────────────────────────────────────────
    price: lookup.price ?? null,
    priceFormatted: lookup.formattedPrice ?? null,
    isFree: lookup.price === 0,
    inAppPurchases: htmlData.inAppPurchases ?? null,

    // ── Compatibility ─────────────────────────────────────────────────────
    minimumOsVersion: lookup.minimumOsVersion ?? null,
    supportedDevices: lookup.supportedDevices ?? [],

    // ── Localisation ──────────────────────────────────────────────────────
    languageCodes: lookup.languageCodesISO2A ?? [],

    // ── Size ──────────────────────────────────────────────────────────────
    fileSizeBytes,
    fileSizeMb,

    // ── Content ───────────────────────────────────────────────────────────
    ageRating: lookup.contentAdvisoryRating ?? null,

    // ── Version / Release ─────────────────────────────────────────────────
    version: lookup.version ?? null,
    releaseDate: lookup.releaseDate ?? null,
    currentVersionReleaseDate: lookup.currentVersionReleaseDate ?? null,
    whatsNew: lookup.releaseNotes ?? null,

    // ── Ratings ───────────────────────────────────────────────────────────
    rating: lookup.averageUserRating ?? null,
    ratingCount,
    ratingCurrentVersion: lookup.averageUserRatingForCurrentVersion ?? null,
    ratingCountCurrentVersion: lookup.userRatingCountForCurrentVersion ?? null,
    ratingBreakdown,
  };
}

// ── Multi-store ratings ───────────────────────────────────────────────────────

/**
 * Curated list of major storefronts used as the default when `stores=major`.
 * Covers the highest-volume App Store markets.
 */
export const MAJOR_STOREFRONTS = [
  "us", "gb", "ca", "au", "de", "fr", "jp", "kr", "cn", "hk", "tw",
  "sg", "in", "br", "mx", "es", "it", "nl", "se", "no", "dk", "fi",
  "pl", "ru", "tr", "sa", "ae", "il", "za", "ng", "eg", "ar", "co",
  "cl", "th", "id", "ph", "my", "vn", "nz", "ie", "pt", "be", "ch",
  "at", "cz", "ro", "hu", "ua", "pk",
];

/**
 * Fetch full app data for a single storefront by combining iTunes Lookup
 * (structured metadata, ratings) with App Store HTML scraping (star
 * distribution breakdown, subtitle, in-app purchases, copyright, links).
 *
 * @param {string} appleId
 * @param {string} country  ISO 3166-1 alpha-2 code
 * @returns {Promise<object>}
 */
async function fetchOneStoreData(appleId, country) {
  let httpStatus = null;

  try {
    const [lookup, html] = await Promise.all([
      fetchItunesLookup(appleId, country),
      fetchAppHtml(appleId, country),
    ]);

    // Determine HTTP status: null lookup means the API returned non-200 or empty
    if (!lookup) {
      // Best-effort: try a HEAD request to get the actual status code
      try {
        const probe = await fetch(
          `https://itunes.apple.com/lookup?id=${appleId}&country=${country}&entity=software`,
          { method: "HEAD", headers: { "User-Agent": USER_AGENT } }
        );
        httpStatus = probe.status;
      } catch {
        httpStatus = null;
      }
      return { country, available: false, httpStatus };
    }

    httpStatus = 200;
    const htmlData = html ? parseHtmlData(html) : {};

    const fileSizeBytes = lookup.fileSizeBytes
      ? parseInt(lookup.fileSizeBytes, 10)
      : null;

    const ratingCount = lookup.userRatingCount ?? null;
    let ratingBreakdown = null;
    if (htmlData.starDistribution && ratingCount) {
      ratingBreakdown = {};
      for (const [stars, pct] of Object.entries(htmlData.starDistribution)) {
        ratingBreakdown[stars] = {
          percentage: pct,
          approximateCount: Math.round((ratingCount * pct) / 100),
        };
      }
    }

    return {
      country,
      available: true,
      httpStatus,

      name: lookup.trackName ?? null,
      subtitle: htmlData.subtitle ?? null,
      description: lookup.description ?? null,
      iconUrl: lookup.artworkUrl512 ?? lookup.artworkUrl100 ?? null,
      appStoreUrl: lookup.trackViewUrl ?? null,

      developer: lookup.artistName ?? null,
      developerWebsite: htmlData.developerWebsite ?? null,
      privacyPolicyUrl: htmlData.privacyPolicyUrl ?? null,
      copyright: htmlData.copyright ?? null,

      category: lookup.primaryGenreName ?? null,
      categories: lookup.genres ?? [],

      price: lookup.price ?? null,
      priceFormatted: lookup.formattedPrice ?? null,
      currency: lookup.currency ?? null,
      inAppPurchases: htmlData.inAppPurchases ?? null,

      rating: lookup.averageUserRating ?? null,
      ratingCount,
      ratingCurrentVersion: lookup.averageUserRatingForCurrentVersion ?? null,
      ratingCountCurrentVersion: lookup.userRatingCountForCurrentVersion ?? null,
      ratingBreakdown,

      version: lookup.version ?? null,
      releaseDate: lookup.releaseDate ?? null,
      currentVersionReleaseDate: lookup.currentVersionReleaseDate ?? null,
      whatsNew: lookup.releaseNotes ?? null,

      languageCodes: lookup.languageCodesISO2A ?? [],
      minimumOsVersion: lookup.minimumOsVersion ?? null,
      fileSizeBytes,
      fileSizeMb: fileSizeBytes
        ? parseFloat((fileSizeBytes / (1024 * 1024)).toFixed(1))
        : null,
      ageRating: lookup.contentAdvisoryRating ?? null,
    };
  } catch {
    return { country, available: false, httpStatus, error: true };
  }
}

/**
 * Fetch full app data for a list of storefronts in parallel.
 * Returns a map keyed by country code plus a `statusSummary` showing how many
 * stores returned each HTTP status code (200, 404, 429, …).
 *
 * @param {string}   appleId
 * @param {string[]} countries  ISO 3166-1 alpha-2 codes
 * @param {number}   [concurrency=20]
 * @returns {Promise<{stores: Record<string, object>, statusSummary: Record<string, number>}>}
 */
export async function fetchMultiStoreRatings(
  appleId,
  countries,
  concurrency = 20
) {
  const tasks = countries.map(
    (country) => () => fetchOneStoreData(appleId, country)
  );

  const results = await runWithConcurrency(tasks, concurrency);

  const stores = {};
  const statusSummary = {};

  for (const r of results) {
    stores[r.country] = r;
    const key = r.error && r.httpStatus === null ? "error" : String(r.httpStatus ?? "error");
    statusSummary[key] = (statusSummary[key] ?? 0) + 1;
  }

  // Sort status keys numerically then alphabetically
  const sortedStatusSummary = Object.fromEntries(
    Object.entries(statusSummary).sort(([a], [b]) => {
      const na = Number(a), nb = Number(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      if (!isNaN(na)) return -1;
      if (!isNaN(nb)) return 1;
      return a.localeCompare(b);
    })
  );

  return { stores, statusSummary: sortedStatusSummary };
}

// ── Storefront availability ───────────────────────────────────────────────────

const STOREFRONT_TIMEOUT_MS = 8000;

/**
 * Simple concurrency limiter.
 * Runs `tasks` (zero-arg async functions) with at most `limit` in-flight at once.
 *
 * @param {Array<() => Promise<any>>} tasks
 * @param {number} limit
 * @returns {Promise<any[]>}
 */
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;

  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker)
  );
  return results;
}

/**
 * Check a single storefront by fetching the App Store page and recording
 * the HTTP status code. The response body is immediately cancelled so we
 * never download the full HTML.
 *
 * @param {string} appleId
 * @param {string} country  ISO 3166-1 alpha-2 code
 * @returns {Promise<{country: string, status: number|string}>}
 */
async function checkStorefront(appleId, country) {
  const url = `https://apps.apple.com/${country}/app/a/id${appleId}`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    STOREFRONT_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: `geo=${country.toUpperCase()}`,
      },
      redirect: "follow",
      signal: controller.signal,
    });

    // Release the TCP connection without reading the body
    await response.body?.cancel();

    return { country, status: response.status };
  } catch (err) {
    if (err.name === "AbortError") {
      return { country, status: "timeout" };
    }
    return { country, status: "error", error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check app availability across every known Apple App Store storefront.
 *
 * @param {string|number} appleId
 * @param {object}        [opts]
 * @param {number}        [opts.concurrency=30]  Max parallel requests
 * @returns {Promise<object>}
 */
export async function checkStorefrontAvailability(
  appleId,
  { concurrency = 30 } = {}
) {
  const startedAt = Date.now();

  const tasks = APPLE_STOREFRONTS.map(
    (country) => () => checkStorefront(appleId, country)
  );

  const results = await runWithConcurrency(tasks, concurrency);

  // ── Aggregate ──────────────────────────────────────────────────────────────
  const summary = {};   // { "200": 120, "404": 30, "timeout": 2, ... }
  const byStatus = {};  // { "200": ["us","gb",...], "404": [...], ... }

  for (const { country, status } of results) {
    const key = String(status);
    summary[key] = (summary[key] ?? 0) + 1;
    (byStatus[key] ??= []).push(country);
  }

  // Sort status keys numerically (200 before 404 before "error")
  const sortedSummary = Object.fromEntries(
    Object.entries(summary).sort(([a], [b]) => {
      const na = Number(a);
      const nb = Number(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      if (!isNaN(na)) return -1;
      if (!isNaN(nb)) return 1;
      return a.localeCompare(b);
    })
  );

  return {
    appleId: String(appleId),
    totalStorefronts: APPLE_STOREFRONTS.length,
    durationMs: Date.now() - startedAt,
    summary: sortedSummary,
    byStatus,
    checkedAt: new Date().toISOString(),
  };
}
