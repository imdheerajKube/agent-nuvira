/**
 * Benchmark — Standardized model benchmarking system for coding tasks.
 *
 * Runs a suite of coding tasks against configured providers/models and
 * measures: success rate, output quality, latency, and cost.
 *
 * Usage:
 *   buff benchmark                          — Run all tasks against default provider
 *   buff benchmark --provider groq          — Run against a specific provider
 *   buff benchmark --model llama-3.3-70b    — Run against a specific model
 *   buff benchmark --tasks quick            — Run only quick tasks
 *   buff benchmark --budget 0.50            — Stop if costs exceed $0.50
 *   buff benchmark list                     — List available benchmark tasks
 *   buff benchmark results                  — Show previous benchmark results
 *
 * Results stored in: ~/.buff/memory/benchmarks.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { estimateTokens, calculateCost } from './cost-tracker.js';
import { logger } from '../utils/logger.js';
// ─── Benchmark Tasks ────────────────────────────────────────────────────────
const BENCHMARK_TASKS = [
    // ── Easy: Code Generation ─────────────────────────────────────────────
    {
        id: 'hello-world',
        title: 'Hello World Function',
        tag: 'code-generation',
        difficulty: 'easy',
        prompt: 'Write a JavaScript function called `greet` that takes a name parameter and returns "Hello, {name}!". Include a default parameter value.',
        expectedPatterns: ['function greet', 'Hello,', 'default'],
        maxExpectedTokens: 150,
        timeEstimate: 'quick',
        outputLanguage: 'javascript',
    },
    {
        id: 'fibonacci',
        title: 'Fibonacci Sequence',
        tag: 'code-generation',
        difficulty: 'easy',
        prompt: 'Write a Python function `fibonacci(n)` that returns the nth Fibonacci number using recursion. Include a comment explaining the base case.',
        expectedPatterns: ['def fibonacci', 'return', '#'],
        maxExpectedTokens: 200,
        timeEstimate: 'quick',
        outputLanguage: 'python',
    },
    {
        id: 'fizzbuzz',
        title: 'FizzBuzz Implementation',
        tag: 'code-generation',
        difficulty: 'easy',
        prompt: 'Write a TypeScript function `fizzBuzz(n)` that prints numbers 1 to n, replacing multiples of 3 with "Fizz", multiples of 5 with "Buzz", and multiples of both with "FizzBuzz".',
        expectedPatterns: ['Fizz', 'Buzz', 'FizzBuzz', 'function fizzBuzz'],
        maxExpectedTokens: 300,
        timeEstimate: 'quick',
        outputLanguage: 'typescript',
    },
    // ── Medium: Code Generation ───────────────────────────────────────────
    {
        id: 'express-api',
        title: 'Express.js API Route',
        tag: 'code-generation',
        difficulty: 'medium',
        prompt: 'Create an Express.js route handler for a REST API endpoint that handles POST requests to /api/users. It should validate that the request body has "name" and "email" fields, and return a 201 status with the user object. Include error handling for missing fields (400 status).',
        expectedPatterns: ['app.post', '/api/users', 'res.status', 'name', 'email'],
        maxExpectedTokens: 500,
        timeEstimate: 'medium',
        outputLanguage: 'javascript',
    },
    {
        id: 'typescript-generics',
        title: 'TypeScript Generics',
        tag: 'code-generation',
        difficulty: 'medium',
        prompt: 'Write a TypeScript generic function `mergeObjects<T, U>(obj1: T, obj2: U): T & U` that merges two objects. Then write a type-safe function `getProperty<T, K extends keyof T>(obj: T, key: K): T[K]`.',
        expectedPatterns: ['<T,', 'extends', 'keyof', 'T & U'],
        maxExpectedTokens: 400,
        timeEstimate: 'medium',
        outputLanguage: 'typescript',
    },
    {
        id: 'react-component',
        title: 'React Component',
        tag: 'code-generation',
        difficulty: 'medium',
        prompt: 'Write a React TypeScript component called `UserList` that fetches users from `https://jsonplaceholder.typicode.com/users` using useEffect and useState. Display loading, error, and success states. Include proper TypeScript interfaces.',
        expectedPatterns: ['useState', 'useEffect', 'interface', 'fetch', 'UserList'],
        maxExpectedTokens: 600,
        timeEstimate: 'medium',
        outputLanguage: 'typescript',
    },
    // ── Refactoring ───────────────────────────────────────────────────────
    {
        id: 'refactor-callback',
        title: 'Callback to Async/Await',
        tag: 'refactoring',
        difficulty: 'medium',
        prompt: 'Refactor this callback-based function to use async/await:\n\nfunction getUserData(userId, callback) {\n  getUser(userId, (err, user) => {\n    if (err) return callback(err);\n    getPosts(user.id, (err, posts) => {\n      if (err) return callback(err);\n      getComments(posts[0].id, (err, comments) => {\n        if (err) return callback(err);\n        callback(null, { user, posts, comments });\n      });\n    });\n  });\n}',
        expectedPatterns: ['async', 'await', 'try', 'catch'],
        antiPatterns: ['callback'],
        maxExpectedTokens: 400,
        timeEstimate: 'medium',
        outputLanguage: 'javascript',
    },
    {
        id: 'refactor-class-to-func',
        title: 'Class to Functional Component',
        tag: 'refactoring',
        difficulty: 'medium',
        prompt: 'Refactor this React class component to a functional component with hooks:\n\nclass Counter extends React.Component {\n  constructor(props) {\n    super(props);\n    this.state = { count: 0 };\n  }\n  componentDidMount() { document.title = `Count: ${this.state.count}`; }\n  componentDidUpdate() { document.title = `Count: ${this.state.count}`; }\n  render() {\n    return <div><p>Count: {this.state.count}</p><button onClick={() => this.setState({ count: this.state.count + 1 })}>+</button></div>;\n  }\n}',
        expectedPatterns: ['useState', 'useEffect', '=>'],
        antiPatterns: ['class Counter', 'this.state', 'extends React'],
        maxExpectedTokens: 400,
        timeEstimate: 'medium',
        outputLanguage: 'typescript',
    },
    // ── Debugging ─────────────────────────────────────────────────────────
    {
        id: 'debug-closure',
        title: 'Fix Closure Bug',
        tag: 'debugging',
        difficulty: 'medium',
        prompt: 'Find and fix the bug in this code:\n\nfor (var i = 0; i < 5; i++) {\n  setTimeout(function() {\n    console.log(i);\n  }, 100);\n}\n\nExpected output: 0, 1, 2, 3, 4\nActual output: 5, 5, 5, 5, 5\n\nExplain the bug and provide the fix.',
        expectedPatterns: ['let', 'closure', 'var', 'block scope'],
        maxExpectedTokens: 300,
        timeEstimate: 'quick',
        outputLanguage: 'javascript',
    },
    {
        id: 'debug-null',
        title: 'Fix Null Reference',
        tag: 'debugging',
        difficulty: 'easy',
        prompt: 'Find and fix the bug: \n\nconst users = [\n  { name: "Alice", address: { city: "NYC" } },\n  { name: "Bob" },\n  { name: "Charlie", address: { city: "LA" } }\n];\n\nusers.forEach(user => console.log(user.address.city.toUpperCase()));\n\nExplain the error and provide a fix using optional chaining.',
        expectedPatterns: ['?.', 'optional chaining', 'undefined'],
        maxExpectedTokens: 250,
        timeEstimate: 'quick',
        outputLanguage: 'javascript',
    },
    // ── Testing ───────────────────────────────────────────────────────────
    {
        id: 'unit-test',
        title: 'Write Unit Tests',
        tag: 'testing',
        difficulty: 'medium',
        prompt: 'Write Vitest unit tests for this function:\n\nexport function calculateDiscount(price: number, isMember: boolean): number {\n  if (price < 0) throw new Error("Price cannot be negative");\n  if (isMember) return price * 0.9;\n  if (price > 100) return price * 0.95;\n  return price;\n}\n\nInclude tests for: normal cases, member discount, high-value discount, negative price error, and edge cases.',
        expectedPatterns: ['describe', 'it', 'expect', 'calculateDiscount', 'throw'],
        maxExpectedTokens: 500,
        timeEstimate: 'medium',
        outputLanguage: 'typescript',
    },
    // ── Documentation ─────────────────────────────────────────────────────
    {
        id: 'jsdoc',
        title: 'Generate Documentation',
        tag: 'documentation',
        difficulty: 'easy',
        prompt: 'Add JSDoc comments to this function:\n\nfunction parseConfig(configStr, options) {\n  const config = JSON.parse(configStr);\n  if (options.validate) {\n    validateConfig(config);\n  }\n  return config;\n}\n\nInclude: parameter descriptions, return type, and a usage example.',
        expectedPatterns: ['@param', '@returns', '@example', 'parseConfig'],
        maxExpectedTokens: 250,
        timeEstimate: 'quick',
        outputLanguage: 'javascript',
    },
    // ── Security ──────────────────────────────────────────────────────────
    {
        id: 'security-sql',
        title: 'Fix SQL Injection',
        tag: 'security',
        difficulty: 'hard',
        prompt: 'Identify and fix the security vulnerability in this code:\n\napp.get("/users", (req, res) => {\n  const name = req.query.name;\n  const query = `SELECT * FROM users WHERE name = "${name}"`;\n  db.query(query, (err, results) => {\n    res.json(results);\n  });\n});\n\nExplain the vulnerability and provide a secure implementation using parameterized queries.',
        expectedPatterns: ['parameterized', 'prepared statement', 'SQL injection', '$1', '?'],
        antiPatterns: ['string interpolation', 'template literal'],
        maxExpectedTokens: 400,
        timeEstimate: 'medium',
        outputLanguage: 'javascript',
    },
    {
        id: 'security-xss',
        title: 'Fix XSS Vulnerability',
        tag: 'security',
        difficulty: 'medium',
        prompt: 'Identify and fix the XSS vulnerability:\n\napp.get("/profile", (req, res) => {\n  const username = req.query.username;\n  res.send(`<h1>Welcome, ${username}!</h1>`);\n});\n\nExplain the vulnerability and show two fix approaches: (1) escaping output, (2) using a template engine with auto-escaping.',
        expectedPatterns: ['escape', 'XSS', 'sanitize', 'textContent'],
        antiPatterns: ['res.send', 'innerHTML'],
        maxExpectedTokens: 400,
        timeEstimate: 'medium',
        outputLanguage: 'javascript',
    },
    // ── Optimization ──────────────────────────────────────────────────────
    {
        id: 'optimize-array',
        title: 'Optimize Array Operations',
        tag: 'optimization',
        difficulty: 'medium',
        prompt: 'Optimize this code for performance:\n\nfunction findDuplicates(arr) {\n  const duplicates = [];\n  for (let i = 0; i < arr.length; i++) {\n    for (let j = 0; j < arr.length; j++) {\n      if (i !== j && arr[i] === arr[j]) {\n        if (!duplicates.includes(arr[i])) {\n          duplicates.push(arr[i]);\n        }\n      }\n    }\n  }\n  return duplicates;\n}\n\nExplain why the original is slow (O(n²)) and provide an O(n) solution.',
        expectedPatterns: ['Set', 'O(n', 'has', 'new Set'],
        antiPatterns: ['nested loop', 'includes'],
        maxExpectedTokens: 400,
        timeEstimate: 'medium',
        outputLanguage: 'javascript',
    },
    // ── Explanation / Comprehension ───────────────────────────────────────
    {
        id: 'explain-prototype',
        title: 'Explain Prototype Chain',
        tag: 'comprehension',
        difficulty: 'medium',
        prompt: 'Explain JavaScript prototype chain in 3-4 sentences. Include what `__proto__` is, how `Function.prototype` works, and give a simple example of prototypal inheritance.',
        expectedPatterns: ['prototype', '__proto__', 'inheritance', 'Object.create'],
        maxExpectedTokens: 300,
        timeEstimate: 'quick',
        outputLanguage: 'text',
    },
    {
        id: 'explain-event-loop',
        title: 'Explain Event Loop',
        tag: 'comprehension',
        difficulty: 'medium',
        prompt: 'Explain the JavaScript event loop in simple terms. Cover: call stack, task queue, microtasks (Promise), and the order of execution. Give a short code example that demonstrates the order.',
        expectedPatterns: ['call stack', 'task queue', 'microtask', 'Promise', 'event loop'],
        maxExpectedTokens: 400,
        timeEstimate: 'quick',
        outputLanguage: 'text',
    },
    // ── Hard: Complex Code Generation ─────────────────────────────────────
    {
        id: 'middleware-chain',
        title: 'Express Middleware Chain',
        tag: 'code-generation',
        difficulty: 'hard',
        prompt: 'Write an Express middleware chain for a production API: (1) request logging middleware that logs method, URL, and response time, (2) authentication middleware that checks a JWT token from the Authorization header, (3) error handling middleware that catches all errors and returns consistent JSON error responses. Include TypeScript types.',
        expectedPatterns: ['next', 'req', 'res', 'JWT', 'Authorization', 'middleware'],
        maxExpectedTokens: 700,
        timeEstimate: 'slow',
        outputLanguage: 'typescript',
    },
    {
        id: 'rate-limiter',
        title: 'Rate Limiter Implementation',
        tag: 'code-generation',
        difficulty: 'hard',
        prompt: 'Implement a token bucket rate limiter in TypeScript:\n- Configurable: maxTokens, refillRate (tokens per second)\n- allowRequest(): boolean method\n- Thread-safe consideration (single-threaded JS is fine)\n- Include a usage example\n- Add JSDoc comments',
        expectedPatterns: ['class', 'token', 'bucket', 'refill', 'allowRequest', 'RateLimiter'],
        maxExpectedTokens: 500,
        timeEstimate: 'medium',
        outputLanguage: 'typescript',
    },
    // ── Translation ───────────────────────────────────────────────────────
    {
        id: 'translate-py-to-ts',
        title: 'Python to TypeScript Translation',
        tag: 'translation',
        difficulty: 'medium',
        prompt: 'Translate this Python function to TypeScript:\n\ndef process_items(items: list[dict]) -> dict[str, list]:\n    result = {"valid": [], "invalid": []}\n    for item in items:\n        if item.get("active") and item.get("value", 0) > 0:\n            result["valid"].append(item)\n        else:\n            result["invalid"].append(item)\n    return result\n\nInclude proper TypeScript interfaces and types.',
        expectedPatterns: ['interface', 'processItems', 'valid', 'invalid', 'Array'],
        maxExpectedTokens: 400,
        timeEstimate: 'medium',
        outputLanguage: 'typescript',
    },
];
// ─── Constants ──────────────────────────────────────────────────────────────
const MEMORY_DIR = join(homedir(), '.buff', 'memory');
const BENCHMARK_PATH = join(MEMORY_DIR, 'benchmarks.json');
const CURRENT_VERSION = 1;
const MAX_BENCHMARK_RUNS = 50;
// ─── Helpers ────────────────────────────────────────────────────────────────
function ensureDir() {
    if (!existsSync(MEMORY_DIR)) {
        mkdirSync(MEMORY_DIR, { recursive: true });
    }
}
function readBenchmarkData() {
    try {
        ensureDir();
        if (!existsSync(BENCHMARK_PATH)) {
            return { runs: [], version: CURRENT_VERSION };
        }
        const raw = readFileSync(BENCHMARK_PATH, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return { runs: [], version: CURRENT_VERSION };
    }
}
function writeBenchmarkData(data) {
    ensureDir();
    writeFileSync(BENCHMARK_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
/**
 * Generate a quality score for a model's output based on heuristics.
 * Scores range from 0 (poor) to 1 (excellent).
 */
