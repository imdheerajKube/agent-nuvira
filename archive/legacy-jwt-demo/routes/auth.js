import express from 'express';
import jwt from 'jsonwebtoken';
// Hard‑coded user credentials (for demo / testing purposes only)
const HARD_CODED_USER = {
    username: 'admin',
    password: 'password123',
};
// Retrieve JWT secret from environment variables.
// Throw early if not configured to avoid runtime errors.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    throw new Error('Environment variable JWT_SECRET must be set for authentication.');
}
// Token expiration time (e.g., 1 hour)
const TOKEN_EXPIRES_IN = '1h';
const router = express.Router();
/**
 * POST /login
 * Accepts a JSON body with `username` and `password`.
 * If the credentials match the hard‑coded user, a JWT is issued and returned.
 * Otherwise, a 401 Unauthorized response is sent.
 */
router.post('/login', (req, res, next) => {
    try {
        const { username, password } = req.body;
        // Basic validation of request payload
        if (typeof username !== 'string' || typeof password !== 'string') {
            return res.status(400).json({ error: 'Invalid request payload.' });
        }
        // Verify credentials against the hard‑coded user
        if (username !== HARD_CODED_USER.username || password !== HARD_CODED_USER.password) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }
        // Create JWT payload – you can extend this with more claims as needed
        const payload = { username };
        // Sign the token
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRES_IN });
        // Respond with the token
        return res.status(200).json({ token });
    }
    catch (err) {
        // Forward unexpected errors to Express error handler
        return next(err);
    }
});
export default router;
//# sourceMappingURL=auth.js.map