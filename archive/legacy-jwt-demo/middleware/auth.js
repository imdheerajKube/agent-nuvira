"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureAuthenticated = void 0;
const passport_1 = __importDefault(require("passport"));
/**
 * Middleware to ensure the request is authenticated.
 * It uses Passport's `authenticate` strategy (e.g., JWT) to verify the token.
 *
 * If authentication fails, a 401 Unauthorized response is sent.
 * If successful, `req.user` will be populated with the authenticated user.
 */
const ensureAuthenticated = (req, res, next) => {
    // The 'jwt' strategy should be configured in `src/passport.ts`.
    passport_1.default.authenticate('jwt', { session: false }, (err, user, info) => {
        if (err) {
            console.error('Authentication error:', err);
            return next(err);
        }
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        // Attach the authenticated user to the request object for downstream handlers.
        req.user = user;
        return next();
    })(req, res, next);
};
exports.ensureAuthenticated = ensureAuthenticated;
