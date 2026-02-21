#!/usr/bin/env python3
"""
API Rate Limit Tester v3 - Multi-Query Edition
================================================
Tests rate limits across different query terms to understand
if limits are per-IP, per-term, or per-IP+term.
"""

import requests
import time
import sys
import json
import argparse
import random
import string
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional

# ============================================================================
# CONFIG - Edit this section to test any API
# ============================================================================

CONFIG = {
    "url": "https://amp-api-edge.apps.apple.com/v1/catalog/us/search/suggestions",
    "method": "GET",
    "params": {
        "term": "bill tracker",
        "kinds": "terms",
        "platform": "iphone",
        "limit": "15",
    },
    "headers": {
        "Authorization": "Bearer eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IlU4UlRZVjVaRFMifQ.eyJpc3MiOiI3TktaMlZQNDhaIiwiaWF0IjoxNzcwODcxMzg5LCJleHAiOjE3NzgxMjg5ODksInJvb3RfaHR0cHNfb3JpZ2luIjpbImFwcGxlLmNvbSJdfQ.Tewb7DQbQYYjwlyHRehBb7Ksjcrd6wtg1xIfazeUE5iLQNPWGgh650cGJBeDjRhzk7fKIp-QyPigT14bV98Epw",
        "Origin": "https://apps.apple.com",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
    "body": None,
}

# Test terms pool - diverse keywords for multi-query tests
TERM_POOLS = {
    "small": [
        "bill tracker", "weather app", "fitness coach", "photo editor",
        "music player",
    ],
    "medium": [
        "bill tracker", "weather app", "fitness coach", "photo editor",
        "music player", "todo list", "vpn proxy", "calorie counter",
        "sleep tracker", "meditation app", "budget planner", "qr scanner",
        "pdf reader", "video editor", "language learn",
    ],
    "large": [
        "bill tracker", "weather app", "fitness coach", "photo editor",
        "music player", "todo list", "vpn proxy", "calorie counter",
        "sleep tracker", "meditation app", "budget planner", "qr scanner",
        "pdf reader", "video editor", "language learn", "password manager",
        "note taking", "file manager", "screen recorder", "email client",
        "calendar app", "alarm clock", "tip calculator", "unit converter",
        "voice recorder", "flashlight app", "compass app", "level tool",
        "white noise", "habit tracker",
    ],
}

# ============================================================================


@dataclass
class RequestResult:
    status_code: int
    latency_ms: float
    timestamp: float
    headers: dict
    term: str = ""
    error: Optional[str] = None
    body_preview: str = ""


@dataclass
class TestReport:
    results: list = field(default_factory=list)
    start_time: float = 0
    end_time: float = 0

    @property
    def duration(self):
        return self.end_time - self.start_time

    @property
    def status_counts(self):
        counts = defaultdict(int)
        for r in self.results:
            counts[r.status_code] += 1
        return dict(sorted(counts.items()))

    @property
    def success_count(self):
        return sum(1 for r in self.results if 200 <= r.status_code < 300)

    @property
    def rate_limited_count(self):
        return sum(1 for r in self.results if r.status_code in (429, 403))

    @property
    def avg_latency(self):
        lats = [r.latency_ms for r in self.results if r.error is None]
        return sum(lats) / len(lats) if lats else 0

    def per_term_stats(self):
        """Break down results by term."""
        by_term = defaultdict(lambda: {"success": 0, "limited": 0, "total": 0})
        for r in self.results:
            by_term[r.term]["total"] += 1
            if 200 <= r.status_code < 300:
                by_term[r.term]["success"] += 1
            elif r.status_code in (429, 403):
                by_term[r.term]["limited"] += 1
        return dict(by_term)


def send_request(config: dict, request_num: int, term: str = None) -> RequestResult:
    """Send a single request, optionally overriding the search term."""
    ts = time.time()
    try:
        method = config["method"].upper()
        params = dict(config.get("params", {}))
        if term is not None:
            params["term"] = term

        kwargs = {
            "url": config["url"],
            "headers": config.get("headers", {}),
            "params": params,
            "timeout": 30,
        }
        if method in ("POST", "PUT", "PATCH") and config.get("body"):
            kwargs["json"] = config["body"]

        start = time.perf_counter()
        resp = requests.request(method, **kwargs)
        latency = (time.perf_counter() - start) * 1000

        rl_headers = {}
        for key, val in resp.headers.items():
            kl = key.lower()
            if any(x in kl for x in ["rate", "limit", "remaining", "reset", "retry"]):
                rl_headers[key] = val

        body_preview = resp.text[:200] if resp.status_code != 200 else ""

        return RequestResult(
            status_code=resp.status_code,
            latency_ms=round(latency, 1),
            timestamp=ts,
            headers=rl_headers,
            term=term or params.get("term", ""),
            body_preview=body_preview,
        )
    except Exception as e:
        return RequestResult(
            status_code=0,
            latency_ms=0,
            timestamp=ts,
            headers={},
            term=term or "",
            error=str(e),
        )


# ============================================================================
# ORIGINAL TEST MODES
# ============================================================================

def run_burst_test(config, num_requests, concurrency):
    report = TestReport()
    report.start_time = time.time()
    term = config["params"].get("term", "test")

    print(f"\n{'='*70}")
    print(f"  BURST TEST: {num_requests} requests, {concurrency} concurrent")
    print(f"  Term: \"{term}\"")
    print(f"{'='*70}")

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(send_request, config, i): i for i in range(num_requests)}
        for future in as_completed(futures):
            result = future.result()
            report.results.append(result)
            idx = futures[future]
            icon = "✓" if 200 <= result.status_code < 300 else "✗"
            extra = "  ⚠ RATE LIMITED" if result.status_code == 429 else ""
            if result.error:
                extra = f"  ERROR: {result.error}"
            print(f"  [{idx+1:3d}/{num_requests}] {icon} {result.status_code}  {result.latency_ms:7.1f}ms{extra}")

    report.end_time = time.time()
    return report


