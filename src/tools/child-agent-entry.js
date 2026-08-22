/**
 * Child Agent Entry Point — Loads the built worker.
 *
 * This file is forked by subagent-spawner.ts.
 * It imports the compiled child-agent-worker.js from dist/.
 */

const path = require('path');
const { parentPort } = require('worker_threads');

// The actual worker is compiled to dist/tools/child-agent-worker.js
const workerPath = path.join(__dirname, '..', '..', 'dist', 'tools', 'child-agent-worker.js');

// Import the worker
require(workerPath);
