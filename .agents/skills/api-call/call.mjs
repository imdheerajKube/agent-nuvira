#!/usr/bin/env node
/**
 * API Call Skill — Demonstrates Node.js skill execution.
 * 
 * This script is executed by the skill-executor.ts module when the agent
 * calls: skill tool → execute: { skill: "api-call", args: { endpoint: "/users" } }
 * 
 * The executor:
 * 1. Detects runtime: node (from shebang or frontmatter)
 * 2. Parses required_environment_variables: [API_BASE_URL, API_KEY]
 * 3. Injects API_BASE_URL and API_KEY from process.env (if registered)
 * 4. Spawns: node /tmp/skill-exec/abc123/call.mjs
 * 5. Captures stdout/stderr/exit code
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';

// Parse command-line arguments
function parseArgs(args) {
  const parsed = {
    endpoint: null,
    method: 'GET',
    data: null,
    headers: {}
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--endpoint':
      case '-e':
        parsed.endpoint = args[++i];
        break;
      case '--method':
      case '-m':
        parsed.method = args[++i].toUpperCase();
        break;
      case '--data':
      case '-d':
        parsed.data = args[++i];
        break;
      case '--headers':
      case '-H':
        try {
          parsed.headers = JSON.parse(args[++i]);
        } catch (e) {
          console.error(`Error: Invalid JSON for headers: ${args[i]}`);
          process.exit(1);
        }
        break;
    }
  }

  return parsed;
}

// Make HTTP request with retry logic
async function makeRequest(options, retries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await executeRequest(options);
      return response;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      
      console.error(`Attempt ${attempt} failed: ${error.message}. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff
    }
  }
}

function executeRequest(options) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(options.url);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    };

    const req = client.request(reqOptions, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const jsonData = JSON.parse(data);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: jsonData
          });
        } catch {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: data
          });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

// Main execution
async function main() {
  const args = parseArgs(process.argv.slice(2));
  
  if (!args.endpoint) {
    console.error('Error: --endpoint is required');
    console.error('Usage: node call.mjs --endpoint /users --method GET');
    process.exit(1);
  }

  const baseUrl = process.env.API_BASE_URL;
  if (!baseUrl) {
    console.error('Error: API_BASE_URL environment variable is not set');
    console.error('Set it with: export API_BASE_URL=https://api.example.com');
    process.exit(1);
  }

  const apiKey = process.env.API_KEY;
  if (apiKey) {
    args.headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const fullUrl = baseUrl + args.endpoint;
  console.log(`Making ${args.method} request to: ${fullUrl}`);
  
  if (args.data) {
    console.log(`Request body: ${args.data}`);
  }

  try {
    const response = await makeRequest({
      url: fullUrl,
      method: args.method,
      body: args.data,
      headers: args.headers
    });

    console.log(`\n✅ Request successful!`);
    console.log(`📊 Status: ${response.status}`);
    console.log(`\nResponse:`);
    console.log(JSON.stringify(response.data, null, 2));
    
    // Return structured result
    const result = {
      success: true,
      status: response.status,
      data: response.data
    };
    console.log(`\n${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    console.error(`\n❌ Request failed: ${error.message}`);
    process.exit(1);
  }
}

main();