def run_sustained_test(config, rps, duration_secs):
    report = TestReport()
    report.start_time = time.time()
    interval = 1.0 / rps
    total = int(rps * duration_secs)
    term = config["params"].get("term", "test")

    print(f"\n{'='*70}")
    print(f"  SUSTAINED TEST: ~{rps} req/s for {duration_secs}s ({total} requests)")
    print(f"  Term: \"{term}\"")
    print(f"{'='*70}")

    for i in range(total):
        loop_start = time.perf_counter()
        result = send_request(config, i)
        report.results.append(result)
        icon = "✓" if 200 <= result.status_code < 300 else "✗"
        extra = "  ⚠ RATE LIMITED" if result.status_code == 429 else ""
        print(f"  [{i+1:3d}/{total}] {icon} {result.status_code}  {result.latency_ms:7.1f}ms{extra}")
        elapsed = time.perf_counter() - loop_start
        sleep_time = max(0, interval - elapsed)
        if sleep_time > 0:
            time.sleep(sleep_time)

    report.end_time = time.time()
    return report


def run_ramp_test(config, max_rps, step_duration=5, step_size=2):
    report = TestReport()
    report.start_time = time.time()

    print(f"\n{'='*70}")
    print(f"  RAMP TEST: Increasing rate up to {max_rps} req/s")
    print(f"  Step duration: {step_duration}s, Step size: +{step_size} req/s")
    print(f"{'='*70}")

    current_rps = step_size
    rate_limit_detected = False

    while current_rps <= max_rps and not rate_limit_detected:
        print(f"\n  --- Rate: {current_rps:.1f} req/s ---")
        interval = 1.0 / current_rps
        step_requests = int(current_rps * step_duration)
        limited_in_step = 0

        for i in range(step_requests):
            loop_start = time.perf_counter()
            result = send_request(config, i)
            report.results.append(result)
            if result.status_code in (429, 403):
                limited_in_step += 1
            icon = "✓" if 200 <= result.status_code < 300 else "✗"
            extra = "  ⚠ RATE LIMITED" if result.status_code == 429 else ""
            print(f"    [{i+1:3d}/{step_requests}] {icon} {result.status_code}  {result.latency_ms:7.1f}ms{extra}")
            elapsed = time.perf_counter() - loop_start
            sleep_time = max(0, interval - elapsed)
            if sleep_time > 0:
                time.sleep(sleep_time)

        limit_pct = limited_in_step / step_requests * 100 if step_requests else 0
        if limit_pct > 20:
            print(f"\n  ⚠ Rate limit hit at ~{current_rps:.1f} req/s ({limit_pct:.0f}% limited)")
            rate_limit_detected = True
        else:
            print(f"  ✓ {current_rps:.1f} req/s OK ({limited_in_step}/{step_requests} limited)")
        current_rps += step_size

    report.end_time = time.time()
    return report


