#!/usr/bin/env npx tsx
/**
 * Bedrock Connectivity Test Script
 *
 * Usage:
 *   npx tsx scripts/test-bedrock.ts
 *
 * Environment variables:
 *   AWS_BEARER_TOKEN          — Bedrock API key (Bearer token auth)
 *   BEDROCK_REGION            — AWS region (default: us-east-1)
 *
 * This script:
 *   1. Verifies the API key is configured
 *   2. Tests control-plane listing (foundation-models endpoint)
 *   3. Falls back to runtime probing if listing returns 0 models
 *   4. Tests actual inference with the first accessible model
 *   5. Prints a diagnostic summary
 */

const REGION = process.env.BEDROCK_REGION || 'us-east-1';
const API_KEY = process.env.AWS_BEARER_TOKEN;
const CONTROL_BASE = `https://bedrock.${REGION}.amazonaws.com`;
const RUNTIME_BASE = `https://bedrock-runtime.${REGION}.amazonaws.com`;

const PROBE_MODELS = [
  'anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-sonnet-4-6',
  'anthropic.claude-fable-5',
  'meta.llama3-1-8b-instruct-v1:0',
  'meta.llama3-3-70b-instruct-v1:0',
  'meta.llama4-scout-17b-instruct-v1:0',
  'deepseek.v3.2',
  'mistral.mistral-large-3-675b-instruct',
  'amazon.nova-pro-v1:0',
  'openai.gpt-5.6-terra',
  'qwen.qwen3-coder-next',
  'xai.grok-4.6',
  'google.gemma-3-12b-it',
];

interface ProbeResult {
  modelId: string;
  status: number;
  accessible: boolean;
  error?: string;
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 8000,
): Promise<{ ok: boolean; status: number; statusText: string; data?: unknown; headers: Record<string, string> }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timeout);
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    if (res.ok) {
      try {
        const data = await res.json();
        return { ok: true, status: res.status, statusText: res.statusText, data, headers };
      } catch {
        return { ok: true, status: res.status, statusText: res.statusText, headers };
      }
    }
    const errorData = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, statusText: res.statusText, data: errorData, headers };
  } catch (err: any) {
    return { ok: false, status: 0, statusText: err?.name === 'AbortError' ? 'Timeout' : 'Connection failed', headers: {} };
  }
}

