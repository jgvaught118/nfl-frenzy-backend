// middleware/authMiddleware.js
const jwt = require('jsonwebtoken');

module.exports = function authenticateToken(req, res, next) {
  try {
    let token = null;

    // Prefer standard Authorization: Bearer <token>
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (authHeader) {
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
      } else if (authHeader.trim().split('.').length === 3) {
        // Some clients might send the raw token in Authorization without "Bearer "
        token = authHeader.trim();
      }
    }

    // Fallback: x-auth-token (legacy header some codebases use)
    if (!token && req.headers['x-auth-token']) {
      token = req.headers['x-auth-token'];
    }

    if (!token) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // We sign tokens as { user_id: <number> }
    req.user = decoded; // e.g., { user_id: 1, iat: ..., exp: ... }
    return next();
  } catch (err) {
    console.error('Auth error:', err.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
};