export function scoreQuality(output, task) {
    let score = 0.5; // Start at neutral
    // Bonus: output matches expected patterns
    if (task.expectedPatterns) {
        const matched = task.expectedPatterns.filter((p) => output.toLowerCase().includes(p.toLowerCase())).length;
        score += (matched / task.expectedPatterns.length) * 0.3;
    }
    // Penalty: output contains anti-patterns
    if (task.antiPatterns) {
        const antiMatched = task.antiPatterns.filter((p) => output.toLowerCase().includes(p.toLowerCase())).length;
        score -= (antiMatched / task.antiPatterns.length) * 0.3;
    }
    // Bonus: output is not too short (meaningful response)
    if (output.length > 100)
        score += 0.1;
    if (output.length > 500)
        score += 0.1;
    // Bonus: contains code blocks when expected
    if (task.outputLanguage && task.outputLanguage !== 'text') {
        if (output.includes('```'))
            score += 0.1;
    }
    // Clamp between 0 and 1
    return Math.max(0, Math.min(1, score));
}
/**
 * Calculate median of an array of numbers.
 */
function median(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}
// ─── Benchmark Runner ───────────────────────────────────────────────────────
/**
 * Run the benchmark suite against a provider/model.
 */
export async function runBenchmark(provider, providerName, model, options) {
    // Filter tasks
    let tasks = [...BENCHMARK_TASKS];
    if (options?.taskIds && options.taskIds.length > 0) {
        tasks = tasks.filter((t) => options.taskIds.includes(t.id));
    }
    if (options?.timeEstimate) {
        tasks = tasks.filter((t) => t.timeEstimate === options.timeEstimate);
    }
    const runId = `benchmark-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const startedAt = Date.now();
    const results = [];
    let totalCost = 0;
    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        // Check budget
        if (options?.budget && totalCost >= options.budget) {
            logger.info(`Budget of $${options.budget.toFixed(2)} reached. Stopping benchmark.`);
            break;
        }
        options?.onProgress?.(i + 1, tasks.length, task);
        const taskStartTime = Date.now();
        try {
            const output = await provider.generate(task.prompt, {
                model,
                temperature: 0.3, // Low temperature for deterministic results
                maxTokens: task.maxExpectedTokens + 512, // Allow extra tokens
            });
            const latencyMs = Date.now() - taskStartTime;
            const inputTokens = estimateTokens(task.prompt);
            const outputTokens = estimateTokens(output);
            const costUsd = calculateCost(providerName, model, inputTokens, outputTokens);
            totalCost += costUsd;
            const result = {
                taskId: task.id,
                provider: providerName,
                model,
                output,
                success: true,
                latencyMs,
                inputTokens,
                outputTokens,
                costUsd,
                qualityScore: scoreQuality(output, task),
                timestamp: Date.now(),
            };
            results.push(result);
        }
        catch (err) {
            const latencyMs = Date.now() - taskStartTime;
            results.push({
                taskId: task.id,
                provider: providerName,
                model,
                output: '',
                success: false,
                latencyMs,
                inputTokens: estimateTokens(task.prompt),
                outputTokens: 0,
                costUsd: 0,
                qualityScore: 0,
                error: err instanceof Error ? err.message : String(err),
                timestamp: Date.now(),
            });
        }
    }
    const endedAt = Date.now();
    // Compute summary
    const passed = results.filter((r) => r.success);
    const qualityScores = passed.map((r) => r.qualityScore);
    const latencies = results.map((r) => r.latencyMs);
    const run = {
        id: runId,
        provider: providerName,
        model,
        startedAt,
        endedAt,
        results,
        summary: {
            totalTasks: results.length,
            tasksPassed: passed.length,
            tasksFailed: results.length - passed.length,
            avgQualityScore: qualityScores.length > 0
                ? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length
                : 0,
            medianLatencyMs: median(latencies),
            totalCostUsd: results.reduce((sum, r) => sum + r.costUsd, 0),
            totalTokens: results.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0),
        },
    };
    // Persist
    const data = readBenchmarkData();
    data.runs.push(run);
    // Prune old runs
    if (data.runs.length > MAX_BENCHMARK_RUNS) {
        data.runs = data.runs.slice(-MAX_BENCHMARK_RUNS);
    }
    writeBenchmarkData(data);
    return run;
}
// ─── Report Formatting ──────────────────────────────────────────────────────
/**
 * Format a benchmark run as a human-readable report.
 */
export function formatBenchmarkReport(run) {
    const lines = [];
    const s = run.summary;
    const elapsed = ((run.endedAt - run.startedAt) / 1000).toFixed(1);
    lines.push('═'.repeat(60));
    lines.push(`  📊  Benchmark Results: ${run.provider}/${run.model}`);
    lines.push('═'.repeat(60));
    lines.push('');
    lines.push(`  Run ID: ${run.id}`);
    lines.push(`  Duration: ${elapsed}s`);
    lines.push(`  Tasks: ${s.tasksPassed}/${s.totalTasks} passed (${s.tasksFailed} failed)`);
    lines.push(`  Avg quality: ${(s.avgQualityScore * 100).toFixed(1)}%`);
    lines.push(`  Median latency: ${s.medianLatencyMs}ms`);
    lines.push(`  Total cost: $${s.totalCostUsd.toFixed(6)}`);
    lines.push(`  Total tokens: ${s.totalTokens.toLocaleString()}`);
    lines.push('');
    // Results table
    lines.push(`  ${'─'.repeat(58)}`);
    lines.push(`  ${'Task'.padEnd(25)} ${'Status'.padEnd(8)} ${'Quality'.padEnd(9)} ${'Latency'.padEnd(9)} ${'Cost'}`);
    lines.push(`  ${'─'.repeat(58)}`);
    for (const r of run.results) {
        const status = r.success ? '✅' : '❌';
        const quality = r.success ? `${(r.qualityScore * 100).toFixed(0)}%` : 'N/A';
        const latency = `${r.latencyMs}ms`;
        const cost = `$${r.costUsd.toFixed(8)}`;
        lines.push(`  ${r.taskId.padEnd(25)} ${status.padEnd(8)} ${quality.padEnd(9)} ${latency.padEnd(9)} ${cost}`);
    }
    lines.push(`  ${'─'.repeat(58)}`);
    lines.push('');
    return lines.join('\n');
}
/**
 * Format a benchmark run as JSON (for machine consumption).
 */
export function formatBenchmarkJSON(run) {
    return JSON.stringify(run, null, 2);
}
/**
 * Format a benchmark run as Markdown (for documentation).
 */
export function formatBenchmarkMarkdown(run) {
    const s = run.summary;
    const elapsed = ((run.endedAt - run.startedAt) / 1000).toFixed(1);
    const lines = [
        `# Benchmark: ${run.provider}/${run.model}`,
        '',
        `- **Run ID:** ${run.id}`,
        `- **Duration:** ${elapsed}s`,
        `- **Tasks:** ${s.tasksPassed}/${s.totalTasks} passed`,
        `- **Avg Quality Score:** ${(s.avgQualityScore * 100).toFixed(1)}%`,
        `- **Median Latency:** ${s.medianLatencyMs}ms`,
        `- **Total Cost:** $${s.totalCostUsd.toFixed(6)}`,
        `- **Total Tokens:** ${s.totalTokens.toLocaleString()}`,
        '',
        '## Results',
        '',
        '| Task | Status | Quality | Latency | Cost |',
        '|------|--------|---------|---------|------|',
    ];
    for (const r of run.results) {
        const status = r.success ? '✅ Pass' : '❌ Fail';
        const quality = r.success ? `${(r.qualityScore * 100).toFixed(0)}%` : 'N/A';
        lines.push(`| ${r.taskId} | ${status} | ${quality} | ${r.latencyMs}ms | $${r.costUsd.toFixed(8)} |`);
    }
    return lines.join('\n');
}
// ─── Query Functions ────────────────────────────────────────────────────────
/**
 * Get all available benchmark tasks.
 */
