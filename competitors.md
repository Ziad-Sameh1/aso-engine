# Competitors API

Discover competitor apps for a given Apple ID across multiple storefronts.

## Endpoint

```
POST /api/competitors
```

### Request

| Field | Type | Required | Description |
|---|---|---|---|
| `appleId` | string | yes | Apple app ID (e.g. `"123456789"`) |
| `stores` | string[] | yes | Non-empty array of storefront country codes (e.g. `["us", "gb", "de"]`) |

```json
{
  "appleId": "123456789",
  "stores": ["us", "gb", "de"]
}
```

### Response

Returns per-store results with the target app's metadata, discovered competitors, and detailed timing breakdown.

```json
{
  "appleId": "123456789",
  "stores": ["us", "gb", "de"],
  "competitors": [
    {
      "store": "us",
      "name": "My App",
      "subtitle": "Best App Ever",
      "description": "Full app description...",
      "intentCount": 25,
      "competitorCount": 842,
      "competitors": [
        {
          "appleId": "987654321",
          "name": "Rival App",
          "subtitle": "Smart Budget Tracker",
          "appearedIn": 18,
          "relevanceScore": 92
        },
        {
          "appleId": "555555555",
          "name": "Another App",
          "subtitle": null,
          "appearedIn": 7,
          "relevanceScore": 35
        }
      ],
      "timings": {
        "scrapeMetadata_ms": 1200,
        "geminiIntents_ms": 3400,
        "totalRounds": 2,
        "intentSearch_ms": 11200,
        "uniqueAppIds": 3500,
        "itunesLookup_ms": 8400,
        "relevanceScoring_ms": 10,
        "filteredCount": 920,
        "subtitleScrape_ms": 38000,
        "rounds": [
          { "round": 0, "intents": 25, "intentSearch_ms": 2600, "uniqueAppIds": 3098, "itunesLookup_ms": 7000, "relevanceScoring_ms": 5, "filteredCount": 806, "subtitleScrape_ms": 32000, "newRelevant": 806 },
          { "round": 1, "intents": 50, "intentSearch_ms": 8600, "uniqueAppIds": 402, "itunesLookup_ms": 1400, "relevanceScoring_ms": 5, "filteredCount": 114, "subtitleScrape_ms": 6000, "newRelevant": 114 }
        ],
        "discovery_ms": 58000,
        "total_ms": 62600
      }
    },
    {
      "store": "gb",
      "timings": { "scrapeMetadata_ms": 900 },
      "error": "not_found"
    }
  ]
}
```

## Pipeline

All stores run in parallel. Within each store, a **discovery loop** runs:

### Round 0 (initial)

| Step | What happens | Concurrency |
|---|---|---|
| **1. Scrape metadata** | `scrapeAppPageMetadata` fetches the app's App Store page for the store. | 1 per store |
| **2. Generate intents** | Gemini Flash 2.5 generates 25 localized search intents. | 1 per store |
| **3. Search intents** | Each intent searched on App Store (~200 IDs per search). | 50 concurrent |
| **4. iTunes lookup** | Bulk-resolve all unique IDs via iTunes Lookup API (batches of 200). | All batches parallel |
| **5. Relevance scoring** | Local hybrid scorer: function match (40%) + bigram overlap coefficient (30%) + appearedIn/intentCount (30%). | instant |
| **6. Filter** | Drop competitors with `relevanceScore < 25`. | — |
| **7. Scrape subtitles** | `scrapeAppNameSubtitle` for each filtered competitor. | 50 concurrent |

### Rounds 1..N (bigram expansion)

| Step | What happens |
|---|---|
| **Generate bigrams** | Extract 2-word bigrams from all discovered competitors' names+subtitles (max 50 per round). |
| **Search → Lookup → Score → Filter → Subtitles** | Same as steps 3-7 above, but only for **new** app IDs not seen in previous rounds. |
| **Stop condition** | Loop ends when no new relevant apps are found, or after 3 rounds total. |

### Final

Results from all rounds are merged, deduplicated, and sorted by `relevanceScore` descending, then `appearedIn`.

## Timings

Each store result includes a `timings` object:

| Key | Description |
|---|---|
| `scrapeMetadata_ms` | Time to scrape the target app's App Store page |
| `geminiIntents_ms` | Time for Gemini to generate 25 intents |
| `totalRounds` | Number of discovery rounds executed (1 = initial only) |
| `intentSearch_ms` | Total time searching intents across all rounds |
| `uniqueAppIds` | Total unique app IDs found across all rounds |
| `itunesLookup_ms` | Total iTunes Lookup time across all rounds |
| `relevanceScoring_ms` | Total relevance scoring time across all rounds |
| `filteredCount` | Final number of relevant competitors (all rounds merged) |
| `subtitleScrape_ms` | Total subtitle scrape time across all rounds |
| `rounds` | Per-round breakdown with intents, uniqueAppIds, newRelevant, and individual timings |
| `discovery_ms` | Combined time for all rounds |
| `total_ms` | Wall-clock time for the entire store (from request start) |

## Files

| File | Role |
|---|---|
| `src/routes/competitors.js` | Route definition with Fastify JSON schema validation |
| `src/services/competitorsService.js` | Discovery loop: scrape → Gemini intents → [search → lookup → score → filter → subtitles → bigram expansion] × N rounds |
| `src/server.js` | Route registration |

## Error Handling

- If the app is not found in a store → `{ "store": "xx", "error": "not_found" }`
- If Gemini fails → returns metadata but empty competitors with `"error": "intent_generation_failed"`
- If individual intent searches fail → silently skipped, other intents still contribute
- If iTunes lookup batches fail → competitors returned with `null` name/description
- Relevance scoring runs locally — no external calls, no failure mode

## Phases

- [x] Phase 1: Create the API scaffold
- [x] Phase 2: Scrape per-store app metadata via `scrapeAppPageMetadata`
- [x] Phase 3: Generate 25 localized intents per store with Gemini
- [x] Phase 4: Parallel intent search (50 concurrent) + parallel iTunes Lookup (batches of 200), deduplicate, return per-store competitors
- [x] Phase 5: Local hybrid relevance scoring (function match 40% + bigram overlap coefficient 30% + appearedIn/intentCount 30%) — language-agnostic, 0 API calls, <10ms for 3k apps
- [x] Phase 6: Scrape subtitles for filtered competitors via `scrapeAppNameSubtitle` (concurrency: 50), return title + subtitle instead of description
- [x] Phase 7: Discovery loop — generate bigrams from competitors' names+subtitles (max 50/round), use as new search intents, repeat until no new relevant apps or max 3 rounds