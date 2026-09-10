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
import type { OidcAdapter } from '../enterprise/rbac.js';
export declare class JwtOidcAdapter implements OidcAdapter {
    private publicKeyPem;
    private expectedIssuer?;
    private expectedAudience?;
    constructor(options: {
        publicKeyPem: string;
        issuer?: string;
        audience?: string;
    });
    /**
     * Verify a bearer token into an identity. Returns null when the token is
     * missing/malformed, not RS256, signature-invalid, expired, or outside the
     * configured issuer/audience.
     */
    verify(token: string): Promise<{
        sub: string;
        email?: string;
        groups?: string[];
    } | null>;
}
//# sourceMappingURL=oidc-adapter.d.ts.map