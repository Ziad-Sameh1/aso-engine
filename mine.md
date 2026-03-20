# Mine V2

`POST /api/apps/:appleId/mine/v2`

Simplified competitor discovery — no iterative rounds, single-pass.

---

## Workflow

### ✅ Phase 1 — Create endpoint
Accept `stores` (array of 2-letter country codes, default `["us"]`).
Route: `POST /api/apps/:appleId/mine/v2` added to `src/routes/mining.js`.

### ✅ Phase 2 — Metadata (parallel)
Scrape app page metadata for each store in parallel via `scrapeAppPageMetadata`.
Returns `name`, `subtitle`, `description` per store. 404 if not found in any store.

### ✅ Phase 3 — Gemini: 25 localized intents per store
Single Gemini call (`gemini-2.5-flash`) using the richest metadata (US or first found).
Generate exactly **25** short search phrases (1–3 words) per store in the **local language** — breadth over depth:
- Arabic stores (`ar`, `sa`, `ae`, `eg`) → Arabic script
- Spanish stores (`es`, `mx`, `cl`, `co`) → Spanish
- Italian (`it`), German (`de`), French (`fr`), etc. → native language

Rules: grounded in actual app features, no brand names, lowercase.
Implemented in `generateLocalizedIntentsV2` (`src/services/miningService.js`).

### ✅ Phase 4 — Search & count competitors

Search all 10 intents per store via proxy (concurrency: 30).
Get top 50 competitors per intent.
Count how many intents each competitor app appeared in.
Resolve name + subtitle for all competitors via `scrapeAppNameSubtitle` via proxy (concurrency: 100).
After first pass, retry any that still have no name (429 failures) — no backoff, proxy handles it.
Filter out the target app. Return competitors sorted by appearance count descending.

### ✅ Phase 5 — Gemini: search terms per competitor (per store, all parallel)
For each store, one Gemini call takes all competitors (name + subtitle) and returns every possible search phrase a user might type to find each app.
Batched in groups of 50, all batches run in parallel within the store call.
Each competitor gets a `searchTerms[]` field. Only competitors with a resolved name are eligible.
Implemented in `generateCompetitorSearchTerms` (`src/services/miningService.js`).

---

## Response shape

```json
{
  "appleId": "123456",
  "stores": [
    {
      "store": "us",
      "found": true,
      "name": "App Name",
      "subtitle": "App Subtitle",
      "intents": ["budget tracker", "expense manager"],
      "competitors": [
        {
          "id": "789",
          "name": "Bill Tracker & Reminders",
          "subtitle": "Track Bills, Due Dates & Pay",
          "count": 8,
          "searchTerms": ["bill tracker", "bill reminder", "bill due date", "track due dates", "payment tracker"]
        }
      ],
      "competitorCount": 42
    }
  ],
  "timings": {
    "metadataMs": 1200,
    "geminiMs": 3000,
    "searchMs": 8000,
    "phase5Ms": 4000,
    "totalMs": 16200
  }
}
```

---

## Code references

| What | File |
|---|---|
| Route (v2 endpoint) | `src/routes/mining.js` |
| `scrapeAppPageMetadata` | `src/services/appstore.js` |
| `fetchSearchHtmlViaProxy` + `extractSearchResults` | `src/services/appstore.js` |
| `scrapeAppNameSubtitle` | `src/services/appstore.js` |
| `generateLocalizedIntentsV2` | `src/services/miningService.js` |
| `generateCompetitorSearchTerms` | `src/services/miningService.js` |
| `createLimiter` | `src/services/miningService.js` |
