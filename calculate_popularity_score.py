def calculate_popularity_score(keyword, storefront="us"):
    # --- Signal 1: Prefix Depth ---
    total_length = len(keyword)
    first_appearance = find_first_suggestion_appearance(keyword, storefront)
    # first_appearance = {"prefix_length": 5, "position": 4, "source": "7"}
    
    if first_appearance is None:
        return 1  # keyword never appears in suggestions
    
    ratio = first_appearance["prefix_length"] / total_length
    
    # Map ratio to 0-100 using inverse curve
    # Lower ratio = higher score
    prefix_score = max(0, min(100, int((1 - ratio) * 100)))
    
    # --- Signal 2: Position ---
    position = first_appearance["position"]  # 1-indexed
    position_score = max(0, int(100 - (position - 1) * 15))
    
    # --- Signal 3: Source Quality ---
    source = first_appearance["source"]
    if source == "7":
        source_multiplier = 1.0
    elif source == "8":
        source_multiplier = 0.6
    else:  # "9" or unknown
        source_multiplier = 0.3
    
    # --- Signal 4: Apple Search Ads ---
    apple_score = get_apple_popularity(keyword)  # your existing API
    if apple_score > 5:
        apple_bonus = 1 + (apple_score - 5) / 100  # scales 1.0 to ~1.55
    else:
        apple_bonus = 1.0
    
    # --- Combine ---
    raw_score = (
        prefix_score * 0.50 +     # prefix depth is strongest signal
        position_score * 0.30 +    # position matters a lot
        density_score * 0.20       # competitor density
    ) * source_multiplier * apple_bonus
    
    # Normalize to 1-100
    final_score = max(1, min(100, int(raw_score)))
    
    return final_score
```

### The Prefix Crawling Flow

This is the actual implementation you need to query the suggest API:
```
function find_first_suggestion_appearance(keyword, storefront):
    
    Step 1: Generate prefixes to check
    ─────────────────────────────────
    For "bill tracker", generate:
    ["b", "bi", "bil", "bill", "bill ", "bill t", 
     "bill tr", "bill tra", "bill trac", "bill track",
     "bill tracke", "bill tracker"]
    
    Step 2: Query each prefix (with early termination)
    ──────────────────────────────────────────────────
    For each prefix, call:
    GET /v1/catalog/{storefront}/search/suggestions
        ?term={prefix}&kinds=terms&platform=iphone&limit=10
    
    Check if keyword appears in results (exact or starts-with match)
    
    OPTIMIZATION: Use binary search instead of linear
    - Start at prefix length = total_length / 3
    - If found, try shorter prefix
    - If not found, try longer prefix
    - This reduces API calls from N to log(N)
    
    Step 3: Return first appearance metadata
    ────────────────────────────────────────
    Return {
        prefix_length: 5,      // "bill " 
        position: 4,           // 4th suggestion
        source: "7",           // organic suggestion
        total_suggestions: 10  // how many results came back
    }
```

### Rate Limiting & Optimization

Since you'll be hitting the suggest API many times per keyword:

- **Binary search on prefix length** cuts calls from ~12 to ~4 per keyword
- **Cache aggressively** — prefix suggestions don't change rapidly. Cache for 24-48 hours.
- **Batch your keywords** — when an app owner submits keywords, process them all at once during off-peak hours
- **Pre-compute common prefixes** — "a", "ab", "ac"... these results are shared across many keywords