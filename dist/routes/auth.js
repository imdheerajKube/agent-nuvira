"use strict";
/**
 * Authentication Routes
 *
 * Exposes endpoints for user login and token issuance.  This
 * example uses a hard‑coded user for demonstration purposes.
 *
 * @module routes/auth
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const jwt_1 = require("../config/jwt");
const router = (0, express_1.Router)();
/**
 * POST /auth/login
 *
 * Accepts a JSON body with `username` and `password`.  In a real
 * application this would validate against a database.  Here we
 * simply issue a token for a single demo user.
 */
router.post('/login', (req, res) => {
    const { username, password } = req.body;
    // Basic validation
    if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Username and password required' });
    }
    // Demo credentials check
    if (username !== 'admin' || password !== 'password') {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    const payload = { sub: username, role: 'admin' };
    const token = jsonwebtoken_1.default.sign(payload, jwt_1.jwtConfig.secret, {
        expiresIn: jwt_1.jwtConfig.expiresIn,
        algorithm: jwt_1.jwtConfig.algorithm,
    });
    res.json({ token });
});
exports.default = router;
