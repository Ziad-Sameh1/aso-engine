# POST /api/apps/setup

Sets up an app for ASO tracking by scraping metadata, generating search intents, mining Apple Suggest, building search terms, and then ranking all terms with popularity scores.

## Request

```json
{
  "appleId": "123456789",     // required — Apple App Store ID
  "stores": ["us", "gb"]      // optional — storefront codes, defaults to ["us"]
}
```

## Response

Returns per-store metadata, ranked keywords with popularity scores, and API call counts. Returns `404` if the app is not found in any store.

```json
{
  "appleId": "123456789",
  "callsCount": 1200,
  "searchHtmlCount": 15,
  "suggestionApiCount": 350,
  "totalLiveKeywords": 847,
  "stores": [
    {
      "store": "us",
      "meta": { "name": "...", "subtitle": "...", "description": "..." },
      "tokens": {
        "titleTokens": ["calorie", "tracker"],
        "subtitleTokens": ["food", "nutrition"],
        "descriptionTokens": ["meals", "weight", "diet"]
      },
      "localizedIntents": ["calorie tracker", "calorie counter", "food diary"],
      "intentTopApps": [
        {
          "intent": "calorie tracker",
          "results": [{ "rank": 1, "name": "MyFitnessPal", "subtitle": "..." }]
        }
      ],
      "seedKeywords": [{ "token": "calorie", "frequency": 8 }],
      "liveKeywords": 312,
      "keywords": [
        { "term": "calorie food", "rank": 5, "popularity": 62 },
        { "term": "tracker nutrition", "rank": null, "popularity": 38 },
        { "term": "dead keyword", "rank": null, "popularity": 0 }
      ]
    }
  ]
}
```

## Flow

The endpoint has two major phases: **Setup** (steps 1–8) and **Ranking** (step 9).

---

### Phase 1: Setup

#### 1. Scrape All Stores in Parallel

Calls `scrapeAppPageMetadata(appleId, store)` for each requested store concurrently. Filters out stores where the app was not found. Returns `null` (-> 404) if no stores have the app.

#### 2. Extract Title & Subtitle Tokens (Deterministic)

For each found store, tokenizes the app name and subtitle:
- Lowercases, splits on whitespace/punctuation
- Removes stop words and duplicates
- Result: `titleTokens[]` and `subtitleTokens[]` per store

#### 3. Gemini Call — Description Tokens + Localized Intents (Single Call)

Uses the US store metadata (or first found store) as the English reference. A single Gemini 2.5 Flash call does two things:

- **descriptionTokens**: Extracts the 10 most search-relevant single-word tokens from the description, excluding already-indexed title/subtitle tokens.
- **localizedIntents**: For each requested store code, generates 3-5 short search phrases (1-3 words) that real users in that market would type. Non-English stores get native-language terms. Prioritizes obvious, high-volume terms first.

#### 4. Search Intent Top Apps (Per Store, Serial)

For each store, takes the localized intents from step 3 and runs `searchIntentTopApps()`:
- For each intent, fetches Apple App Store search HTML and extracts the top 10 results (name + subtitle)
- Runs serially per intent to avoid Apple rate limiting
- Retries up to 4 times with exponential backoff (starting at 1.5s) on failure
- Returns empty results after exhausting retries

#### 5. Extract Seed Keywords from Intent Results

`extractSeedKeywords()` tokenizes all app names and subtitles from the intent search results, counts token frequency across all results, and returns tokens sorted by frequency descending. The top 25 seeds are used for mining.

#### 6. Mine Apple Suggest (3 Levels, Gemini-Cleaned)

`mineSuggestions()` performs a 3-level deep mining of Apple's autocomplete API:

| Level | Input | Process |
|-------|-------|---------|
| L1 | Top 25 seed tokens | Fetch Apple Suggest -> Gemini filter/expand |
| L2 | All L1 output terms | Fetch Apple Suggest -> Gemini filter/expand |
| L3 | All L2 output terms | Fetch Apple Suggest -> Gemini filter/expand |

At each level:
- **Fetch**: Parallel Apple Suggest API calls with retry queue for rate-limited keywords (exponential backoff, max 4 retries)
- **Gemini Enrich**: Single Gemini call filters irrelevant terms and expands with sub-phrase permutations. Removes brand names, non-English terms, generic modifiers ("free", "best", "app"), and terms unrelated to the app.

A `globalSeen` set prevents duplicate terms across levels.

#### 7. Build Final Search Terms (Per Store)

Three sources are merged and deduplicated into the final `searchTerms[]` array:

1. **Token permutations**: All 2-token cross-product pairs from title x subtitle x description tokens
2. **Seed permutations**: 2-token pairs from seed keywords that appeared with frequency > 1
3. **Mined terms**: All terms from L1 + L2 + L3 mining, flattened

