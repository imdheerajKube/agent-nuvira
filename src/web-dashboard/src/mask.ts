/**
 * mask.ts — privacy masking for the dashboard UI.
 *
 * Re-exports the shared maskSenderId from src/utils so the frontend and the
 * CLI mask sender ids identically.
 */
export { maskSenderId } from '../../utils/mask.js';