# ============================================================================
# NEW: MULTI-QUERY TEST MODES
# ============================================================================

def run_unique_terms_test(config, rps, duration_secs, pool_name="large"):
    """
    Each request uses a DIFFERENT term from the pool (round-robin).
    Tests if rate limit is per-IP (all get limited) or per-term (none get limited).
    """
    report = TestReport()
    report.start_time = time.time()
    interval = 1.0 / rps
    total = int(rps * duration_secs)
    terms = TERM_POOLS.get(pool_name, TERM_POOLS["large"])

    print(f"\n{'='*70}")
    print(f"  UNIQUE TERMS TEST: ~{rps} req/s for {duration_secs}s ({total} requests)")
    print(f"  Pool: {pool_name} ({len(terms)} unique terms, round-robin)")
    print(f"  Goal: Test if rate limit is per-IP or per-term")
    print(f"{'='*70}")

    for i in range(total):
        loop_start = time.perf_counter()
        term = terms[i % len(terms)]
        result = send_request(config, i, term=term)
        report.results.append(result)

        icon = "✓" if 200 <= result.status_code < 300 else "✗"
        extra = "  ⚠ RATE LIMITED" if result.status_code == 429 else ""
        print(f"  [{i+1:3d}/{total}] {icon} {result.status_code}  {result.latency_ms:7.1f}ms  \"{term}\"{extra}")

        elapsed = time.perf_counter() - loop_start
        sleep_time = max(0, interval - elapsed)
        if sleep_time > 0:
            time.sleep(sleep_time)

    report.end_time = time.time()
    return report


def run_repeat_per_term_test(config, repeats_per_term, delay_between, pool_name="small"):
    """
    Sends N requests for each term sequentially (simulates your actual
    keyword lookup: 4 requests per keyword).
    """
    report = TestReport()
    report.start_time = time.time()
    terms = TERM_POOLS.get(pool_name, TERM_POOLS["small"])

    print(f"\n{'='*70}")
    print(f"  REPEAT-PER-TERM TEST: {repeats_per_term} requests per term")
    print(f"  Terms: {len(terms)} | Delay between requests: {delay_between}s")
    print(f"  Goal: Simulate real usage (4 lookups per keyword)")
    print(f"{'='*70}")

    req_num = 0
    total = len(terms) * repeats_per_term
    for term in terms:
        print(f"\n  --- Term: \"{term}\" ({repeats_per_term} requests) ---")
        for j in range(repeats_per_term):
            req_num += 1
            result = send_request(config, req_num, term=term)
            report.results.append(result)

            icon = "✓" if 200 <= result.status_code < 300 else "✗"
            extra = "  ⚠ RATE LIMITED" if result.status_code == 429 else ""
            print(f"    [{req_num:3d}/{total}] {icon} {result.status_code}  {result.latency_ms:7.1f}ms{extra}")

            if delay_between > 0 and j < repeats_per_term - 1:
                time.sleep(delay_between)

    report.end_time = time.time()
    return report


