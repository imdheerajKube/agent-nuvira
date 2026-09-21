"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const passport_1 = __importDefault(require("./passport"));
const user_1 = __importDefault(require("./routes/user"));
const auth_1 = __importDefault(require("./routes/auth"));
// Create Express application
const app = (0, express_1.default)();
// Middleware to parse JSON bodies
app.use(express_1.default.json());
// Initialize Passport.js
app.use(passport_1.default.initialize());
// If you are using persistent login sessions, uncomment the following line:
// app.use(passport.session());
// Register routers
app.use('/api/auth', auth_1.default); // Public authentication routes
app.use('/api/user', user_1.default); // Protected user routes
// Global error handling middleware
app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
});
exports.default = app;
