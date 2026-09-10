"use strict";
/**
 * Authentication configuration for JWT signing.
 *
 * @module config/auth
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.authConfig = void 0;
/**
 * Default authentication configuration.
 *
 * The secret is sourced from the `JWT_SECRET` environment variable
 * and falls back to a hard‑coded value for development purposes.
 */
exports.authConfig = {
    secret: process.env.JWT_SECRET ?? 'supersecret',
    expiresIn: '1h',
};
