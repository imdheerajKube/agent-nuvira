"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.maskSenderId = void 0;
/**
 * mask.ts — privacy masking for the dashboard UI.
 *
 * Re-exports the shared maskSenderId from src/utils so the frontend and the
 * CLI mask sender ids identically.
 */
var mask_js_1 = require("../../utils/mask.js");
Object.defineProperty(exports, "maskSenderId", { enumerable: true, get: function () { return mask_js_1.maskSenderId; } });