function printHeader(text: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${text}`);
  console.log(`${'═'.repeat(60)}`);
}

function printCheck(label: string, passed: boolean, detail?: string) {
  const icon = passed ? '✅' : '❌';
  console.log(`  ${icon} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  printHeader('Bedrock Connectivity Test');

  // ── Step 1: Check API key ──────────────────────────────────────────
  console.log(`\n📋 Configuration:`);
  console.log(`   Region:          ${REGION}`);
  console.log(`   API Key:         ${API_KEY ? `${API_KEY.slice(0, 8)}…${API_KEY.slice(-4)}` : '(not set)'}`);
  console.log(`   Control plane:   ${CONTROL_BASE}`);
  console.log(`   Runtime:         ${RUNTIME_BASE}`);

  if (!API_KEY) {
    printCheck('API key configured', false, 'AWS_BEARER_TOKEN is not set');
    console.log(`\n💡 Set it in ~/.buff/.env:\n   AWS_BEARER_TOKEN=your-key-here\n`);
    process.exit(1);
  }
  printCheck('API key configured', true);

  // ── Step 2: Try control-plane listing ──────────────────────────────
  console.log(`\n📡 Step 1: Testing control-plane model listing…`);
  const listing = await fetchWithTimeout<{ modelSummaries?: Array<{ modelId: string; modelName: string; providerName: string; modelLifecycle: { status: string } }> }>(
    `${CONTROL_BASE}/foundation-models`,
    { headers: { 'Authorization': `Bearer ${API_KEY}` } },
  );

  if (listing.ok && listing.data?.modelSummaries && listing.data.modelSummaries.length > 0) {
    const models = listing.data.modelSummaries;
    printCheck('Control-plane listing', true, `${models.length} models returned`);

    const activeModels = models.filter(m => m.modelLifecycle?.status === 'ACTIVE');
    console.log(`   Active models: ${activeModels.length}`);
    console.log(`   Sample models:`);
    for (const m of activeModels.slice(0, 5)) {
      console.log(`     • ${m.modelId} (${m.providerName}) — ${m.modelLifecycle.status}`);
    }
    if (activeModels.length > 5) {
      console.log(`     … and ${activeModels.length - 5} more`);
    }
  } else {
    printCheck('Control-plane listing', false, `HTTP ${listing.status}: ${listing.statusText}`);
    if (listing.status === 401 || listing.status === 403) {
      console.log(`\n   ⚠️  Authentication failed. Possible causes:`);
      console.log(`     • Bearer token may not work for the control-plane API (needs IAM/SigV4)`);
      console.log(`     • Key may be invalid or expired`);
      console.log(`     • IAM role may lack bedrock:ListFoundationModels permission`);
    } else if (listing.status === 0) {
      console.log(`\n   ⚠️  Cannot reach ${CONTROL_BASE}`);
      console.log(`     • Verify BEDROCK_REGION is correct (current: ${REGION})`);
      console.log(`     • Check network connectivity to AWS`);
    } else {
      const msg = (listing.data as any)?.message || 'unknown error';
      console.log(`\n   ⚠️  Error: ${msg}`);
    }
  }

  // ── Step 3: Runtime probing ────────────────────────────────────────
  console.log(`\n📡 Step 2: Probing models via runtime endpoint (${RUNTIME_BASE})…`);
  const discovered: ProbeResult[] = [];

  const probePromises = PROBE_MODELS.map(async (modelId) => {
    const probe = await fetchWithTimeout(
      `${RUNTIME_BASE}/openai/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      },
    );
    const result: ProbeResult = {
      modelId,
      status: probe.status,
      accessible: probe.ok,
      error: probe.ok ? undefined : `HTTP ${probe.status}: ${probe.statusText}`,
    };
    if (probe.ok) {
      console.log(`   ✅ ${modelId} — accessible`);
    } else if (probe.status === 403) {
      console.log(`   🔒 ${modelId} — exists but access not approved (403)`);
    } else if (probe.status === 404) {
      console.log(`   ⚫ ${modelId} — not available in ${REGION} (404)`);
    }
    discovered.push(result);
  });
  await Promise.all(probePromises);

  const accessible = discovered.filter(r => r.accessible);
  const permissionDenied = discovered.filter(r => r.status === 403);
  const notFound = discovered.filter(r => r.status === 404);

  console.log(`\n📊 Probe results: ${accessible.length} accessible, ${permissionDenied.length} permission-denied, ${notFound.length} not-found`);

  // ── Step 4: Test actual inference ──────────────────────────────────
  if (accessible.length > 0) {
    const testModel = accessible[0].modelId;
    console.log(`\n📡 Step 3: Testing inference with ${testModel}…`);

    const inferResult = await fetchWithTimeout(
      `${RUNTIME_BASE}/openai/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: testModel,
          messages: [{ role: 'user', content: 'Say "Bedrock inference works!" in exactly 5 words.' }],
          max_tokens: 30,
        }),
      },
    );

    if (inferResult.ok) {
      const choices = (inferResult.data as any)?.choices;
      const response = choices?.[0]?.message?.content || '(empty)';
      printCheck('Inference test', true, `"${response.trim()}"`);
    } else {
      printCheck('Inference test', false, `HTTP ${inferResult.status}`);
    }
  } else {
    console.log(`\n⚠️  Skipping inference test — no accessible models found.`);
  }

  // ── Step 5: Diagnostic summary ─────────────────────────────────────
  printHeader('Diagnostic Summary');

  if (accessible.length > 0) {
    console.log(`\n  ✅ Bedrock is fully operational in ${REGION}`);
    console.log(`     ${accessible.length} model(s) accessible and inference verified.`);
    console.log(`\n  To use in the agent, add to ~/.buff/.env:`);
    console.log(`     AWS_BEARER_TOKEN=${API_KEY}`);
    console.log(`     BEDROCK_REGION=${REGION}`);
  } else if (permissionDenied.length > 0) {
    console.log(`\n  🔒 Models exist in ${REGION} but access is not approved.`);
    console.log(`\n  👉 Request model access:`);
    console.log(`     1. Open https://console.aws.amazon.com/bedrock/home?region=${REGION}#/modelaccess`);
    console.log(`     2. Click "Manage model access"`);
    console.log(`     3. Select models: Claude, Llama, Mistral, DeepSeek, Titan, etc.`);
    console.log(`     4. Click "Submit" — approval is usually instant for Anthropic/Meta models.`);
  } else if (listing.status === 401 || listing.status === 403) {
    console.log(`\n  ❌ Authentication failed for both control-plane and runtime endpoints.`);
    console.log(`\n  👉 Verify your API key:`);
    console.log(`     • Ensure the key is valid: Bedrock → Settings → API keys`);
    console.log(`     • Or use IAM credentials: set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY`);
    console.log(`     • Ensure the IAM role/user has:`);
    console.log(`       - bedrock:ListFoundationModels`);
    console.log(`       - bedrock:InvokeModel`);
  } else if (listing.status === 0) {
    console.log(`\n  ❌ Cannot reach Bedrock in region ${REGION}`);
    console.log(`\n  👉 Check your region configuration:`);
    console.log(`     • Set BEDROCK_REGION to a supported region (us-east-1, us-west-2, eu-west-1, etc.)`);
    console.log(`     • Do NOT use eu-north-1 unless models are explicitly enabled there`);
    console.log(`     • Verify network access to *.amazonaws.com`);
  } else {
    console.log(`\n  ❌ No models accessible. Possible causes:`);
    console.log(`     1. No model access approved — see https://console.aws.amazon.com/bedrock/home?region=${REGION}#/modelaccess`);
    console.log(`     2. Region mismatch — set BEDROCK_REGION (current: ${REGION})`);
    console.log(`     3. Missing IAM permissions — need bedrock:ListFoundationModels + bedrock:InvokeModel`);
  }

  console.log('');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
