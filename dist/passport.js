"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const passport_1 = __importDefault(require("passport"));
const passport_jwt_1 = require("passport-jwt");
const userService_1 = require("./services/userService"); // Adjust the import path as needed
// JWT options – these should be configured via environment variables.
const jwtOptions = {
    jwtFromRequest: passport_jwt_1.ExtractJwt.fromAuthHeaderAsBearerToken(),
    secretOrKey: process.env.JWT_SECRET || 'default_secret', // Replace with a strong secret in production
    passReqToCallback: true,
};
/**
 * Verify callback for the JWT strategy.
 * It receives the JWT payload and should return the corresponding user object.
 */
const verifyJwt = async (req, payload, done) => {
    try {
        // Assuming the payload contains a `sub` (subject) field with the user ID.
        const user = await (0, userService_1.getUserById)(payload.sub);
        if (!user) {
            return done(null, false);
        }
        return done(null, user);
    }
    catch (error) {
        return done(error, false);
    }
};
// Register the JWT strategy with Passport.
passport_1.default.use(new passport_jwt_1.Strategy(jwtOptions, verifyJwt));
exports.default = passport_1.default;
