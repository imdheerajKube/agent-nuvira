import express from 'express';
import jwt from 'jsonwebtoken';
// Define the secret key for JWT
const secretKey = 'my-secret-key';
// Create an Express app
const app = express();
// Middleware to parse JSON requests
app.use(express.json());
// In-memory user database (replace with a real database in production)
const users = {
    user1: 'password1',
    user2: 'password2',
};
// Function to generate a JWT token
function generateToken(payload) {
    return jwt.sign(payload, secretKey, { expiresIn: '1h' });
}
// Function to verify a JWT token
function verifyToken(token) {
    try {
        return jwt.verify(token, secretKey);
    }
    catch (error) {
        return null;
    }
}
// Login endpoint
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).send({ error: 'Username and password are required' });
    }
    if (!users[username] || users[username] !== password) {
        return res.status(401).send({ error: 'Invalid username or password' });
    }
    const token = generateToken({ username });
    res.send({ token });
});
// Auth middleware
function authMiddleware(req, res, next) {
    const token = req.header('Authorization');
    if (!token) {
        return res.status(401).send({ error: 'Token is required' });
    }
    const payload = verifyToken(token);
    if (!payload) {
        return res.status(401).send({ error: 'Invalid token' });
    }
    req.username = payload.username;
    next();
}
// Protected route
app.get('/protected', authMiddleware, (req, res) => {
    res.send({ message: `Hello, ${req.username}!` });
});
// Start the server
const port = 3000;
app.listen(port, () => {
    console.log(`Server started on port ${port}`);
});
//# sourceMappingURL=auth-api.js.map