def run_burst_unique_test(config, num_requests, concurrency, pool_name="large"):
    """
    Burst of concurrent requests, each with a DIFFERENT term.
    Tests max throughput when every request is a unique query.
    """
    report = TestReport()
    report.start_time = time.time()
    terms = TERM_POOLS.get(pool_name, TERM_POOLS["large"])

    print(f"\n{'='*70}")
    print(f"  BURST UNIQUE TEST: {num_requests} requests, {concurrency} concurrent")
    print(f"  Each request uses a different term ({len(terms)} in pool)")
    print(f"  Goal: Test max concurrent throughput with unique terms")
    print(f"{'='*70}")

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {}
        for i in range(num_requests):
            term = terms[i % len(terms)]
            future = pool.submit(send_request, config, i, term=term)
            futures[future] = (i, term)

        for future in as_completed(futures):
            result = future.result()
            report.results.append(result)
            idx, term = futures[future]
            icon = "✓" if 200 <= result.status_code < 300 else "✗"
            extra = "  ⚠ RATE LIMITED" if result.status_code == 429 else ""
            print(f"  [{idx+1:3d}/{num_requests}] {icon} {result.status_code}  {result.latency_ms:7.1f}ms  \"{term}\"{extra}")

    report.end_time = time.time()
    return report


def run_same_vs_unique_test(config, num_each, rps):
    """
    Side-by-side: sends N requests with SAME term, then N with UNIQUE terms.
    Directly compares rate limiting behavior.
    """
    interval = 1.0 / rps
    same_term = "bill tracker"

    print(f"\n{'='*70}")
    print(f"  SAME vs UNIQUE COMPARISON TEST")
    print(f"  Phase 1: {num_each} requests with SAME term (\"{same_term}\") @ {rps} req/s")
    print(f"  Phase 2: {num_each} requests with UNIQUE terms @ {rps} req/s")
    print(f"{'='*70}")

    # Phase 1: Same term
    print(f"\n  ── Phase 1: SAME TERM (\"{same_term}\") ──")
    same_results = []
    for i in range(num_each):
        loop_start = time.perf_counter()
        result = send_request(config, i, term=same_term)
        same_results.append(result)
        icon = "✓" if 200 <= result.status_code < 300 else "✗"
        extra = "  ⚠ RATE LIMITED" if result.status_code == 429 else ""
        print(f"    [{i+1:3d}/{num_each}] {icon} {result.status_code}  {result.latency_ms:7.1f}ms{extra}")
        elapsed = time.perf_counter() - loop_start
        sleep_time = max(0, interval - elapsed)
        if sleep_time > 0:
            time.sleep(sleep_time)

    same_limited = sum(1 for r in same_results if r.status_code in (429, 403))
    same_success = sum(1 for r in same_results if 200 <= r.status_code < 300)
    print(f"\n  Phase 1 result: {same_success}/{num_each} success, {same_limited}/{num_each} rate limited")

    print(f"\n  ⏳ 3 second pause between phases...")
    time.sleep(3)

    # Phase 2: Unique terms
    terms = TERM_POOLS["large"]
    print(f"\n  ── Phase 2: UNIQUE TERMS ({len(terms)} available) ──")
    unique_results = []
    for i in range(num_each):
        loop_start = time.perf_counter()
        term = terms[i % len(terms)]
        result = send_request(config, i, term=term)
        unique_results.append(result)
        icon = "✓" if 200 <= result.status_code < 300 else "✗"
        extra = "  ⚠ RATE LIMITED" if result.status_code == 429 else ""
        print(f"    [{i+1:3d}/{num_each}] {icon} {result.status_code}  {result.latency_ms:7.1f}ms  \"{term}\"{extra}")
        elapsed = time.perf_counter() - loop_start
        sleep_time = max(0, interval - elapsed)
        if sleep_time > 0:
            time.sleep(sleep_time)

    unique_limited = sum(1 for r in unique_results if r.status_code in (429, 403))
    unique_success = sum(1 for r in unique_results if 200 <= r.status_code < 300)
    print(f"\n  Phase 2 result: {unique_success}/{num_each} success, {unique_limited}/{num_each} rate limited")

    # Comparison
    print(f"\n{'='*70}")
    print(f"  COMPARISON RESULT")
    print(f"{'='*70}")
    print(f"  {'':20s} {'Success':>10s} {'Limited':>10s} {'Limit %':>10s}")
    print(f"  {'Same term':20s} {same_success:>10d} {same_limited:>10d} {same_limited/num_each*100:>9.1f}%")
    print(f"  {'Unique terms':20s} {unique_success:>10d} {unique_limited:>10d} {unique_limited/num_each*100:>9.1f}%")
    print(f"{'='*70}")

    if unique_limited == 0 and same_limited > 0:
        print(f"  ✅ CONCLUSION: Rate limit is PER-TERM (unique terms bypass it)")
    elif unique_limited > 0 and same_limited > 0:
        if unique_limited < same_limited * 0.5:
            print(f"  ⚠️  CONCLUSION: Likely HYBRID (per-term + some per-IP component)")
        else:
            print(f"  ❌ CONCLUSION: Rate limit is PER-IP (unique terms don't help)")
    elif unique_limited == 0 and same_limited == 0:
        print(f"  ℹ️  CONCLUSION: No rate limits hit — try higher RPS or more requests")
    print()

    report = TestReport()
    report.results = same_results + unique_results
    report.start_time = same_results[0].timestamp if same_results else 0
    report.end_time = time.time()
    return report


