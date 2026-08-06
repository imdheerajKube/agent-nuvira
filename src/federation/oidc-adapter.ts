/**
 * JwtOidcAdapter — P6 M6.4 minimal gateway slice.
 *
 * The first REAL implementation of the enterprise `OidcAdapter` seam
 * (src/enterprise/rbac.ts): it verifies a federated connection's bearer token
 * as an RS256-signed JWT (OIDC-style ID token) against a configured public
 * key, using ONLY Node built-ins (`node:crypto`) — no external JWT library.
 *
 * The federation server (src/federation/server.ts) wires this adapter in when
 * `FederationConfig.authMode === 'oidc'`: every `/federation/handshake` must
 * then present `Authorization: Bearer <token>`; a token that fails signature
 * verification, is expired, or misses a configured issuer/audience is
 * rejected with 401. This turns the existing federation surface into a
 * token-verified gateway without touching the enforcement paths.
 *
 * `verify()` never throws — an unparseable/unsigned/invalid token resolves to
 * `null` (the caller decides the HTTP status).
 */

import { createVerify } from 'node:crypto';
import type { OidcAdapter } from '../enterprise/rbac.js';

interface JwtHeader {
  alg?: string;
  typ?: string;
}

interface JwtPayload {
  sub?: string;
  email?: string;
  exp?: number;
  iss?: string;
  aud?: string;
}

/** base64url → UTF-8 string (Node 16+ supports 'base64url' natively). */
function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf-8');
}

/**
 * Verify a JWT's RS256 signature over `header.payload` with a PEM public key.
 * Pure + dependency-free — unit-tested with a locally generated keypair.
 */
function verifyRs256(publicKeyPem: string, headerB64: string, payloadB64: string, signatureB64: string): boolean {
  try {
    const signature = Buffer.from(signatureB64, 'base64url');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    return verifier.verify(publicKeyPem, signature);
  } catch {
    return false;
  }
}

export class JwtOidcAdapter implements OidcAdapter {
  private publicKeyPem: string;
  private expectedIssuer?: string;
  private expectedAudience?: string;

  constructor(options: { publicKeyPem: string; issuer?: string; audience?: string }) {
    if (!options.publicKeyPem || !options.publicKeyPem.trim()) {
      throw new Error('JwtOidcAdapter requires a publicKeyPem');
    }
    this.publicKeyPem = options.publicKeyPem;
    this.expectedIssuer = options.issuer;
    this.expectedAudience = options.audience;
  }

  /**
   * Verify a bearer token into an identity. Returns null when the token is
   * missing/malformed, not RS256, signature-invalid, expired, or outside the
   * configured issuer/audience.
   */
  async verify(token: string): Promise<{ sub: string; email?: string; groups?: string[] } | null> {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [headerB64, payloadB64, signatureB64] = parts;

      const header = JSON.parse(base64UrlDecode(headerB64)) as JwtHeader;
      if (header.alg !== 'RS256') return null;

      const payload = JSON.parse(base64UrlDecode(payloadB64)) as JwtPayload;
      if (!payload.sub) return null;
      // Expiry is in seconds since epoch.
      if (typeof payload.exp === 'number' && Date.now() >= payload.exp * 1000) return null;
      if (this.expectedIssuer && payload.iss !== this.expectedIssuer) return null;
      if (this.expectedAudience && payload.aud !== this.expectedAudience) return null;
      if (!verifyRs256(this.publicKeyPem, headerB64, payloadB64, signatureB64)) return null;

      return { sub: payload.sub, email: payload.email };
    } catch {
      return null;
    }
  }
}