export function getBenchmarkTasks() {
    return [...BENCHMARK_TASKS];
}
/**
 * Get a specific benchmark task by ID.
 */
export function getBenchmarkTask(id) {
    return BENCHMARK_TASKS.find((t) => t.id === id);
}
/**
 * Get all past benchmark runs.
 */
export function getBenchmarkRuns() {
    const data = readBenchmarkData();
    return [...data.runs].reverse(); // Most recent first
}
/**
 * Get the most recent benchmark run for a specific provider/model.
 */
export function getLatestBenchmarkRun(provider, model) {
    const data = readBenchmarkData();
    const runs = data.runs
        .filter((r) => r.provider === provider && r.model === model)
        .sort((a, b) => b.startedAt - a.startedAt);
    return runs[0] || null;
}
/**
 * Compare two benchmark runs side by side.
 */
export function compareBenchmarks(runA, runB) {
    const a = runA.summary;
    const b = runB.summary;
    const winner = (aVal, bVal, higherBetter) => {
        if (aVal === bVal)
            return 'tie';
        return (higherBetter ? aVal > bVal : aVal < bVal)
            ? '← ' + runA.model
            : runB.model + ' →';
    };
    const aPassRate = ((a.tasksPassed / a.totalTasks) * 100).toFixed(0);
    const bPassRate = ((b.tasksPassed / b.totalTasks) * 100).toFixed(0);
    const aQual = (a.avgQualityScore * 100).toFixed(1);
    const bQual = (b.avgQualityScore * 100).toFixed(1);
    const aLat = a.medianLatencyMs + 'ms';
    const bLat = b.medianLatencyMs + 'ms';
    const aCost = '$' + a.totalCostUsd.toFixed(6);
    const bCost = '$' + b.totalCostUsd.toFixed(6);
    const lines = [
        '═'.repeat(60),
        '  ⚔️  Benchmark Comparison: ' + runA.model + ' vs ' + runB.model,
        '═'.repeat(60),
        '',
        '  ' + 'Metric'.padEnd(30) + runA.model.padEnd(20) + runB.model.padEnd(20) + 'Winner',
        '  ' + '─'.repeat(70),
        '  ' + 'Pass Rate'.padEnd(30) +
            (aPassRate + '%').padEnd(20) +
            (bPassRate + '%').padEnd(20) +
            winner(a.tasksPassed / a.totalTasks, b.tasksPassed / a.totalTasks, true),
        '  ' + 'Avg Quality'.padEnd(30) +
            (aQual + '%').padEnd(20) +
            (bQual + '%').padEnd(20) +
            winner(a.avgQualityScore, b.avgQualityScore, true),
        '  ' + 'Median Latency'.padEnd(30) +
            aLat.padEnd(20) +
            bLat.padEnd(20) +
            winner(a.medianLatencyMs, b.medianLatencyMs, false),
        '  ' + 'Total Cost'.padEnd(30) +
            aCost.padEnd(20) +
            bCost.padEnd(20) +
            winner(a.totalCostUsd, b.totalCostUsd, false),
        '',
    ];
    return lines.join('\n');
}
/**
 * Clear all benchmark data.
 */
export function clearBenchmarks() {
    writeBenchmarkData({ runs: [], version: CURRENT_VERSION });
}
//# sourceMappingURL=benchmark.js.map