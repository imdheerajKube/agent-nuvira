"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
/**
 * GET /api/user/profile
 * Returns the profile of the currently authenticated user.
 * This route is protected by the `ensureAuthenticated` middleware.
 */
router.get('/profile', auth_1.ensureAuthenticated, async (req, res, _next) => {
    // Assuming the user information is attached to req.user by Passport
    const user = req.user;
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    res.json({
        id: user.id,
        username: user.username,
        email: user.email,
    });
});
/**
 * GET /api/user/settings
 * Example of another protected endpoint.
 */
router.get('/settings', auth_1.ensureAuthenticated, async (_req, res, _next) => {
    // Placeholder response – replace with real settings logic
    res.json({ theme: 'dark', notificationsEnabled: true });
});
exports.default = router;
