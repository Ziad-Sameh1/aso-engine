#!/usr/bin/env python3
"""
App Store Search Rankings Scraper
=================================
Extracts the EXACT search result ordering as shown on iPhone/iPad App Store
by parsing Apple's server-side rendered HTML from apps.apple.com.

HOW IT WORKS:
-------------
Apple's web App Store at apps.apple.com/us/iphone/search?term=X does server-side
rendering (SSR). Their Svelte backend calls the internal API:
  amp-api-search-edge.apps.apple.com/v1/catalog/{storefront}/search
using a server-side token (process.env.MEDIA_API_TOKEN), then embeds the FULL
result set in a <script id="serialized-server-data"> JSON blob in the HTML.

The first ~12 items have full metadata (name, icon, etc.).
The remaining items (up to ~130+) are stored as ordered app IDs in a "nextPage"
structure within the same JSON blob. These are the DEFERRED results that the
native app would lazy-load as you scroll.

The ordering is IDENTICAL to what the iPhone/iPad shows because:
1. Apple's SSR calls the same search API that the native app uses
2. The results include the `impressionIndex` field = exact display position
3. The `nextPage` results maintain the API's original ordering
4. No client-side re-ranking happens — the server returns final order

To get app names/metadata for the deferred IDs, we use the iTunes Lookup API
(itunes.apple.com/lookup?id=X) which is free, unauthenticated, and supports
batching up to ~200 IDs per request.

AUTHENTICATION:
- First call (HTML page): NO auth needed. Just a browser User-Agent.
- iTunes Lookup (metadata): NO auth needed.
- The client-side JWT (embedded in the JS bundle) is NOT needed for this approach.

LIMITATIONS:
- Apple may rate-limit aggressive scraping. Use reasonable delays.
- The geo cookie affects which storefront you get results for.
- Results can vary by: storefront, device platform, user personalization (minimal
  for incognito/unauthenticated).

USAGE:
    python3 appstore_search_rankings.py "facebook" --country us --top 50
    python3 appstore_search_rankings.py "vpn" --country eg --top 30 --platform ipad
"""

import argparse
import json
import re
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
from typing import Optional


# ── Configuration ────────────────────────────────────────────────────────────

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/144.0.0.0 Safari/537.36"
)

LOOKUP_BATCH_SIZE = 150  # iTunes Lookup supports ~200 IDs; we use 150 to be safe


# ── Step 1: Fetch Apple's SSR HTML ──────────────────────────────────────────

def fetch_search_html(term: str, country: str = "us", platform: str = "iphone") -> str:
    """
    Fetch the server-side rendered search results page from apps.apple.com.
    This page contains ALL search results embedded in a JSON script tag.
    """
    url = f"https://apps.apple.com/{country}/{platform}/search?term={urllib.parse.quote(term)}"

    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cookie": f"geo={country.upper()}",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
    })

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        print(f"ERROR: HTTP {e.code} fetching search page", file=sys.stderr)
        print(f"  URL: {url}", file=sys.stderr)
        sys.exit(1)


# ── Step 2: Extract ordered app IDs from the embedded JSON ─────────────────

def extract_search_results(html: str) -> list[dict]:
    """
    Parse the serialized-server-data JSON from Apple's HTML to extract
    the complete ordered list of search results.

    Returns a list of dicts:
      [{"rank": 1, "id": "284882215", "name": "Facebook", "bundle_id": "com.facebook.Facebook"}, ...]

    Items beyond the first ~12 will only have "id" (no name/bundle_id yet).
    """
    # Extract the JSON blob from the script tag
    pattern = r'<script\s+type="application/json"\s+id="serialized-server-data">\s*(\{.*?\})\s*</script>'
    match = re.search(pattern, html, re.DOTALL)
    if not match:
        print("ERROR: Could not find serialized-server-data in HTML.", file=sys.stderr)
        print("Apple may have changed their page structure.", file=sys.stderr)
        sys.exit(1)

    try:
        data = json.loads(match.group(1))
    except json.JSONDecodeError as e:
        print(f"ERROR: Failed to parse JSON: {e}", file=sys.stderr)
        sys.exit(1)

    results = []

    # Navigate to the search results shelf
    try:
        page_data = data["data"][0]["data"]
    except (KeyError, IndexError):
        print("ERROR: Unexpected JSON structure in serialized-server-data.", file=sys.stderr)
        sys.exit(1)

    # ── First page: fully rendered items with metadata ──
    shelves = page_data.get("shelves", [])
    for shelf in shelves:
        if shelf.get("contentType") != "searchResult":
            continue
        for item in shelf.get("items", []):
            lockup = item.get("lockup", {})
            if not lockup:
                continue
            fields = lockup.get("impressionMetrics", {}).get("fields", {})
            raw_id = fields.get("id", "")
            app_id = raw_id.split("::")[0] if "::" in raw_id else raw_id
            results.append({
                "rank": len(results) + 1,
                "id": app_id,
                "name": fields.get("name", ""),
                "bundle_id": fields.get("bundleId", ""),
                "impression_index": fields.get("impressionIndex"),
            })

    # ── Deferred results: just ordered IDs (the "nextPage") ──
    next_page = page_data.get("nextPage", {})
    if isinstance(next_page, dict):
        deferred = next_page.get("results", [])
        for item in deferred:
            if item.get("type") == "apps":
                results.append({
                    "rank": len(results) + 1,
                    "id": item["id"],
                    "name": "",
                    "bundle_id": "",
                    "impression_index": None,
                })

    return results


# ── Step 3: Resolve app names via iTunes Lookup API ─────────────────────────

