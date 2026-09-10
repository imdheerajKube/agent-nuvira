"use strict";
/**
 * Secret Key Configuration
 *
 * This module exposes the raw secret key used for signing JWTs.
 * It is intentionally kept separate from the full JWT configuration
 * so that other parts of the application can import only what they
 * need without pulling in the entire config object.
 *
 * @module config/keys
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.JWT_SECRET = void 0;
exports.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-key';
