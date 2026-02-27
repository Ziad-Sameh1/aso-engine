#!/usr/bin/env node
/**
 * Apple App Store Search — Sliding Window Analyzer
 *
 * Determines:
 *  1. How many unique (non-CDN-cached) requests Apple allows before 429
 *  2. How fast the window refills after throttling
 *
 * Uses unique/uncommon search terms to bypass CDN caching.
 *
 * Usage:
 *   node scripts/test-apple-sliding-window.mjs
 *   node scripts/test-apple-sliding-window.mjs --maxProbes=300 --refillProbeIntervalSec=5,10,15,30,60
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
  }),
);

const MAX_PROBES = Number(args.maxProbes) || 500;
const TIMEOUT_MS = Number(args.timeout) || 10000;
const COUNTRY = args.country || "us";
const REFILL_PROBE_INTERVALS = (args.refillProbeIntervalSec || "5,10,15,30,60,90,120")
  .split(",")
  .map(Number);
const REFILL_PROBES_PER_INTERVAL = Number(args.refillProbesPerInterval) || 5;

// ── Unique term generation ──────────────────────────────────────────────────

const WORD_POOL_A = [
  "quokka", "zephyr", "fjord", "glyph", "nexus", "prism", "vortex", "axiom",
  "zenith", "cipher", "cobalt", "dusk", "ember", "fable", "grove", "haven",
  "ivory", "jade", "karma", "lumen", "mystic", "nebula", "opal", "pixel",
  "quartz", "relic", "sable", "thorn", "umbra", "valor", "wren", "xeno",
  "yarn", "zinc", "abyss", "bliss", "crest", "drift", "epoch", "flux",
  "gleam", "haze", "iris", "jovial", "knack", "lyric", "marsh", "niche",
  "orbit", "plume", "quest", "ridge", "spark", "tidal", "unity", "vivid",
  "whirl", "xerox", "yoke", "zeal",
];

const WORD_POOL_B = [
  "basalt", "canopy", "delta", "ether", "frost", "grain", "helix", "ignite",
  "jasper", "kelp", "latch", "moat", "nimbus", "oxide", "petal", "quill",
  "ripple", "slate", "tropic", "urge", "velvet", "wander", "xylem", "yield",
  "zigzag", "alpine", "beacon", "clover", "dune", "echo", "fern", "glint",
  "hollow", "inlet", "juniper", "kite", "lantern", "mirth", "nectar", "onyx",
  "parcel", "quarry", "rustic", "summit", "tempest", "uplift", "vessel",
  "willow", "yonder", "zodiac", "breeze", "coral", "drizzle", "ember",
  "flicker", "gorge", "harbor", "isle", "jolt", "kindle",
];

let termIndex = 0;

function nextUniqueTerm() {
  const a = WORD_POOL_A[termIndex % WORD_POOL_A.length];
  const b = WORD_POOL_B[Math.floor(termIndex / WORD_POOL_A.length) % WORD_POOL_B.length];
  const suffix = Math.floor(termIndex / (WORD_POOL_A.length * WORD_POOL_B.length));
  termIndex++;
  return suffix > 0 ? `${a} ${b} ${suffix}` : `${a} ${b}`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

async function probe(term) {
  const url = `https://apps.apple.com/${COUNTRY}/iphone/search?term=${encodeURIComponent(term)}`;
  const start = Date.now();
  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
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
    return { ok: res.ok, status: res.status, elapsed, term };
  } catch (err) {
    const elapsed = Date.now() - start;
    return { ok: false, status: 0, elapsed, term, error: err.message };
  }
}

// ── Phase 1: Find window size ───────────────────────────────────────────────

async function findWindowSize() {
  console.log("\n" + "═".repeat(70));
  console.log("PHASE 1: Finding sliding window size");
  console.log("Sending sequential unique requests until first 429...");
  console.log("═".repeat(70));

  let successCount = 0;
  let firstFailAt = null;
  const latencies = [];
  const startTime = Date.now();

  for (let i = 0; i < MAX_PROBES; i++) {
    const term = nextUniqueTerm();
    const result = await probe(term);
    latencies.push(result.elapsed);

    if (result.ok) {
      successCount++;
      if (i % 25 === 0 || i < 10) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(
          `  [${i + 1}] OK (${result.elapsed}ms) — ${successCount} success so far [${elapsed}s elapsed]`,
        );
      }
    } else {
      firstFailAt = i + 1;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `  [${i + 1}] THROTTLED: HTTP ${result.status} (${result.elapsed}ms) [${elapsed}s elapsed]`,
      );

      // Confirm it's sustained: send 5 more to verify
      let confirmFails = 0;
      for (let c = 0; c < 5; c++) {
        const confirmResult = await probe(nextUniqueTerm());
        if (!confirmResult.ok) confirmFails++;
      }
      console.log(`  Confirmation: ${confirmFails}/5 also failed`);

      if (confirmFails >= 3) {
        console.log(`\n  ✓ Window size: ~${successCount} requests`);
        console.log(`    First 429 after request #${firstFailAt}`);
        console.log(
          `    Wall time to exhaust: ${((Date.now() - startTime) / 1000).toFixed(1)}s`,
        );
        const avgLatency = Math.round(
          latencies.reduce((a, b) => a + b, 0) / latencies.length,
        );
        console.log(`    Avg latency: ${avgLatency}ms`);
        return { windowSize: successCount, wallTime: Date.now() - startTime };
      }

      // False alarm — keep going
      console.log("  ^ Appears to be transient, continuing...");
      successCount++; // count the original as borderline
    }
  }

  console.log(
    `\n  ✓ No sustained throttling in ${MAX_PROBES} requests. Window > ${MAX_PROBES}.`,
  );
  return { windowSize: MAX_PROBES, wallTime: Date.now() - startTime };
}

// ── Phase 2: Measure refill rate ────────────────────────────────────────────

async function measureRefill(windowResult) {
  console.log("\n" + "═".repeat(70));
  console.log("PHASE 2: Measuring refill rate");
  console.log(
    `Will wait various intervals, then probe ${REFILL_PROBES_PER_INTERVAL}x to check recovery.`,
  );
  console.log("═".repeat(70));

  const results = [];

  for (const waitSec of REFILL_PROBE_INTERVALS) {
    console.log(`\n  Waiting ${waitSec}s...`);
    await sleep(waitSec * 1000);

    let ok = 0;
    let fail = 0;
    for (let i = 0; i < REFILL_PROBES_PER_INTERVAL; i++) {
      const result = await probe(nextUniqueTerm());
      if (result.ok) ok++;
      else fail++;
    }

    const status = ok === REFILL_PROBES_PER_INTERVAL
      ? "FULLY OPEN"
      : ok > 0
        ? "PARTIAL"
        : "STILL BLOCKED";

    console.log(
      `  After ${waitSec}s: ${ok}/${REFILL_PROBES_PER_INTERVAL} OK — ${status}`,
    );
    results.push({ waitSec, ok, fail, status });

    // If we found fully open, exhaust again to find how many tokens refilled
    if (ok === REFILL_PROBES_PER_INTERVAL) {
      console.log("  → Window reopened. Counting refilled tokens...");
      let refilled = ok;
      for (let i = 0; i < 200; i++) {
        const r = await probe(nextUniqueTerm());
        if (!r.ok) break;
        refilled++;
      }
      console.log(`  → Refilled tokens: ~${refilled}`);
      results[results.length - 1].refilled = refilled;

      // After re-exhausting, continue probing remaining intervals
    }
  }

  return results;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Apple App Store Search — Sliding Window Analyzer");
  console.log(
    `Config: maxProbes=${MAX_PROBES}, timeout=${TIMEOUT_MS}ms, country=${COUNTRY}`,
  );
  console.log(`Refill probe intervals: ${REFILL_PROBE_INTERVALS.join(", ")}s`);

  const windowResult = await findWindowSize();
  const refillResults = await measureRefill(windowResult);

  // Summary
  console.log("\n" + "═".repeat(70));
  console.log("SUMMARY");
  console.log("═".repeat(70));
  console.log(`Window size: ~${windowResult.windowSize} unique requests`);
  console.log(
    `Exhaustion wall time: ${(windowResult.wallTime / 1000).toFixed(1)}s`,
  );
  console.log("\nRefill behavior:");
  console.log(
    "  Wait (s) | OK | Fail | Status        | Refilled",
  );
  console.log("  " + "-".repeat(55));
  for (const r of refillResults) {
    console.log(
      `  ${String(r.waitSec).padStart(7)}s | ${String(r.ok).padStart(2)} | ${String(r.fail).padStart(4)} | ${r.status.padEnd(13)} | ${r.refilled != null ? `~${r.refilled}` : "-"}`,
    );
  }
}

main().catch(console.error);
