"use strict";
/**
 * JWT Configuration
 *
 * This module centralises all JWT related settings used across the
 * application.  The values are sourced from environment variables
 * with sensible defaults for local development.  The configuration
 * is exported as a read‑only object to prevent accidental mutation
 * at runtime.
 *
 * @module config/jwt
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.jwtConfig = void 0;
/**
 * Default JWT configuration.  In production the `JWT_SECRET`
 * environment variable must be set; otherwise a fallback is used
 * which is suitable only for local testing.
 */
exports.jwtConfig = {
    secret: process.env.JWT_SECRET ?? 'dev-secret-key',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '1h',
    algorithm: process.env.JWT_ALGORITHM ?? 'HS256',
};