# ============================================================================
# SUMMARY PRINTER
# ============================================================================

def print_summary(report, test_name):
    print(f"\n{'='*70}")
    print(f"  SUMMARY: {test_name}")
    print(f"{'='*70}")
    print(f"  Total requests:    {len(report.results)}")
    print(f"  Duration:          {report.duration:.2f}s")
    print(f"  Effective RPS:     {len(report.results)/report.duration:.1f}")
    print(f"  Successful (2xx):  {report.success_count}")
    print(f"  Rate limited:      {report.rate_limited_count}")
    print(f"  Avg latency:       {report.avg_latency:.1f}ms")
    print(f"  Status breakdown:  {report.status_counts}")

    all_rl_headers = {}
    for r in report.results:
        all_rl_headers.update(r.headers)
    if all_rl_headers:
        print(f"\n  Rate-limit headers observed:")
        for k, v in all_rl_headers.items():
            print(f"    {k}: {v}")
    else:
        print(f"\n  No rate-limit headers detected in responses.")

    if report.rate_limited_count > 0:
        first_limited = next(
            (i for i, r in enumerate(report.results) if r.status_code in (429, 403)), None
        )
        if first_limited is not None:
            print(f"\n  ⚡ First rate limit hit at request #{first_limited + 1}")
            elapsed_to_limit = report.results[first_limited].timestamp - report.start_time
            if elapsed_to_limit > 0:
                print(f"     (~{elapsed_to_limit:.2f}s into the test, ~{first_limited/elapsed_to_limit:.1f} req/s)")

    # Per-term breakdown
    per_term = report.per_term_stats()
    if len(per_term) > 1:
        print(f"\n  Per-term breakdown:")
        print(f"  {'Term':30s} {'Total':>6s} {'OK':>6s} {'429':>6s} {'Limit%':>8s}")
        print(f"  {'-'*56}")
        for term, stats in sorted(per_term.items(), key=lambda x: x[1]["limited"], reverse=True):
            pct = stats["limited"] / stats["total"] * 100 if stats["total"] else 0
            flag = " ⚠" if pct > 0 else ""
            print(f"  {term:30s} {stats['total']:>6d} {stats['success']:>6d} {stats['limited']:>6d} {pct:>7.1f}%{flag}")

    print(f"{'='*70}\n")


# ============================================================================
# MAIN
# ============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="API Rate Limit Tester v3 - Multi-Query Edition",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Test modes:
  burst              Concurrent requests, same term
  sustained          Steady rate, same term
  ramp               Increasing rate, same term

  unique             Each request uses a different term (round-robin)
  repeat             N requests per term sequentially (simulates real lookup)
  burst-unique       Concurrent burst, each request different term
  compare            Side-by-side: same term vs unique terms

