#!/usr/bin/env node
/**
 * Apple App Store Search — Rate Limit Tester
 *
 * Tests the apps.apple.com search endpoint at various concurrency levels
 * and request rates to identify where failures start.
 *
 * Usage:
 *   node scripts/test-apple-rate-limit.mjs
 *   node scripts/test-apple-rate-limit.mjs --concurrency 5,10,20,50 --batch 100
 *   node scripts/test-apple-rate-limit.mjs --delay 0,50,100,200 --concurrency 20
 */

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/144.0.0.0 Safari/537.36";

// ── Args ────────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v];
  })
);

const CONCURRENCY_LEVELS = (args.concurrency || "5,10,20,40,60").split(",").map(Number);
const BATCH_SIZE = Number(args.batch) || 100;
const DELAYS_MS = (args.delay || "0").split(",").map(Number);
const TIMEOUT_MS = Number(args.timeout) || 10000;
const COUNTRY = args.country || "us";
const TWO_WORD_ONLY = String(args.twoWordOnly || "false").toLowerCase() === "true";
const PERMUTATION_PAIRS = String(args.permutationPairs || "false").toLowerCase() === "true";
const ORDER_MODE = String(args.orderMode || "shuffled").toLowerCase();

// Sample search terms — varied enough to avoid CDN dedup
const TERMS = [
  "budget", "tracker", "money", "finance", "wallet", "expense",
  "savings", "bank", "invest", "stock", "crypto", "trading",
  "weather", "fitness", "health", "sleep", "meditation", "yoga",
  "recipe", "cooking", "photo", "camera", "music", "podcast",
  "notes", "calendar", "todo", "reminder", "alarm", "timer",
  "map", "travel", "hotel", "flight", "ride", "taxi",
  "game", "puzzle", "trivia", "chess", "sudoku", "word",
  "chat", "messenger", "social", "video", "stream", "news",
  "email", "vpn", "password", "scanner", "calculator", "translate",
  "ai assistant", "money tracker", "budget planner", "fitness app",
  "photo editor", "video player", "music player", "weather app",
  "travel planner", "food delivery", "online shopping", "language learn",
  "file manager", "screen recorder", "qr code", "pdf reader",
  "task manager", "habit tracker", "step counter", "calorie counter",
  "alarm clock", "white noise", "flash light", "unit converter",
  "color picker", "font viewer", "code editor", "ssh client",
  "ftp client", "dns lookup", "speed test", "wifi analyzer",
  "battery saver", "memory cleaner", "ad blocker", "dark mode",
  "night shift", "blue light", "eye care", "screen time",
  "parental control", "kid safe", "baby monitor", "pet tracker",
  "plant care", "garden planner", "home design", "room planner",
  "car finder", "gas price", "oil change", "tire pressure",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function pickTerms(n) {
  if (PERMUTATION_PAIRS) {
    const words = [...new Set(
      TERMS.flatMap((term) => term.toLowerCase().trim().split(/\s+/))
        .filter((w) => w && w.length > 1)
    )];

    const pairs = [];
    const byFirstWord = new Map();
    for (let i = 0; i < words.length; i++) {
      for (let j = 0; j < words.length; j++) {
        if (i === j) continue;
        const pair = `${words[i]} ${words[j]}`;
        pairs.push(pair);
        const list = byFirstWord.get(words[i]) ?? [];
        list.push(pair);
        byFirstWord.set(words[i], list);
      }
    }

    // "grouped": keep deterministic grouped-by-first-word order
    // "shuffled": global random order
    // "interleave": round-robin first words to reduce clustered bursts
    if (ORDER_MODE === "shuffled") {
      for (let i = pairs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
      }
    } else if (ORDER_MODE === "interleave") {
      const buckets = [...byFirstWord.values()].map((arr) => [...arr]);
      const roundRobin = [];
      while (buckets.some((b) => b.length > 0)) {
        for (const bucket of buckets) {
          if (bucket.length > 0) roundRobin.push(bucket.shift());
        }
      }
      pairs.length = 0;
      pairs.push(...roundRobin);
    } else if (ORDER_MODE !== "grouped") {
      throw new Error(
        `Invalid --orderMode="${ORDER_MODE}". Use grouped|shuffled|interleave.`,
      );
    }

    if (!pairs.length) {
      throw new Error("No permutation pairs could be generated.");
    }

    if (n > pairs.length) {
      throw new Error(
        `Requested batch (${n}) exceeds unique permutation capacity (${pairs.length}).`,
      );
    }

    return pairs.slice(0, n);
  }

  const pool = TWO_WORD_ONLY
    ? TERMS.filter((term) => term.trim().split(/\s+/).length === 2)
    : TERMS;

  if (!pool.length) {
    throw new Error("No terms available for current filters.");
  }

  const picked = [];
  for (let i = 0; i < n; i++) {
    picked.push(pool[i % pool.length]);
  }
  return picked;
}

async function fetchOne(term, timeoutMs) {
  const url = `https://apps.apple.com/${COUNTRY}/iphone/search?term=${encodeURIComponent(term)}`;
  const start = Date.now();
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: `geo=${COUNTRY.toUpperCase()}`,
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
      signal,
    });
    const elapsed = Date.now() - start;
    if (!res.ok) {
      return { ok: false, term, status: res.status, elapsed, error: `HTTP ${res.status}` };
    }
    const body = await res.text();
    const hasData = body.includes("serialized-server-data");
    return { ok: true, term, status: res.status, elapsed, hasData, bodyLen: body.length };
  } catch (err) {
    const elapsed = Date.now() - start;
    const msg = err.message || String(err);
    let category = "unknown";
    if (err.name === "TimeoutError" || msg.includes("timed out") || msg.includes("abort")) category = "timeout";
    else if (msg.includes("ECONNRESET") || msg.includes("ENOTFOUND") || msg.includes("fetch failed")) category = "network";
    return { ok: false, term, status: 0, elapsed, error: msg, category };
  }
}

