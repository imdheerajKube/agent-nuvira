/**
 * JwtOidcAdapter + token-verified federation handshake (P6 M6.4 minimal
 * gateway slice).
 *
 * Unit-tests the dependency-free RS256 JWT verifier with a locally generated
 * RSA keypair, then exercises the REAL federation server with
 * `authMode: 'oidc'` over HTTP: a valid bearer token earns a session, a
 * missing/invalid token is rejected with 401.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync, createSign } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { JwtOidcAdapter } from '../../src/federation/oidc-adapter.js';
import { createFederationServer } from '../../src/federation/server.js';

// ─── JWT minting helpers (test-only; mirrors a real OIDC provider signing) ──

function b64url(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signJwt(payload: Record<string, unknown>, privateKeyPem: string, alg = 'RS256'): string {
  const headerB64 = b64url(Buffer.from(JSON.stringify({ alg, typ: 'JWT' })));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
  const signer = createSign('RSA-SHA256');
  signer.update(`${headerB64}.${payloadB64}`);
  signer.end();
  return `${headerB64}.${payloadB64}.${b64url(signer.sign(privateKeyPem))}`;
}

function futureExp(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}

// ─── JwtOidcAdapter unit tests ──────────────────────────────────────────────

describe('JwtOidcAdapter (P6 M6.4)', () => {
  let keypair: { publicKey: string; privateKey: string };

  beforeAll(() => {
    keypair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  });

  it('accepts a valid RS256 JWT and returns the subject', async () => {
    const adapter = new JwtOidcAdapter({ publicKeyPem: keypair.publicKey });
    const token = signJwt({ sub: 'svc-1', email: 'svc@acme.test', exp: futureExp() }, keypair.privateKey);
    const identity = await adapter.verify(token);
    expect(identity?.sub).toBe('svc-1');
    expect(identity?.email).toBe('svc@acme.test');
  });

  it('rejects a tampered signature', async () => {
    const adapter = new JwtOidcAdapter({ publicKeyPem: keypair.publicKey });
    const token = signJwt({ sub: 'svc-1', exp: futureExp() }, keypair.privateKey);
    const [header, payload] = token.split('.');
    const tampered = `${header}.${payload}.${b64url(Buffer.from('deadbeef'))}`;
    expect(await adapter.verify(tampered)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const adapter = new JwtOidcAdapter({ publicKeyPem: keypair.publicKey });
    const token = signJwt({ sub: 'svc-1', exp: Math.floor(Date.now() / 1000) - 60 }, keypair.privateKey);
    expect(await adapter.verify(token)).toBeNull();
  });

  it('rejects a non-RS256 token (alg confusion)', async () => {
    const adapter = new JwtOidcAdapter({ publicKeyPem: keypair.publicKey });
    const token = signJwt({ sub: 'svc-1', exp: futureExp() }, keypair.privateKey, 'HS256');
    expect(await adapter.verify(token)).toBeNull();
  });

  it('enforces a configured issuer and audience', async () => {
    const adapter = new JwtOidcAdapter({
      publicKeyPem: keypair.publicKey,
      issuer: 'https://id.acme.test',
      audience: 'buff-gateway',
    });
    const good = signJwt({ sub: 'svc-1', iss: 'https://id.acme.test', aud: 'buff-gateway', exp: futureExp() }, keypair.privateKey);
    expect((await adapter.verify(good))?.sub).toBe('svc-1');

    const wrongIssuer = signJwt({ sub: 'svc-1', iss: 'https://evil.test', aud: 'buff-gateway', exp: futureExp() }, keypair.privateKey);
    expect(await adapter.verify(wrongIssuer)).toBeNull();

    const wrongAudience = signJwt({ sub: 'svc-1', iss: 'https://id.acme.test', aud: 'other', exp: futureExp() }, keypair.privateKey);
    expect(await adapter.verify(wrongAudience)).toBeNull();
  });

  it('returns null for malformed tokens and never throws', async () => {
    const adapter = new JwtOidcAdapter({ publicKeyPem: keypair.publicKey });
    expect(await adapter.verify('not-a-jwt')).toBeNull();
    expect(await adapter.verify('a.b')).toBeNull();
    expect(await adapter.verify('')).toBeNull();
  });
});

// ─── Federation server: OIDC token-verified handshake ───────────────────────

describe('Federation server — OIDC token-verified handshake (P6 M6.4)', () => {
  let keypair: { publicKey: string; privateKey: string };
  let server: ReturnType<typeof createFederationServer>;
  let baseUrl: string;

  beforeAll(async () => {
    keypair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    // authMode 'oidc' → no pre-shared secret required; the adapter verifies tokens.
    server = createFederationServer(
      { authMode: 'oidc', host: '127.0.0.1', port: 0, secret: '', nodeId: 'test-node', capabilities: ['writer'] },
      { oidcAdapter: new JwtOidcAdapter({ publicKeyPem: keypair.publicKey }) },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function handshake(options: { token?: string } = {}): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const res = await fetch(`${baseUrl}/federation/handshake`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ clientId: 'my-client', capabilities: ['writer'] }),
    });
    return { status: res.status, body: await res.json() };
  }

  it('grants a session to a verified bearer token', async () => {
    const token = signJwt({ sub: 'svc-1', exp: futureExp() }, keypair.privateKey);
    const { status, body } = await handshake({ token });
    expect(status).toBe(200);
    expect(body.type).toBe('response');
    expect(body.payload.sessionToken).toBeTruthy();
    expect(body.payload.serverId).toBe('test-node');
  });

  it('rejects a handshake with NO token (401)', async () => {
    const { status, body } = await handshake();
    expect(status).toBe(401);
    expect(body.type).toBe('error');
  });

  it('rejects a handshake with an INVALID token (401)', async () => {
    const { status } = await handshake({ token: 'garbage.token.value' });
    expect(status).toBe(401);
  });

  it('rejects a token signed by a different key (401)', async () => {
    const other = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const token = signJwt({ sub: 'evil', exp: futureExp() }, other.privateKey);
    const { status } = await handshake({ token });
    expect(status).toBe(401);
  });
});

describe('Federation server — secret mode still requires a secret (regression)', () => {
  it('createFederationServer throws without a secret in default secret mode', () => {
    expect(() => createFederationServer({ host: '127.0.0.1', port: 0, secret: '' })).toThrow(/secret/i);
  });
});