#### 8. Log Call Counts

Logs and returns counters for the setup phase:
- `callsCount` — total search terms across all stores (= number of ranking fetches about to happen)
- `searchHtmlCount` — Apple search HTML fetches made during intent searches
- `suggestionApiCount` — Apple Suggest API calls made during mining

---

### Phase 2: Ranking (Step 9)

After setup completes, the ranking phase processes stores **one by one** (serial across stores). For each store:

#### 9a. Fetch Search Results (50 concurrent via proxy)

For each search term in the store's `searchTerms[]`, fetches Apple search HTML through the configured HTTPS proxy with **concurrency of 50**.

- Uses `fetchSearchHtmlViaProxy()` with the singleton `HttpsProxyAgent` (connection pool reuse)
- Retries up to 3 times with exponential backoff (2s base) on failure
- Extracts the top-10 result IDs and checks if the target app appears anywhere in the results
- Returns `{ term, rank, top10Ids }` per search term

#### 9b. Batch Resolve Rating Counts

Collects all unique app IDs seen across all top-10 results, then batch-resolves metadata via the iTunes Lookup API (150 IDs per batch, 500ms between batches). This gives us `ratingCount` for each app.

#### 9c. Calculate Popularity Score (0-100)

For each search term, takes the top-10 apps' rating counts and calculates a popularity score:

| Step | What | Why |
|------|------|-----|
| **Zero check** | If 5+ of 10 results have 0 reviews -> score = 0 | Dead keyword, skip it |
| **Trimmed mean** | Drop rank #1 and ranks #9-10, average ranks #2-#8 | Removes super-app outliers and filler |
| **HHI penalty** | Herfindahl index on review share distribution | Penalizes if 1-2 apps monopolize all reviews |
| **Log scale** | `log10(penalizedMean) / log10(50M) * 100` | Compresses 0-50M range to 0-100 |

Score interpretation:
- `0` — dead keyword (mostly zero-review apps)
- `~30` — ~1K average reviews in top 10
- `~60` — ~100K average reviews
- `~80+` — 1M+ average reviews (highly competitive)

#### 9d. Return Per-Term Results

Each keyword in the response contains:
- `term` — the search phrase
- `rank` — the target app's rank (null if not found in results)
- `popularity` — 0-100 score based on top-10 rating counts

---

## Execution Model (3 stores: us, it, de)

```
Phase 1 — Setup
  Step 1: Scrape metadata              PARALLEL (all 3 stores at once)
  Step 2: Tokenize                     SYNC (in-memory)
  Step 3: Gemini intents               SINGLE CALL (covers all 3 stores)
  Step 4: Intent top apps              PARALLEL across stores
       within each store               SERIAL (intent by intent)
  Step 5: Extract seeds                SYNC (in-memory)
  Step 6: Mine Apple Suggest           PARALLEL across stores
       within each store               SERIAL (L1 -> L2 -> L3)
       within each level               PARALLEL (fetches) + SERIAL (retries)
  Step 7: Build search terms           SYNC (in-memory)
  Step 8: Log counts                   SYNC

Phase 2 — Ranking
  Step 9: Rank search terms            SERIAL across stores (one by one)
       9a: Fetch search HTML           50 CONCURRENT via proxy
       9b: Batch iTunes Lookup         SERIAL (150 IDs/batch, 500ms gap)
       9c: Calculate popularity        SYNC (in-memory)
```

## External Dependencies

| Service | Used In | Purpose |
|---------|---------|---------|
| Apple App Store HTML | Steps 1, 4, 9a | Scrape metadata and search results |
| Apple App Store HTML (via proxy) | Step 9a | Concurrent ranking fetches (50 at a time) |
| iTunes Lookup API | Step 9b | Batch resolve rating counts for popularity scoring |
| Apple Suggest API | Step 6 | Autocomplete suggestions for keyword mining |
| Gemini 2.5 Flash | Steps 3, 6 | Intent generation, description tokens, term filtering/expansion |
| Redis | Step 6 | Caching Apple Suggest results |

## Rate Limiting Protections

- **Setup phase**: Intent searches run serially per store with exponential backoff (1.5s base, 4 retries). Apple Suggest fetches run in parallel but rate-limited keywords retry sequentially (2s base, 30s max, 4 retries). Stores are processed in parallel.
- **Ranking phase**: Stores are processed one by one (serial) to avoid overwhelming the proxy. Within each store, search fetches run 50-concurrent through the proxy with retry + exponential backoff (2s base, 3 retries). iTunes Lookup batches at 150 IDs with 500ms gaps.
