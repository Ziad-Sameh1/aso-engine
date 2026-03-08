/**
 * Cold Email Pipeline Orchestrator
 *
 * Given an App Store URL:
 * 1. Discover keywords the app ranks for (Gemini + Apple scraping)
 * 2. Call ShipLift to pre-register the app + seed tracked keywords
 * 3. Track the discovered keywords in ASO Engine
 * 4. Store the lead in cold_email_leads for later email dispatch
 */

import { config } from "../config/index.js";
import { parseAppleIdFromUrl } from "./appstore.js";
import { discoverKeywords } from "./discoveryService.js";
import {
  getColdEmailLeadByAppleId,
  insertColdEmailLead,
  upsertStorefront,
  upsertWord,
  upsertKeyword,
  setKeywordTracking,
} from "./db.js";

/**
 * Prepare a cold email lead for the given App Store URL.
 *
 * @param {object} pg        - fastify.pg pool
 * @param {object} redis     - fastify.redis client
 * @param {string} storeUrl  - full App Store URL
 * @param {object} [opts]
 * @param {string} [opts.store="us"]
 * @param {string} [opts.utmSource]
 * @param {string} [opts.utmCampaign]
 * @returns {Promise<object>} { lead, discovery }
 */
export async function prepareColdEmailLead(
  pg,
  redis,
  storeUrl,
  { store = "us", utmSource, utmCampaign } = {},
) {
  // 1. Parse Apple ID from URL
  const appleId = parseAppleIdFromUrl(storeUrl);
  if (!appleId) {
    throw new Error(`Could not parse Apple ID from URL: ${storeUrl}`);
  }

  // 2. Check for existing non-expired lead
  const existing = await getColdEmailLeadByAppleId(pg, appleId);
  if (existing && existing.status !== "expired") {
    return { lead: existing, discovery: null, cached: true };
  }

  // 3. Run keyword discovery
  const discovery = await discoverKeywords(pg, redis, appleId, {
    store,
    platform: "iphone",
  });

  // 4. Pick top N keywords that the app ranks for
  const maxKeywords = config.coldEmailMaxKeywords;
  const rankedKeywords = discovery.results
    .filter((r) => r.rank != null)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, maxKeywords)
    .map((r) => r.keyword);

  // 5. Call ShipLift claim generate endpoint
  if (!config.shipliftApiUrl) {
    throw new Error("SHIPLIFT_API_URL is not configured.");
  }
  if (!config.shipliftClaimApiKey) {
    throw new Error("SHIPLIFT_CLAIM_API_KEY is not configured.");
  }

  const claimResponse = await fetch(
    `${config.shipliftApiUrl}/api/claim/generate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.shipliftClaimApiKey,
      },
      body: JSON.stringify({
        storeUrl,
        keywords: rankedKeywords,
        storefrontCode: store,
        utmSource,
        utmCampaign,
      }),
    },
  );

  if (!claimResponse.ok) {
    const text = await claimResponse.text().catch(() => "");
    throw new Error(
      `ShipLift claim/generate failed (${claimResponse.status}): ${text}`,
    );
  }

  const claimData = await claimResponse.json();

  // 6. Track discovered keywords in ASO Engine
  const storefront = await upsertStorefront(pg, store);
  for (const kwText of rankedKeywords) {
    try {
      const word = await upsertWord(pg, kwText);
      const kw = await upsertKeyword(pg, word.id, storefront.id, "iphone");
      await setKeywordTracking(pg, kw.id, true);
    } catch {
      // Non-fatal — continue tracking remaining keywords
    }
  }

  // 7. Store the lead
  const lead = await insertColdEmailLead(pg, {
    appleId,
    storeUrl,
    appName: claimData.app?.name ?? discovery.app?.name ?? null,
    category: claimData.app?.category ?? discovery.app?.genre ?? null,
    iconUrl: claimData.app?.iconUrl ?? null,
    sellerEmail: claimData.app?.sellerEmail ?? null,
    claimUrl: claimData.claimUrl,
    claimToken: claimData.token,
    claimExpiresAt: claimData.expiresAt,
    shipliftAppId: claimData.appId,
    keywordsDiscovered: discovery.results,
    utmSource: utmSource ?? null,
    utmCampaign: utmCampaign ?? null,
  });

  return { lead, discovery, cached: false };
}
