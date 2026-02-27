#!/usr/bin/env node
/**
 * Apple App Store Search — Chunked Execution Test
 *
 * Uses sliding window findings to process large batches of unique
 * permutation-style 2-word pairs without hitting 429s.
 *
 * Strategy:
 *  - Send requests in chunks, cooldown between chunks
 *  - Mid-chunk: if 429 ratio spikes, pause early (adaptive halt)
 *  - Failed 429 terms are collected and retried in later retry rounds
 *    with exponential cooldown between rounds
 *
 * Usage:
 *   node scripts/test-apple-chunked.mjs
 *   node scripts/test-apple-chunked.mjs --total=600 --chunkSize=60 --cooldown=20 --maxRetryRounds=3
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

const TOTAL = Number(args.total) || 600;
const CHUNK_SIZE = Number(args.chunkSize) || 60;
const COOLDOWN_SEC = Number(args.cooldown) || 20;
const CONCURRENCY = Number(args.concurrency) || 1;
const TIMEOUT_MS = Number(args.timeout) || 10000;
const COUNTRY = args.country || "us";
const MAX_RETRY_ROUNDS = Number(args.maxRetryRounds) || 3;
const RETRY_COOLDOWN_BASE_SEC = Number(args.retryCooldownBase) || 20;
const HALT_THRESHOLD = Number(args.haltThreshold) || 0.4;
const HALT_WINDOW = Number(args.haltWindow) || 10;
const HALT_COOLDOWN_SEC = Number(args.haltCooldown) || 15;

// ── Term pool ───────────────────────────────────────────────────────────────

const BASE_TERMS = [
  "budget", "tracker", "money", "finance", "wallet", "expense",
  "savings", "bank", "invest", "stock", "crypto", "trading",
  "weather", "fitness", "health", "sleep", "meditation", "yoga",
  "recipe", "cooking", "photo", "camera", "music", "podcast",
  "notes", "calendar", "todo", "reminder", "alarm", "timer",
  "map", "travel", "hotel", "flight", "ride", "taxi",
  "game", "puzzle", "trivia", "chess", "sudoku", "word",
  "chat", "messenger", "social", "video", "stream", "news",
  "email", "vpn", "password", "scanner", "calculator", "translate",
];

function generatePermutationPairs(count) {
  const words = [...new Set(
    BASE_TERMS.flatMap((t) => t.toLowerCase().trim().split(/\s+/))
      .filter((w) => w && w.length > 1),
  )];

  const pairs = [];
  for (let i = 0; i < words.length; i++) {
    for (let j = 0; j < words.length; j++) {
      if (i === j) continue;
      pairs.push(`${words[i]} ${words[j]}`);
    }
  }

  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }

  if (count > pairs.length) {
    throw new Error(
      `Requested ${count} pairs but only ${pairs.length} unique permutations available.`,
    );
  }

  return pairs.slice(0, count);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

async function fetchOne(term) {
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
    if (!res.ok) {
      return { ok: false, term, status: res.status, elapsed };
    }
    await res.text();
    return { ok: true, term, status: 200, elapsed };
  } catch (err) {
    const elapsed = Date.now() - start;
    return { ok: false, term, status: 0, elapsed, error: err.message };
  }
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Process a chunk with adaptive mid-chunk halt ────────────────────────────

async function processChunk(terms, globalStart) {
  const results = [];
  const failed429Terms = [];
  const recentWindow = [];
  let halted = false;

  for (let i = 0; i < terms.length; i++) {
    const result = await fetchOne(terms[i]);
    results.push(result);

    recentWindow.push(result.status === 429 ? 1 : 0);
    if (recentWindow.length > HALT_WINDOW) recentWindow.shift();

    if (result.status === 429) {
      failed429Terms.push(terms[i]);

      if (recentWindow.length >= HALT_WINDOW) {
        const ratio429 = recentWindow.reduce((a, b) => a + b, 0) / recentWindow.length;
        if (ratio429 >= HALT_THRESHOLD) {
          const elapsed = ((Date.now() - globalStart) / 1000).toFixed(0);
          console.log(
            `    ⚠ Mid-chunk halt: ${(ratio429 * 100).toFixed(0)}% 429 in last ${HALT_WINDOW} requests [${elapsed}s]`,
          );
          process.stdout.write(`    ⏳ Cooling ${HALT_COOLDOWN_SEC}s...`);
          await sleep(HALT_COOLDOWN_SEC * 1000);
          console.log(" resuming");
          recentWindow.length = 0;
          halted = true;
        }
      }
    }
  }

  const ok = results.filter((r) => r.ok).length;
  const r429 = results.filter((r) => r.status === 429).length;
  const other = results.length - ok - r429;
  const latencies = results.filter((r) => r.ok).map((r) => r.elapsed);

  return { ok, r429, other, total: results.length, latencies, failed429Terms, halted };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const totalChunks = Math.ceil(TOTAL / CHUNK_SIZE);

  console.log("Apple App Store Search — Chunked Execution Test (with retry)");
  console.log("─".repeat(70));
  console.log(`Total pairs:        ${TOTAL}`);
  console.log(`Chunk size:         ${CHUNK_SIZE}`);
  console.log(`Cooldown:           ${COOLDOWN_SEC}s between chunks`);
  console.log(`Concurrency:        ${CONCURRENCY} (sequential within chunk)`);
  console.log(`Halt threshold:     ${(HALT_THRESHOLD * 100).toFixed(0)}% 429 in last ${HALT_WINDOW} → pause ${HALT_COOLDOWN_SEC}s`);
  console.log(`Max retry rounds:   ${MAX_RETRY_ROUNDS}`);
  console.log(`Retry cooldown:     ${RETRY_COOLDOWN_BASE_SEC}s × 2^round`);
  console.log(`Chunks needed:      ${totalChunks}`);
  console.log("─".repeat(70));

  const allPairs = generatePermutationPairs(TOTAL);
  console.log(`Generated ${allPairs.length} unique shuffled permutation pairs\n`);

  const globalStart = Date.now();
  let totalOk = 0;
  let total429 = 0;
  let totalOther = 0;
  let totalRetries = 0;
  let allFailed429 = [];
  const chunkStats = [];

  // ── Pass 1: initial chunked processing ────────────────────────────────
  console.log("PASS 1: Initial chunked processing");
  console.log("═".repeat(70));

  for (let c = 0; c < totalChunks; c++) {
    const chunkStart = c * CHUNK_SIZE;
    const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, TOTAL);
    const chunk = allPairs.slice(chunkStart, chunkEnd);
    const chunkNum = c + 1;

    if (c > 0) {
      const elapsed = ((Date.now() - globalStart) / 1000).toFixed(0);
      process.stdout.write(
        `  ⏳ Cooldown ${COOLDOWN_SEC}s (${elapsed}s elapsed)...`,
      );
      await sleep(COOLDOWN_SEC * 1000);
      console.log(" done");
    }

    const t = Date.now();
    const result = await processChunk(chunk, globalStart);
    const chunkMs = Date.now() - t;

    totalOk += result.ok;
    total429 += result.r429;
    totalOther += result.other;
    allFailed429.push(...result.failed429Terms);

    const successRate = ((result.ok / result.total) * 100).toFixed(1);
    const p50 = percentile(result.latencies, 50);
    chunkStats.push({
      label: `P1-C${chunkNum}`,
      size: chunk.length,
      ok: result.ok,
      r429: result.r429,
      other: result.other,
      chunkMs,
      p50,
      successRate,
      halted: result.halted,
    });

    const globalElapsed = ((Date.now() - globalStart) / 1000).toFixed(0);
    console.log(
      `  Chunk ${String(chunkNum).padStart(2)}/${totalChunks}: ` +
      `${result.ok}/${chunk.length} OK (${successRate}%) | ` +
      `429: ${result.r429}${result.halted ? " (halted)" : ""} | ` +
      `${(chunkMs / 1000).toFixed(1)}s | ` +
      `p50: ${p50}ms | ` +
      `[${globalElapsed}s total]`,
    );
  }

  // ── Retry rounds: re-process failed 429 terms ─────────────────────────
  for (let round = 0; round < MAX_RETRY_ROUNDS && allFailed429.length > 0; round++) {
    const cooldownSec = RETRY_COOLDOWN_BASE_SEC * 2 ** round;
    const retryChunks = Math.ceil(allFailed429.length / CHUNK_SIZE);
    const roundNum = round + 1;

    console.log(`\nRETRY ROUND ${roundNum}: ${allFailed429.length} failed terms, ${retryChunks} chunks`);
    console.log("═".repeat(70));

    const retryTerms = [...allFailed429];
    allFailed429 = [];

    // Shuffle retry terms for different ordering
    for (let i = retryTerms.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [retryTerms[i], retryTerms[j]] = [retryTerms[j], retryTerms[i]];
    }

    for (let c = 0; c < retryChunks; c++) {
      const chunkStartIdx = c * CHUNK_SIZE;
      const chunk = retryTerms.slice(chunkStartIdx, chunkStartIdx + CHUNK_SIZE);
      const chunkNum = c + 1;

      // Always cooldown before retry chunks (including first)
      const elapsed = ((Date.now() - globalStart) / 1000).toFixed(0);
      process.stdout.write(
        `  ⏳ Cooldown ${cooldownSec}s (${elapsed}s elapsed)...`,
      );
      await sleep(cooldownSec * 1000);
      console.log(" done");

      const t = Date.now();
      const result = await processChunk(chunk, globalStart);
      const chunkMs = Date.now() - t;

      totalOk += result.ok;
      total429 -= result.ok; // they were counted as 429 before, now succeeded
      totalRetries += chunk.length;
      allFailed429.push(...result.failed429Terms);

      const successRate = ((result.ok / result.total) * 100).toFixed(1);
      const p50 = percentile(result.latencies, 50);
      chunkStats.push({
        label: `R${roundNum}-C${chunkNum}`,
        size: chunk.length,
        ok: result.ok,
        r429: result.r429,
        other: result.other,
        chunkMs,
        p50,
        successRate,
        halted: result.halted,
      });

      const globalElapsed2 = ((Date.now() - globalStart) / 1000).toFixed(0);
      console.log(
        `  R${roundNum}-Chunk ${String(chunkNum).padStart(2)}/${retryChunks}: ` +
        `${result.ok}/${chunk.length} OK (${successRate}%) | ` +
        `429: ${result.r429}${result.halted ? " (halted)" : ""} | ` +
        `${(chunkMs / 1000).toFixed(1)}s | ` +
        `p50: ${p50}ms | ` +
        `[${globalElapsed2}s total]`,
      );
    }
  }

  const wallTime = Date.now() - globalStart;
  const overallRate = ((totalOk / TOTAL) * 100).toFixed(1);
  const stillFailed = allFailed429.length;

  console.log("\n" + "═".repeat(70));
  console.log("SUMMARY");
  console.log("═".repeat(70));
  console.log(`Total unique pairs: ${TOTAL}`);
  console.log(`Total OK:           ${totalOk} (${overallRate}%)`);
  console.log(`Still failed:       ${stillFailed}`);
  console.log(`Total retries:      ${totalRetries}`);
  console.log(`Wall time:          ${(wallTime / 1000).toFixed(1)}s (${(wallTime / 60000).toFixed(1)}min)`);
  console.log(`Throughput:         ${(totalOk / (wallTime / 1000)).toFixed(1)} successful req/s`);

  console.log("\nAll chunks:");
  console.log(
    "  Label    | Size |  OK | 429 | Success% | Time   | p50   | Halted",
  );
  console.log("  " + "-".repeat(68));
  for (const s of chunkStats) {
    console.log(
      `  ${s.label.padEnd(8)} | ` +
      `${String(s.size).padStart(4)} | ` +
      `${String(s.ok).padStart(3)} | ` +
      `${String(s.r429).padStart(3)} | ` +
      `${String(s.successRate + "%").padStart(8)} | ` +
      `${String((s.chunkMs / 1000).toFixed(1) + "s").padStart(6)} | ` +
      `${String(s.p50 + "ms").padStart(5)} | ` +
      `${s.halted ? "yes" : "no"}`,
    );
  }

  console.log("\nComparison:");
  console.log(`  No chunking:        ~103/500 OK (20.6%) in 5s`);
  console.log(`  Chunked (no retry): ~468/600 OK (78.0%) in 409s`);
  console.log(`  Chunked + retry:    ${totalOk}/${TOTAL} OK (${overallRate}%) in ${(wallTime / 1000).toFixed(1)}s`);
}

main().catch(console.error);