Examples:
  # The key test — compare same vs unique terms
  python rate_limit_tester.py compare -n 30 -r 3

  # Push unique terms hard: 10 req/s for 60s
  python rate_limit_tester.py unique -r 10 -d 60 --pool large

  # Simulate real usage: 4 requests per keyword, 15 keywords
  python rate_limit_tester.py repeat --repeats 4 --delay 0.1 --pool medium

  # Burst 60 concurrent requests, all different terms
  python rate_limit_tester.py burst-unique -n 60 -c 30 --pool large

  # Push unique terms even harder: 20 req/s
  python rate_limit_tester.py unique -r 20 -d 30 --pool large

  # Classic single-term tests
  python rate_limit_tester.py burst -n 200 -c 50
  python rate_limit_tester.py sustained -r 3 -d 60
        """,
    )

    parser.add_argument("test", choices=[
        "burst", "sustained", "ramp",
        "unique", "repeat", "burst-unique", "compare",
    ])
    parser.add_argument("-n", "--num-requests", type=int, default=30)
    parser.add_argument("-c", "--concurrency", type=int, default=10)
    parser.add_argument("-r", "--rps", type=float, default=3)
    parser.add_argument("-d", "--duration", type=int, default=30)
    parser.add_argument("-m", "--max-rps", type=float, default=20)
    parser.add_argument("--step-size", type=float, default=2)
    parser.add_argument("--step-duration", type=int, default=5)
    parser.add_argument("--pool", choices=["small", "medium", "large"], default="large",
                        help="Term pool size (small=5, medium=15, large=30)")
    parser.add_argument("--repeats", type=int, default=4,
                        help="Requests per term (repeat mode)")
    parser.add_argument("--delay", type=float, default=0.1,
                        help="Delay between requests to same term (repeat mode)")
    parser.add_argument("--url", help="Override URL")
    parser.add_argument("--method", help="Override HTTP method")
    parser.add_argument("--header", action="append", help='Add header: "Key: Value"')

    args = parser.parse_args()

    config = CONFIG.copy()
    config["params"] = dict(CONFIG["params"])
    config["headers"] = dict(CONFIG["headers"])
    if args.url:
        config["url"] = args.url
    if args.method:
        config["method"] = args.method
    if args.header:
        for h in args.header:
            key, _, value = h.partition(":")
            config["headers"][key.strip()] = value.strip()

    print(f"\n  Target: {config['method']} {config['url']}")
    print(f"  Headers: {len(config.get('headers', {}))} custom headers")

    print("\n  Sending test request...")
    test = send_request(config, 0)
    if test.error:
        print(f"  ✗ Connection failed: {test.error}")
        sys.exit(1)
    print(f"  ✓ Connection OK (status={test.status_code}, latency={test.latency_ms}ms)")

    if args.test == "burst":
        report = run_burst_test(config, args.num_requests, args.concurrency)
        print_summary(report, "Burst Test")
    elif args.test == "sustained":
        report = run_sustained_test(config, args.rps, args.duration)
        print_summary(report, "Sustained Test")
    elif args.test == "ramp":
        report = run_ramp_test(config, args.max_rps, args.step_duration, args.step_size)
        print_summary(report, "Ramp Test")
    elif args.test == "unique":
        report = run_unique_terms_test(config, args.rps, args.duration, args.pool)
        print_summary(report, "Unique Terms Test")
    elif args.test == "repeat":
        report = run_repeat_per_term_test(config, args.repeats, args.delay, args.pool)
        print_summary(report, "Repeat-Per-Term Test")
    elif args.test == "burst-unique":
        report = run_burst_unique_test(config, args.num_requests, args.concurrency, args.pool)
        print_summary(report, "Burst Unique Test")
    elif args.test == "compare":
        report = run_same_vs_unique_test(config, args.num_requests, args.rps)
        print_summary(report, "Same vs Unique Comparison")


if __name__ == "__main__":
    main()