function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  }
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Test runner ──────────────────────────────────────────────────────────────

async function runTest(concurrency, delayMs, batchSize, timeoutMs) {
  const terms = pickTerms(batchSize);
  const limit = createLimiter(concurrency);

  const label = `concurrency=${concurrency}, delay=${delayMs}ms, batch=${batchSize}, timeout=${timeoutMs}ms`;
  console.log(`\n${"─".repeat(70)}`);
  console.log(`TEST: ${label}`);
  console.log(`${"─".repeat(70)}`);

  const start = Date.now();
  let idx = 0;

  const results = await Promise.all(
    terms.map((term) =>
      limit(async () => {
        if (delayMs > 0) {
          // Stagger: each request waits idx * delayMs before firing
          const myIdx = idx++;
          await sleep(myIdx * delayMs / concurrency);
        }
        return fetchOne(term, timeoutMs);
      })
    )
  );

  const wallTime = Date.now() - start;

  // Analyze
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const okWithData = ok.filter((r) => r.hasData);
  const okNoData = ok.filter((r) => !r.hasData);

  const allElapsed = results.map((r) => r.elapsed);
  const okElapsed = ok.map((r) => r.elapsed);

  // Error breakdown
  const errBreakdown = {};
  for (const f of failed) {
    const cat = f.category || `http_${f.status}`;
    errBreakdown[cat] = (errBreakdown[cat] || 0) + 1;
  }

  // Status code breakdown
  const statusBreakdown = {};
  for (const r of results) {
    const key = r.status || "error";
    statusBreakdown[key] = (statusBreakdown[key] || 0) + 1;
  }

  console.log(`\nResults:`);
  console.log(`  Total:       ${results.length}`);
  console.log(`  OK (200):    ${ok.length} (${okWithData.length} with data, ${okNoData.length} empty)`);
  console.log(`  Failed:      ${failed.length} (${((failed.length / results.length) * 100).toFixed(1)}%)`);
  console.log(`  Wall time:   ${(wallTime / 1000).toFixed(1)}s`);
  console.log(`  Throughput:  ${(results.length / (wallTime / 1000)).toFixed(1)} req/s`);

  if (allElapsed.length) {
    console.log(`\nLatency (all):`);
    console.log(`  p50: ${percentile(allElapsed, 50)}ms | p90: ${percentile(allElapsed, 90)}ms | p99: ${percentile(allElapsed, 99)}ms | max: ${Math.max(...allElapsed)}ms`);
  }
  if (okElapsed.length) {
    console.log(`Latency (success):`);
    console.log(`  p50: ${percentile(okElapsed, 50)}ms | p90: ${percentile(okElapsed, 90)}ms | p99: ${percentile(okElapsed, 99)}ms`);
  }

  console.log(`\nStatus codes: ${JSON.stringify(statusBreakdown)}`);
  if (Object.keys(errBreakdown).length) {
    console.log(`Error breakdown: ${JSON.stringify(errBreakdown)}`);
    // Show sample errors
    const seen = new Set();
    for (const f of failed) {
      const cat = f.category || `http_${f.status}`;
      if (!seen.has(cat)) {
        seen.add(cat);
        console.log(`  [${cat}] ${f.error.slice(0, 120)}`);
      }
    }
  }

  // Show which terms failed vs succeeded (term-level analysis)
  const failedTerms = new Set(failed.map((r) => r.term));
  const okTerms = new Set(ok.map((r) => r.term));
  const alwaysFail = [...failedTerms].filter((t) => !okTerms.has(t));
  const alwaysOk = [...okTerms].filter((t) => !failedTerms.has(t));
  const mixed = [...failedTerms].filter((t) => okTerms.has(t));
  console.log(`\nTerm analysis:`);
  console.log(`  Always OK:     ${alwaysOk.length} terms`);
  console.log(`  Always failed: ${alwaysFail.length} terms`);
  console.log(`  Mixed:         ${mixed.length} terms`);
  if (alwaysFail.length > 0 && alwaysFail.length <= 40) {
    console.log(`  Failed terms:  ${alwaysFail.join(", ")}`);
  }

  return {
    concurrency, delayMs, batchSize,
    total: results.length, ok: ok.length, failed: failed.length,
    failRate: ((failed.length / results.length) * 100).toFixed(1),
    wallTime,
    throughput: (results.length / (wallTime / 1000)).toFixed(1),
    p50: percentile(allElapsed, 50),
    p90: percentile(allElapsed, 90),
    errBreakdown,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Apple App Store Search — Rate Limit Test");
  console.log(
    `Config: batch=${BATCH_SIZE}, timeout=${TIMEOUT_MS}ms, country=${COUNTRY}, twoWordOnly=${TWO_WORD_ONLY}, permutationPairs=${PERMUTATION_PAIRS}, orderMode=${ORDER_MODE}`,
  );
  console.log(`Concurrency levels: ${CONCURRENCY_LEVELS.join(", ")}`);
  console.log(`Inter-request delays: ${DELAYS_MS.join(", ")}ms`);

  const summary = [];

  for (const delayMs of DELAYS_MS) {
    for (const concurrency of CONCURRENCY_LEVELS) {
      const result = await runTest(concurrency, delayMs, BATCH_SIZE, TIMEOUT_MS);
      summary.push(result);
      // Brief pause between test runs to avoid polluting results
      await sleep(3000);
    }
  }

  // Final summary table
  console.log(`\n${"═".repeat(70)}`);
  console.log("SUMMARY");
  console.log(`${"═".repeat(70)}`);
  console.log(
    "Concurrency | Delay | OK  | Failed | Fail% | Throughput | p50    | p90    | Errors"
  );
  console.log("-".repeat(95));
  for (const r of summary) {
    const errs = Object.entries(r.errBreakdown).map(([k, v]) => `${k}:${v}`).join(",") || "none";
    console.log(
      `${String(r.concurrency).padStart(11)} | ` +
      `${String(r.delayMs + "ms").padStart(5)} | ` +
      `${String(r.ok).padStart(3)} | ` +
      `${String(r.failed).padStart(6)} | ` +
      `${String(r.failRate + "%").padStart(5)} | ` +
      `${String(r.throughput + "/s").padStart(10)} | ` +
      `${String(r.p50 + "ms").padStart(6)} | ` +
      `${String(r.p90 + "ms").padStart(6)} | ` +
      `${errs}`
    );
  }
}

main().catch(console.error);