def lookup_app_metadata(app_ids: list[str], country: str = "us") -> dict:
    """
    Use the iTunes Lookup API to get app names and bundle IDs for a list of IDs.
    Batches requests to stay within API limits.

    Returns: {app_id: {"name": ..., "bundle_id": ..., "developer": ...}, ...}
    """
    metadata = {}

    for i in range(0, len(app_ids), LOOKUP_BATCH_SIZE):
        batch = app_ids[i:i + LOOKUP_BATCH_SIZE]
        ids_param = ",".join(batch)
        url = f"https://itunes.apple.com/lookup?id={ids_param}&country={country}"

        req = urllib.request.Request(url, headers={
            "User-Agent": USER_AGENT,
        })

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            print(f"WARNING: iTunes Lookup failed for batch {i}: {e}", file=sys.stderr)
            continue

        for result in data.get("results", []):
            tid = str(result.get("trackId", ""))
            metadata[tid] = {
                "name": result.get("trackName", ""),
                "bundle_id": result.get("bundleId", ""),
                "developer": result.get("artistName", ""),
                "price": result.get("formattedPrice", ""),
                "genre": result.get("primaryGenreName", ""),
                "rating": result.get("averageUserRating"),
                "rating_count": result.get("userRatingCount"),
            }

        # Be nice to Apple's servers
        if i + LOOKUP_BATCH_SIZE < len(app_ids):
            time.sleep(0.5)

    return metadata


# ── Step 4: Merge and output ────────────────────────────────────────────────

def get_rankings(
    term: str,
    country: str = "us",
    platform: str = "iphone",
    top_n: int = 50,
    resolve_names: bool = True,
    output_format: str = "table",
) -> list[dict]:
    """
    Main function: get App Store search rankings for a term.

    Args:
        term: Search query
        country: 2-letter country code (us, eg, gb, etc.)
        platform: "iphone" or "ipad"
        top_n: How many results to return (max ~130)
        resolve_names: Whether to call iTunes Lookup for deferred items
        output_format: "table", "json", or "csv"

    Returns: List of ranked results
    """
    print(f"Fetching App Store search results for '{term}' ({country}/{platform})...",
          file=sys.stderr)

    # Step 1: Fetch HTML
    html = fetch_search_html(term, country, platform)
    print(f"  HTML fetched ({len(html):,} bytes)", file=sys.stderr)

    # Step 2: Extract ordered results
    results = extract_search_results(html)
    print(f"  Found {len(results)} total results", file=sys.stderr)

    # Trim to requested count
    results = results[:top_n]

    # Step 3: Resolve names for deferred items
    if resolve_names:
        ids_needing_names = [r["id"] for r in results if not r["name"]]
        if ids_needing_names:
            print(f"  Resolving {len(ids_needing_names)} app names via iTunes Lookup...",
                  file=sys.stderr)
            metadata = lookup_app_metadata(ids_needing_names, country)
            for r in results:
                if not r["name"] and r["id"] in metadata:
                    r["name"] = metadata[r["id"]]["name"]
                    r["bundle_id"] = metadata[r["id"]]["bundle_id"]
                    r["developer"] = metadata[r["id"]].get("developer", "")
                    r["genre"] = metadata[r["id"]].get("genre", "")
            print(f"  Resolved {len(metadata)} app names", file=sys.stderr)

    return results


def format_output(results: list[dict], fmt: str = "table") -> str:
    """Format results for display."""
    if fmt == "json":
        clean = []
        for r in results:
            clean.append({
                "rank": r["rank"],
                "app_id": r["id"],
                "name": r.get("name", ""),
                "bundle_id": r.get("bundle_id", ""),
                "developer": r.get("developer", ""),
                "genre": r.get("genre", ""),
            })
        return json.dumps(clean, indent=2, ensure_ascii=False)

    elif fmt == "csv":
        lines = ["rank,app_id,name,bundle_id,developer,genre"]
        for r in results:
            name = r.get("name", "").replace('"', '""')
            dev = r.get("developer", "").replace('"', '""')
            genre = r.get("genre", "").replace('"', '""')
            bundle = r.get("bundle_id", "")
            lines.append(f'{r["rank"]},{r["id"]},"{name}",{bundle},"{dev}","{genre}"')
        return "\n".join(lines)

    else:  # table
        lines = []
        lines.append(f"{'#':>4}  {'App ID':<12}  {'Name':<45}  {'Bundle ID'}")
        lines.append("-" * 110)
        for r in results:
            name = r.get("name", "(unknown)")[:45]
            bundle = r.get("bundle_id", "")
            lines.append(f'{r["rank"]:>4}  {r["id"]:<12}  {name:<45}  {bundle}')
        return "\n".join(lines)


# ── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Get App Store search rankings (same order as iPhone/iPad)"
    )
    parser.add_argument("term", help="Search term (e.g., 'facebook', 'vpn', 'photo editor')")
    parser.add_argument("--country", "-c", default="us", help="Country code (default: us)")
    parser.add_argument("--platform", "-p", default="iphone",
                        choices=["iphone", "ipad"], help="Platform (default: iphone)")
    parser.add_argument("--top", "-n", type=int, default=50,
                        help="Number of results (default: 50, max ~130)")
    parser.add_argument("--format", "-f", default="table",
                        choices=["table", "json", "csv"], help="Output format")
    parser.add_argument("--no-resolve", action="store_true",
                        help="Skip iTunes Lookup (faster, but deferred items won't have names)")

    args = parser.parse_args()

    results = get_rankings(
        term=args.term,
        country=args.country,
        platform=args.platform,
        top_n=args.top,
        resolve_names=not args.no_resolve,
        output_format=args.format,
    )

    print(format_output(results, args.format))


if __name__ == "__main__":
    main()