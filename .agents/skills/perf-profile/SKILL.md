---
name: perf-profile
description: Profile and optimize performance: identify hotspots with real measurements, instrument the code, analyze bottlenecks, apply targeted optimizations, and verify improvement. Use when the goal asks to profile, optimize, speed up, reduce latency, fix slow queries, or improve throughput.
version: 1.0.0
---

# perf-profile

Profile and optimize performance: identify hotspots with real measurements, instrument the code, analyze bottlenecks, apply targeted optimizations, and verify improvement. Use when the goal asks to profile, optimize, speed up, reduce latency, fix slow queries, or improve throughput.

## Goal pattern

performance profile optimize speed slow latency throughput hotspot bottleneck N+1 query cache memory

## Parameters

- language (choice [default: auto]): Language/runtime (auto-detected from project if not specified)
- target (string): Specific code path or endpoint to profile (default: the whole app)

## Steps

1. [context-gatherer] Identify the performance concern with evidence:
- Read the code path in question (entry point → hot path → exit)
- Note the language runtime (Node.js, Python, Go) and available profiling tools
- Identify what "slow" means: latency (p50/p95/p99), throughput (req/s), memory (heap usage), CPU (utilization)
- Check for known anti-patterns: N+1 queries, synchronous I/O in loops, unbounded caches, missing indexes
Produce: the code path, the metric to optimize, and the baseline measurement to beat.

2. [runner] Measure the baseline with real tools:
- Node.js: `node --prof` + `--prof-process`, or `clinic flame` / `clinic doctor`, or built-in `console.time`
- Python: `cProfile` + `snakeviz`, or `py-spy`, or `line_profiler`
- Go: `go test -bench`, `go tool pprof`, `benchstat`
- Database: `EXPLAIN ANALYZE` on slow queries
- HTTP: `wrk` or `hey` for load testing
Record the baseline numbers so improvements are measurable (not主观). (after: step-0)

3. [reviewer] Analyze the profiler output to find the ACTUAL bottleneck:
- CPU flame graph: the widest frames are the hot functions
- Memory profile: the largest allocations are the leak/growth source
- Database queries: the slowest queries (by time or frequency) are the I/O bottleneck
- HTTP timing: the slowest middleware/handler is the latency source
Classify the bottleneck: CPU-bound, I/O-bound, memory-bound, or network-bound. The fix depends on the class. (after: step-1)

4. [runner] Apply targeted optimizations for the bottleneck class:
- CPU-bound: algorithm optimization, caching, worker threads, native addons
- I/O-bound: batch queries (eliminate N+1), connection pooling, async/await, pagination
- Memory: fix leaks (unreleased references), reduce allocations (object pools), streaming (process large data incrementally)
- Network: reduce round-trips (batching), compression, CDN, connection keep-alive
Make ONE optimization at a time — measure after each change so you know what helped. (after: step-2)

5. [reviewer] Verify the improvement with measurements:
- Re-run the SAME profiling command from step-1
- Compare baseline vs optimized: latency improvement, throughput gain, memory reduction
- Run the test suite to confirm no regressions: Run `npm test` or equivalent
Report: what was slow, what was the root cause, what optimization was applied, and the measured improvement (baseline → optimized). (after: step-3)
